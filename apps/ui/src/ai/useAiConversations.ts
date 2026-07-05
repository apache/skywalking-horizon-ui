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

// Conversation store (module singleton): holds the list + current transcript, drives the
// BFF chat stream (streamAnswer), and appends each SSE event into an ordered Block[].
// Persists to localStorage, live-syncs across tabs.
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { localStorageHistory, HISTORY_KEY } from './historyStore';
import { streamAnswer, type AiTurn, type AiStreamRange } from './aiStream';
import { AI_TIME_PRESETS, aiTimePresetId } from './scope';
import type { Block, Conversation, ChatMessage, ProposalBlock, ProposalStatus } from './types';

/** Text of a message's blocks for the LLM history. Prose carries forward
 *  verbatim; a figure-only assistant turn is summarised by its figure titles so
 *  the turn isn't empty (an empty turn would be dropped, creating a user→user
 *  gap in the replayed history). Tool chips are dropped. */
function textOf(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'text') parts.push(b.text);
    else if (b.kind === 'figure') {
      const titles = b.figures.map((f) => f.spec.title).filter(Boolean);
      parts.push(`(rendered figure${titles.length > 1 ? 's' : ''}: ${titles.join(', ') || b.title || 'chart'})`);
    } else if (b.kind === 'podlogs') {
      parts.push(`(pod logs: ${b.spec.title})`);
    } else if (b.kind === 'hierarchy') {
      parts.push(`(hierarchy: ${b.spec.service})`);
    } else if (b.kind === 'topology') {
      parts.push(`(topology: ${b.spec.service})`);
    } else if (b.kind === 'deployment') {
      parts.push(`(deployment: ${b.spec.service})`);
    } else if (b.kind === 'instance-topology') {
      parts.push(`(instance map: ${b.spec.clientService} → ${b.spec.serverService})`);
    } else if (b.kind === 'endpoint-dependency') {
      parts.push(`(endpoint dependency: ${b.spec.service})`);
    } else if (b.kind === 'traces') {
      parts.push(`(traces: ${b.spec.service})`);
    } else if (b.kind === 'zipkin-traces') {
      parts.push(`(zipkin traces: ${b.spec.service})`);
    } else if (b.kind === 'logs') {
      parts.push(`(logs: ${b.spec.service})`);
    } else if (b.kind === 'browser-errors') {
      parts.push(`(browser errors: ${b.spec.service})`);
    } else if (b.kind === 'subpage') {
      parts.push(`(sub-page: ${b.spec.title})`);
    } else if (b.kind === 'proposal') {
      parts.push(`(suggested action: ${b.spec.kind} for ${b.spec.service})`);
    }
  }
  return parts.join(' ').trim();
}

/** Step scales with the window so long ranges don't blow the OAP bucket cap. */
function rangeForCurrentPreset(): AiStreamRange {
  const minutes = AI_TIME_PRESETS.find((p) => p.id === aiTimePresetId.value)?.minutes ?? 60;
  const endMs = Date.now();
  const startMs = endMs - minutes * 60_000;
  const step: AiStreamRange['step'] = minutes <= 360 ? 'MINUTE' : minutes <= 10080 ? 'HOUR' : 'DAY';
  return { startMs, endMs, step };
}

const conversations = ref<Conversation[]>(localStorageHistory.load());
const currentId = ref<string | null>(conversations.value[0]?.id ?? null);
const streaming = ref(false);
// Aborts the in-flight answer (stop button / panel close), so a closed panel
// stops consuming the model instead of streaming to nowhere.
let streamController: AbortController | null = null;

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function persist(): void {
  localStorageHistory.save(conversations.value);
}

const current = computed<Conversation | null>(() => conversations.value.find((c) => c.id === currentId.value) ?? null);

function newChat(): Conversation {
  const conv: Conversation = { id: uid(), title: '', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  conversations.value.unshift(conv);
  currentId.value = conv.id;
  persist();
  // Return the reactive array element, not the raw literal — streamed mutations must go
  // through the proxy or the transcript won't re-render.
  return conversations.value[0];
}

function select(id: string): void {
  currentId.value = id;
}

function remove(id: string): void {
  conversations.value = conversations.value.filter((c) => c.id !== id);
  if (currentId.value === id) currentId.value = conversations.value[0]?.id ?? null;
  persist();
}

function ensureCurrent(): Conversation {
  const c = current.value;
  return c ?? newChat();
}

function appendToken(blocks: Block[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === 'text') last.text += text;
  else blocks.push({ kind: 'text', text });
}

function applyTool(blocks: Block[], name: string, status: 'running' | 'done' | 'denied'): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === 'tool' && b.name === name) {
      b.status = status;
      return;
    }
  }
  blocks.push({ kind: 'tool', name, status });
}

