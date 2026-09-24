/*
 * Licensed to Apache Software Foundation (ASF) under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Apache Software Foundation (ASF) licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Reading a provider body as a conversation.
 *
 * The bodies are the runtime's own, so their shape is the runtime's, not the model's. This reads the
 * two shapes the Sessionizer captures: the Anthropic Messages API, which Claude Code sends, and
 * LangChain's own serialized messages, which a LangChain or LangGraph agent hands its model. It keeps
 * everything it does not know: an unread field stays under the settings, an unread block prints as
 * JSON. A body of another shape reads as one JSON document and nothing is lost.
 */

export interface PromptBlock {
  /** `text`, `tool_use`, `tool_result`, `thinking`, or whatever the body called it. */
  kind: string;
  text?: string;
  name?: string;
  /** A tool use's own id, and the id a tool result answers, which is how the two are paired. */
  id?: string;
  /** A tool use's input, a tool result's content, or an unread block, as JSON. */
  json?: unknown;
  /** Whether the runtime injected this text rather than a person writing it. */
  reminder?: boolean;
  /** Whether the provider marked this tool result a failure. A failed result and a successful one
   *  can carry the same text, and only this tells them apart. */
  failed?: boolean;
}

export interface PromptMessage {
  role: string;
  blocks: PromptBlock[];
  /** The message as it was sent, for the raw view and for comparing. */
  raw: unknown;
}

export interface PromptTool {
  name: string;
  description: string;
  raw: unknown;
}

export interface ReadRequest {
  kind: 'request';
  model?: string;
  system: PromptBlock[];
  tools: PromptTool[];
  messages: PromptMessage[];
  /** Every top-level field the sections above do not show, as JSON. */
  rest: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface ReadResponse {
  kind: 'response';
  model?: string;
  id?: string;
  stopReason?: string;
  blocks: PromptBlock[];
  usage?: Record<string, unknown>;
  rest: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/** A body that is not the shape this reader knows: it is shown as JSON, or as its own text when it is
 *  not JSON at all — a provider's plain error page rebuilds and verifies like any other body. */
export interface ReadOther {
  kind: 'other';
  raw: unknown;
  /** The body as text, when it did not read as JSON. */
  text?: string;
}

export type ReadBody = ReadRequest | ReadResponse | ReadOther;

const REMINDER = '<system-reminder>';

/** How deep the provider's cache marker sits in each thing the delta compares: on a message and on
 *  each of its content blocks, two levels in because the content is an array; on a system block or a
 *  tool, one level into the list; nowhere in the settings. */
const MARKED_IN_MESSAGE = 2;
const MARKED_IN_LIST = 1;
const NOT_MARKED = -1;

/** Reads a rebuilt body. `role` is what the manifest says the body is. */
export function readBody(bytes: Uint8Array, role: string): ReadBody {
  const text = new TextDecoder().decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'other', raw: null, text };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'other', raw: value };
  const body = value as Record<string, unknown>;
  if (role === 'request') {
    // Every message an object, or the list is not the Messages API. A LangChain request is a list of
    // lists, and reading it as messages drew one message with no role and nothing in it.
    if (isObjectList(body['messages'])) return readRequest(body);
    const prompt = langChainPrompt(body['messages']);
    if (prompt) return readLangChainRequest(body, prompt);
  }
  if (role === 'response') {
    if (Array.isArray(body['content'])) return readResponse(body);
    const generation = langChainGeneration(body['generations']);
    if (generation) return readLangChainResponse(body, generation);
  }
  return { kind: 'other', raw: value };
}

function isObjectList(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isObject);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRequest(body: Record<string, unknown>): ReadRequest {
  // Object.create(null), not {}: a body may carry a field called __proto__, and assigning that into
  // an ordinary object changes the object's prototype instead of keeping the value.
  const rest: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'system' && k !== 'tools' && k !== 'messages') rest[k] = v;
  }
  return {
    kind: 'request',
    model: typeof body['model'] === 'string' ? body['model'] : undefined,
    system: readSystem(body['system']),
    tools: readTools(body['tools']),
    messages: (body['messages'] as unknown[]).map(readMessage),
    rest,
    raw: body,
  };
}

