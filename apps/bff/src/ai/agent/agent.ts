/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The agent runner. Wires the three skills' tools onto a LangGraph
 * `createReactAgent`, streams its events, and maps them to our SSE callbacks:
 * chat-model token deltas → `onToken`, tool start/end → `ctx.emitTool` (the
 * single uniform emitter). Figures are pushed by the render tools themselves
 * via `ctx.emitFigure`, interleaved with tokens in the model's own order.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AiRequestContext } from '../context.js';
import { contextTools } from '../skill/context/tools.js';
import { metricCatalogTools } from '../skill/metric-catalog/tools.js';
import { telemetryTools } from '../skill/telemetry/tools.js';
import { visualizationTools } from '../skill/visualization/tools.js';
import { kubernetesTools } from '../skill/kubernetes/tools.js';
import { rcaTools } from '../skill/rca/tools.js';
import { triggerTools } from '../skill/triggers/tools.js';

export function buildAiTools(ctx: AiRequestContext): StructuredToolInterface[] {
  return [
    ...rcaTools(),
    ...contextTools(ctx),
    ...telemetryTools(ctx),
    ...metricCatalogTools(ctx),
    ...kubernetesTools(ctx),
    ...visualizationTools(ctx),
    ...triggerTools(ctx),
  ];
}

/**
 * Strip DeepSeek-on-Bedrock's tool-call scaffolding tokens (`<｜DSML｜…`,
 * `<｜tool▁…｜>`) that leak into the streamed TEXT content. Buffers a trailing
 * `<｜…` in case a sentinel is split across chunks; a no-op for the
 * openai-compatible path (whose wire keeps tool_calls out of `content`).
 */
export function makeTokenCleaner(): { push(t: string): string; flush(): string } {
  let buf = '';
  const strip = (s: string): string =>
    s.replace(/<｜DSML｜function_calls/g, '').replace(/<｜[^\n]*?｜>/g, '');
  return {
    push(text: string): string {
      buf = strip(buf + text);
      const i = buf.lastIndexOf('<｜');
      if (i >= 0) {
        // Hold a possibly-forming sentinel — but not indefinitely: once it has
        // grown past the longest sentinel we strip, it is real text, so release
        // it rather than stalling the stream on a stray `<｜`.
        if (buf.length - i <= 40) {
          const out = buf.slice(0, i);
          buf = buf.slice(i);
          return out;
        }
        const out = buf;
        buf = '';
        return out;
      }
      if (buf.endsWith('<')) {
        const out = buf.slice(0, -1);
        buf = '<';
        return out;
      }
      const out = buf;
      buf = '';
      return out;
    },
    flush(): string {
      const out = strip(buf);
      buf = '';
      return out;
    },
  };
}

/** Pull the string result out of an on_tool_end event's output (a raw string, a
 *  ToolMessage-like `{content}`, or neither). Used to spot the verb-gate denial
 *  sentinel so a denied tool reports 'denied' (red) instead of 'done' (green). */
function toolOutputText(data: unknown): string {
  const out = (data as { output?: unknown } | null)?.output;
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    const c = (out as { content?: unknown }).content;
    if (typeof c === 'string') return c;
  }
  return '';
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let s = '';
    for (const part of content) {
      if (part && typeof part === 'object') {
        // Only concat text parts — never a reasoning/thinking block (which some
        // providers stream as a distinct content-part type), so chain-of-thought
        // doesn't leak into the answer.
        const p = part as { type?: unknown; text?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') s += p.text;
      }
    }
    return s;
  }
  return '';
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface RunAiChatArgs {
  ctx: AiRequestContext;
  model: BaseChatModel;
  /** Resolved system prompt (operator override or bundled default). */
  systemPrompt: string;
  messages: ChatTurn[];
  signal?: AbortSignal;
  onToken: (text: string) => void;
  onError: (message: string) => void;
}

export async function runAiChat(args: RunAiChatArgs): Promise<void> {
  const { ctx, model, messages, signal } = args;
  // The `prompt` (resolved system text) + the tool schemas from buildAiTools are
  // the STATIC cache prefix — both must stay byte-stable across turns for
  // provider prompt caching to hit (see the cache invariant in prompt.ts). No
  // per-request data is interpolated here; only the message list below varies.
  const agent = createReactAgent({ llm: model, tools: buildAiTools(ctx), prompt: args.systemPrompt });
  const cleaner = makeTokenCleaner();
  const lcMessages = messages.map((m) =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content),
  );
  try {
    // recursionLimit counts super-steps (~2 per tool round); the default 25 cuts
    // off thorough multi-entity investigations mid-answer. 60 ≈ 30 tool rounds.
    const stream = agent.streamEvents(
      { messages: lcMessages },
      { version: 'v2', signal, recursionLimit: 60 },
    );
    for await (const ev of stream) {
      if (ev.event === 'on_chat_model_stream') {
        const chunk = (ev.data as { chunk?: { content?: unknown } }).chunk;
        const text = extractText(chunk?.content);
        if (text) {
          const clean = cleaner.push(text);
          if (clean) {
            ctx.flushFigures(); // close any buffered figure group before resuming prose
            args.onToken(clean);
          }
        }
      } else if (ev.event === 'on_tool_start') {
        ctx.emitTool(ev.name ?? 'tool', 'running');
      } else if (ev.event === 'on_tool_end') {
        // A verb-gated tool returns a "Permission denied: …" sentinel rather than
        // throwing; surface it as 'denied' (red) so the activity line doesn't
        // paint a blocked capability as a completed step.
        const denied = toolOutputText(ev.data).startsWith('Permission denied:');
        ctx.emitTool(ev.name ?? 'tool', denied ? 'denied' : 'done');
      }
    }
    const tail = cleaner.flush();
    if (tail) args.onToken(tail);
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'AbortSignalError')) return;
    const tail = cleaner.flush(); // don't drop text buffered at the failure point
    if (tail) args.onToken(tail);
    args.onError(err instanceof Error ? err.message : String(err));
  }
}
