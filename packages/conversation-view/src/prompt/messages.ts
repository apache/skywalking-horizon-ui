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
 * The bodies are the runtime's own, so their shape is the provider's API, not the model's. This reads
 * the one shape the Sessionizer captures today, the Anthropic Messages API, and keeps everything it
 * does not know: an unread field stays under the settings, an unread block prints as JSON. A body of
 * another shape reads as one JSON document and nothing is lost.
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
  if (role === 'request' && Array.isArray(body['messages'])) return readRequest(body);
  if (role === 'response' && Array.isArray(body['content'])) return readResponse(body);
  return { kind: 'other', raw: value };
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

/** What one request adds to the one before it. */
export interface PromptDelta {
  /** The messages this request carries that the one before it did not. */
  added: PromptMessage[];
  /** How many messages the two share, and how many bytes they are. */
  sharedMessages: number;
  sharedBytes: number;
  /** Whether the shared messages differ in their own text, which a compaction does. */
  rewritten: boolean;
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
  const added = current.messages.slice(shared);
  let sharedBytes = 0;
  for (let i = 0; i < shared; i++) sharedBytes += size(current.messages[i]!.raw);
  return {
    added,
    sharedMessages: shared,
    sharedBytes,
    rewritten,
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
 * The value as one string, with the provider's cache markers left out.
 *
 * The marker is a `cache_control` field the runtime moves down the message list as the conversation
 * grows, so a message that only gained or lost one is the same message. It sits on a message, a
 * content block, a system block or a tool, and nowhere deeper: a `cache_control` inside a tool's own
 * input or schema is the agent's data, and two calls that differ only there differ. That is why the
 * walk carries how deep the marker can be rather than removing the name at every depth.
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
    parts.push(`${JSON.stringify(k)}:${canonical(obj[k], markedTo, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}