function readResponse(body: Record<string, unknown>): ReadResponse {
  const rest: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'content' && k !== 'usage' && k !== 'stop_reason' && k !== 'id') rest[k] = v;
  }
  return {
    kind: 'response',
    model: typeof body['model'] === 'string' ? body['model'] : undefined,
    id: typeof body['id'] === 'string' ? body['id'] : undefined,
    stopReason: typeof body['stop_reason'] === 'string' ? body['stop_reason'] : undefined,
    blocks: (body['content'] as unknown[]).map(readBlock),
    usage: body['usage'] && typeof body['usage'] === 'object' ? (body['usage'] as Record<string, unknown>) : undefined,
    rest,
    raw: body,
  };
}

function readSystem(value: unknown): PromptBlock[] {
  if (typeof value === 'string') return [{ kind: 'text', text: value }];
  if (!Array.isArray(value)) return [];
  return value.map(readBlock);
}

function readTools(value: unknown): PromptTool[] {
  if (!Array.isArray(value)) return [];
  return value.map((t) => {
    const tool = (t ?? {}) as Record<string, unknown>;
    const description = typeof tool['description'] === 'string' ? tool['description'] : '';
    return { name: typeof tool['name'] === 'string' ? tool['name'] : '', description, raw: t };
  });
}

function readMessage(value: unknown): PromptMessage {
  const m = (value ?? {}) as Record<string, unknown>;
  const content = m['content'];
  const blocks = typeof content === 'string' ? [{ kind: 'text', text: content }] : Array.isArray(content) ? content.map(readBlock) : [];
  return { role: typeof m['role'] === 'string' ? m['role'] : '', blocks, raw: value };
}

function readBlock(value: unknown): PromptBlock {
  if (typeof value === 'string') return { kind: 'text', text: value };
  if (!value || typeof value !== 'object') return { kind: 'unknown', json: value };
  const b = value as Record<string, unknown>;
  const kind = typeof b['type'] === 'string' ? b['type'] : 'unknown';
  if (kind === 'text' && typeof b['text'] === 'string') {
    return { kind, text: b['text'], reminder: b['text'].includes(REMINDER) };
  }
  if (kind === 'thinking') {
    const thinking = typeof b['thinking'] === 'string' ? b['thinking'] : '';
    return { kind, text: thinking, json: value };
  }
  if (kind === 'tool_use') {
    return {
      kind,
      name: typeof b['name'] === 'string' ? b['name'] : '',
      ...(typeof b['id'] === 'string' ? { id: b['id'] } : {}),
      json: b['input'],
    };
  }
  if (kind === 'tool_result') {
    const content = b['content'];
    const about = {
      ...(typeof b['tool_use_id'] === 'string' ? { id: b['tool_use_id'] } : {}),
      ...(b['is_error'] === true ? { failed: true } : {}),
    };
    if (typeof content === 'string') return { kind, text: content, json: value, ...about };
    return { kind, json: content ?? value, ...about };
  }
  return { kind, json: value };
}

/*
 * LangChain's shape. A request's `messages` is a list of prompts, each a list of messages, and a chat
 * model call has exactly one prompt. A response's `generations` is a list per prompt of what the model
 * answered. A message is serialized with its class in `id` and its fields under `kwargs`, or is a plain
 * object when the caller passed one. It is what the framework handed its model, not what the provider
 * received, and it is read in LangChain's own words: a message's role is its `type`, `human`, `ai`,
 * `system` or `tool`. Several prompts, or several generations, do not read as one conversation, and
 * such a body is shown as the JSON it is.
 */

function langChainPrompt(messages: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(messages) || messages.length !== 1) return null;
  const prompt: unknown = messages[0];
  return isObjectList(prompt) ? prompt : null;
}

function langChainGeneration(generations: unknown): Record<string, unknown> | null {
  if (!Array.isArray(generations) || generations.length !== 1) return null;
  const prompt: unknown = generations[0];
  if (!Array.isArray(prompt) || prompt.length !== 1) return null;
  const only: unknown = prompt[0];
  return isObject(only) ? only : null;
}

function readLangChainRequest(body: Record<string, unknown>, prompt: Array<Record<string, unknown>>): ReadRequest {
  const rest: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(body)) if (k !== 'messages') rest[k] = v;
  // The system prompt is a message in the list, and the tools are not in the body at all: they are
  // bound to the model, not sent with the messages.
  return { kind: 'request', system: [], tools: [], messages: prompt.map(readLangChainMessage), rest, raw: body };
}