async function send(text: string): Promise<void> {
  const q = text.trim();
  if (!q || streaming.value) return;
  const conv = ensureCurrent();
  if (!conv.title) conv.title = q.slice(0, 60);

  conv.messages.push({ id: uid(), role: 'user', blocks: [{ kind: 'text', text: q }] });
  // Prior turns (including the just-added user turn) become the LLM history;
  // the not-yet-streamed assistant placeholder is excluded.
  const history: AiTurn[] = conv.messages
    .map((m) => ({ role: m.role, content: textOf(m.blocks) }))
    .filter((m) => m.content.trim().length > 0);
  conv.messages.push({ id: uid(), role: 'assistant', blocks: [], streaming: true });
  const assistant = conv.messages[conv.messages.length - 1] as ChatMessage;

  streaming.value = true;
  streamController = new AbortController();
  try {
    for await (const ev of streamAnswer(history, rangeForCurrentPreset(), streamController.signal)) {
      if (ev.type === 'token') appendToken(assistant.blocks, ev.text);
      else if (ev.type === 'tool') applyTool(assistant.blocks, ev.name, ev.status);
      else if (ev.type === 'figure') assistant.blocks.push({ kind: 'figure', n: ev.n, title: ev.title, layout: ev.layout, figures: ev.figures });
      else if (ev.type === 'subpage') assistant.blocks.push({ kind: 'subpage', n: ev.n, spec: ev.spec });
      else if (ev.type === 'proposal') assistant.blocks.push({ kind: 'proposal', n: ev.n, spec: ev.spec, status: 'pending' });
      else if (ev.type === 'podlogs') assistant.blocks.push({ kind: 'podlogs', n: ev.n, spec: ev.spec });
      else if (ev.type === 'hierarchy') assistant.blocks.push({ kind: 'hierarchy', n: ev.n, spec: ev.spec });
      else if (ev.type === 'topology') assistant.blocks.push({ kind: 'topology', n: ev.n, spec: ev.spec });
      else if (ev.type === 'deployment') assistant.blocks.push({ kind: 'deployment', n: ev.n, spec: ev.spec });
      else if (ev.type === 'instance-topology') assistant.blocks.push({ kind: 'instance-topology', n: ev.n, spec: ev.spec });
      else if (ev.type === 'endpoint-dependency') assistant.blocks.push({ kind: 'endpoint-dependency', n: ev.n, spec: ev.spec });
      else if (ev.type === 'traces') assistant.blocks.push({ kind: 'traces', n: ev.n, spec: ev.spec });
      else if (ev.type === 'zipkin-traces') assistant.blocks.push({ kind: 'zipkin-traces', n: ev.n, spec: ev.spec });
      else if (ev.type === 'logs') assistant.blocks.push({ kind: 'logs', n: ev.n, spec: ev.spec });
      else if (ev.type === 'browser-errors') assistant.blocks.push({ kind: 'browser-errors', n: ev.n, spec: ev.spec });
      else if (ev.type === 'error') appendToken(assistant.blocks, `\n\n⚠ ${ev.message}`);
      else if (ev.type === 'done') break;
    }
  } finally {
    streamController = null;
    assistant.streaming = false;
    streaming.value = false;
    conv.updatedAt = Date.now();
    persist();
  }
}

/** Stop the in-flight answer (Stop button / ESC). Marks the streaming assistant
 *  turn as interrupted so the transcript can show it was cut short. */
function stop(): void {
  if (streaming.value) {
    const msgs = current.value?.messages;
    const last = msgs?.[msgs.length - 1];
    if (last && last.role === 'assistant' && last.streaming) last.interrupted = true;
  }
  streamController?.abort();
}

/** Update a proposal decision card's outcome (approve/dismiss). The store owns
 *  the conversation, so the mutation + persistence live here, not in the card. */
function resolveProposal(
  block: ProposalBlock,
  status: ProposalStatus,
  patch?: { taskId?: string; error?: string },
): void {
  block.status = status;
  if (patch?.taskId !== undefined) block.taskId = patch.taskId;
  if (patch?.error !== undefined) block.error = patch.error;
  const conv = current.value;
  if (conv) conv.updatedAt = Date.now();
  persist();
}

// Cross-tab sync: reload when another tab writes history (skip mid-stream).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== HISTORY_KEY || streaming.value) return;
    conversations.value = localStorageHistory.load();
    if (!conversations.value.some((c) => c.id === currentId.value)) {
      currentId.value = conversations.value[0]?.id ?? null;
    }
  });
}

export interface AiConversations {
  conversations: Ref<Conversation[]>;
  current: ComputedRef<Conversation | null>;
  currentId: Ref<string | null>;
  streaming: Ref<boolean>;
  send: (text: string) => Promise<void>;
  stop: () => void;
  resolveProposal: (block: ProposalBlock, status: ProposalStatus, patch?: { taskId?: string; error?: string }) => void;
  newChat: () => Conversation;
  select: (id: string) => void;
  remove: (id: string) => void;
}

export function useAiConversations(): AiConversations {
  return { conversations, current, currentId, streaming, send, stop, resolveProposal, newChat, select, remove };
}