function readLangChainResponse(body: Record<string, unknown>, generation: Record<string, unknown>): ReadResponse {
  const message = generation['message'];
  const fields = isObject(message) ? langChainFields(message) : null;
  const rest: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (!['content', 'tool_calls', 'invalid_tool_calls', 'usage_metadata', 'id', 'type'].includes(k)) rest[k] = v;
  }
  if (generation['generation_info'] != null) rest['generation_info'] = generation['generation_info'];
  if (body['llm_output'] != null) rest['llm_output'] = body['llm_output'];
  const metadata = fields?.['response_metadata'];
  const output = body['llm_output'];
  const model = (isObject(metadata) ? metadata['model_name'] : undefined) ?? (isObject(output) ? output['model_name'] : undefined);
  const usage = fields?.['usage_metadata'];
  // A completion model answers with text and no message.
  const text = generation['text'];
  return {
    kind: 'response',
    model: typeof model === 'string' ? model : undefined,
    id: typeof fields?.['id'] === 'string' ? fields['id'] : undefined,
    blocks: fields ? langChainBlocks(fields, message) : typeof text === 'string' ? [{ kind: 'text', text }] : [],
    usage: isObject(usage) ? usage : undefined,
    rest,
    raw: body,
  };
}

function readLangChainMessage(value: Record<string, unknown>): PromptMessage {
  const fields = langChainFields(value);
  const type = typeof fields['type'] === 'string' ? fields['type'] : '';
  const role = typeof fields['role'] === 'string' ? fields['role'] : '';
  // A ChatMessage carries a role of the caller's choosing, and a plain object may say role and not type.
  return { role: type && type !== 'chat' ? type : role, blocks: langChainBlocks(fields, value), raw: value };
}

function langChainContentBlock(value: unknown): PromptBlock {
  return isObject(value) && value['type'] === 'tool_call' ? langChainToolCall(value) : readBlock(value);
}

function langChainToolCall(c: Record<string, unknown>): PromptBlock {
  const id = typeof c['id'] === 'string' ? c['id'] : undefined;
  return { kind: 'tool_use', name: typeof c['name'] === 'string' ? c['name'] : '', ...(id ? { id } : {}), json: c['args'] };
}

function langChainFields(m: Record<string, unknown>): Record<string, unknown> {
  const kwargs = m['kwargs'];
  return m['lc'] === 1 && m['type'] === 'constructor' && isObject(kwargs) ? kwargs : m;
}

/**
 * A message's content, then the tool calls it made. A tool message's content is the result of the call
 * it names.
 *
 * A call can also sit in the content: as the provider's `tool_use` block, which Bedrock repeated on
 * every call measured, or as LangChain's own `tool_call` block. It is drawn once, where the content
 * has it, with the arguments from `tool_calls`. Those are LangChain's parsed arguments, the ones the
 * agent ran with: a streamed provider block can still read `{}`, with the arguments in pieces beside it.
 */
function langChainBlocks(fields: Record<string, unknown>, raw: unknown): PromptBlock[] {
  const content = fields['content'];
  if (fields['type'] === 'tool' || fields['role'] === 'tool') {
    const about = {
      ...(typeof fields['tool_call_id'] === 'string' ? { id: fields['tool_call_id'] } : {}),
      ...(fields['status'] === 'error' ? { failed: true } : {}),
    };
    return [typeof content === 'string' ? { kind: 'tool_result', text: content, json: raw, ...about } : { kind: 'tool_result', json: content ?? raw, ...about }];
  }
  const blocks: PromptBlock[] =
    typeof content === 'string'
      ? content
        ? [{ kind: 'text', text: content, reminder: content.includes(REMINDER) }]
        : []
      : Array.isArray(content)
        ? content.map(langChainContentBlock)
        : [];
  const at = new Map<string, number>();
  blocks.forEach((b, i) => {
    if (b.kind === 'tool_use' && b.id) at.set(b.id, i);
  });
  for (const call of Array.isArray(fields['tool_calls']) ? (fields['tool_calls'] as unknown[]) : []) {
    const use = langChainToolCall(isObject(call) ? call : {});
    const i = use.id ? at.get(use.id) : undefined;
    if (i === undefined) blocks.push(use);
    else blocks[i] = { ...use, name: use.name || (blocks[i]!.name ?? '') };
  }
  for (const call of Array.isArray(fields['invalid_tool_calls']) ? (fields['invalid_tool_calls'] as unknown[]) : []) {
    blocks.push({ kind: 'invalid_tool_call', json: call });
  }
  if (blocks.length) return blocks;
  // An empty answer is an empty text. A message whose content is not there at all, or is not a shape
  // this reads, is shown as the JSON it is rather than as an empty box.
  return typeof content === 'string' ? [{ kind: 'text', text: '' }] : [{ kind: 'unknown', json: raw }];
}

/** What one request adds to the one before it. */
export interface PromptDelta {
  /** The messages this request carries that the one before it did not. */
  added: PromptMessage[];
  /** How many messages the two share, and how many bytes they are. */
  sharedMessages: number;
  sharedBytes: number;
  /** Whether the shared messages differ in their own text, rather than the list only growing. */
  rewritten: boolean;
  /** Whether the list was replaced rather than added to: a compaction starts it again from the
   *  summary that took the place of the context, so it is shorter as well as different. A rewrite
   *  that is not this is the rare one, and worth saying so. */
  replaced: boolean;
  /** What else changed outside the messages. */
  systemChanged: boolean;
  toolsChanged: boolean;
  settingsChanged: boolean;
}

/**
 * Compares two requests, message by message, from the start. The cache marker the runtime moves down
 * the list as it goes is left out of the comparison, so a message that only lost or gained that marker
 * counts as unchanged; everything else is compared as it was sent.
 */
export function deltaOf(previous: ReadRequest, current: ReadRequest): PromptDelta {
  let shared = 0;
  let rewritten = false;
  const least = Math.min(previous.messages.length, current.messages.length);
  while (shared < least && same(previous.messages[shared]!.raw, current.messages[shared]!.raw, MARKED_IN_MESSAGE)) shared++;
  if (shared < least) rewritten = true;
  const replaced = rewritten && current.messages.length < previous.messages.length;
  const added = current.messages.slice(shared);
  let sharedBytes = 0;
  for (let i = 0; i < shared; i++) sharedBytes += size(current.messages[i]!.raw);
  return {
    added,
    sharedMessages: shared,
    sharedBytes,
    rewritten,
    replaced,
    systemChanged: !same(previous.raw['system'], current.raw['system'], MARKED_IN_LIST),
    toolsChanged: !same(previous.raw['tools'], current.raw['tools'], MARKED_IN_LIST),
    settingsChanged: !same(settings(previous), settings(current), NOT_MARKED),
  };
}

function settings(r: ReadRequest): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(r.rest)) if (k !== 'metadata') out[k] = v;
  return out;
}

/**
 * Two values, compared without the moving cache marker. `markedTo` is how deep the marker can sit in
 * this value: a message carries one and so does each of its content blocks, which are two levels in
 * because the content is an array; a system block or a tool is one level into the list it is in.
 */
function same(a: unknown, b: unknown, markedTo: number): boolean {
  return canonical(a, markedTo) === canonical(b, markedTo);
}

function size(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

/**
 * The value as one string, with the two things the runtime changes about a message it is no longer
 * caching left out.
 *
 * The first is the `cache_control` marker, which the runtime moves down the message list as the
 * conversation grows, so a message that only gained or lost one is the same message. It sits on a
 * message, a content block, a system block or a tool, and nowhere deeper: a `cache_control` inside a
 * tool's own input or schema is the agent's data, and two calls that differ only there differ. That
 * is why the walk carries how deep the marker can be rather than removing the name at every depth.
 *
 * The second is the shape of the content itself. A message of one text block is sent as a list while
 * it is the newest, and as a plain string once the marker has left it, which is what Claude Code was
 * measured to write and what the Sessionizer reproduces. The text is the same and the message is the
 * same, so the two spellings have to compare equal: without this, every message compared unequal the
 * moment it stopped being the newest, and a history that merely grew was read as one that had been
 * rewritten.
 *
 * It builds a string instead of an object because a body can carry a `__proto__` key, and assigning
 * that into an object changes the object's prototype instead of keeping the value.
 */
function canonical(value: unknown, markedTo: number, depth = 0): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, markedTo, depth + 1)).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    if (depth <= markedTo && k === 'cache_control') continue;
    const v = k === 'content' && depth < markedTo ? plainContent(obj[k]) : obj[k];
    parts.push(`${JSON.stringify(k)}:${canonical(v, markedTo, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * One text block and the plain string it becomes, as the same value. Anything else is left as it is:
 * a message of several blocks, or of one block that is not text, never takes the short spelling.
 */
function plainContent(content: unknown): unknown {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content) || content.length !== 1) return content;
  const only = content[0] as Record<string, unknown> | null;
  if (!only || typeof only !== 'object' || only['type'] !== 'text' || typeof only['text'] !== 'string') return content;
  // Only the type and the text survive: the marker is dropped by the walk above, and a lone text
  // block carries nothing else the plain spelling could have kept.
  return [{ type: 'text', text: only['text'] }];
}
