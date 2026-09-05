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

import type { ViewStrings } from './strings.js';

/**
 * A node kind decides its lane and its colour; nothing is guessed from the
 * text. The kinds are Session Flow's vocabulary (`pkg/model`). `type` is the
 * colour class — one of the kind colours the stylesheet maps onto the design
 * tokens — and `title` names the key in {@link ViewStrings} for the kind's
 * plain-English name.
 */
export type Track = 'input' | 'messages' | 'context' | 'model' | 'tools' | 'agents' | 'annotation';
export type KindType = 'user' | 'assistant' | 'subagent-response' | 'model' | 'tool' | 'agent' | 'instruction' | 'annotation' | 'error';

export interface KindMeta {
  track: Track;
  type: KindType;
  title: keyof ViewStrings | null;
  /** English fallback when the kind is not in the table. */
  raw?: string;
}

const KIND: Record<string, KindMeta> = {
  'message.external': { track: 'input', type: 'user', title: 'legendInput' },
  'message.assistant': { track: 'messages', type: 'assistant', title: 'legendResponse' },
  'message.synthetic': { track: 'messages', type: 'error', title: 'clientMadeMessage' },
  'context.injection': { track: 'context', type: 'instruction', title: 'contextPutIn' },
  'agent.output': { track: 'messages', type: 'subagent-response', title: 'streamOutput' },
  'llm.call': { track: 'model', type: 'model', title: 'modelCall' },
  thinking: { track: 'model', type: 'model', title: 'reasoning' },
  tool: { track: 'tools', type: 'tool', title: 'toolWord' },
  'agent.call': { track: 'agents', type: 'agent', title: 'agentCallToChild' },
  'agent.launch_ack': { track: 'agents', type: 'agent', title: 'launchAcknowledged' },
  'runtime.notification': { track: 'agents', type: 'agent', title: 'notificationFromChild' },
  'epoch.boundary': { track: 'annotation', type: 'annotation', title: null, raw: 'Context reset' },
  'epoch.summary': { track: 'annotation', type: 'annotation', title: null, raw: 'Carried-forward summary' },
  'turn.duration': { track: 'annotation', type: 'annotation', title: null, raw: 'Turn duration' },
  'error.api': { track: 'annotation', type: 'error', title: null, raw: 'Provider error' },
  'control.interrupt': { track: 'annotation', type: 'error', title: null, raw: 'Interruption' },
  'control.permission': { track: 'annotation', type: 'annotation', title: null, raw: 'Permission decision' },
  'control.command': { track: 'annotation', type: 'annotation', title: null, raw: 'Runtime command' },
  'control.notice': { track: 'annotation', type: 'annotation', title: null, raw: 'Runtime notice' },
};

export function kindOf(kind: string): KindMeta {
  return KIND[kind] ?? { track: 'annotation', type: 'annotation', title: null, raw: kind };
}

/** The plain name of a kind, for a card title or a tooltip. */
export function kindTitle(kind: string, s: ViewStrings): string {
  const m = kindOf(kind);
  return m.title ? s[m.title] : (m.raw ?? kind);
}

/** The kinds that are structure, not steps. Everything else is a step. */
export const CONTAINER_KINDS: ReadonlySet<string> = new Set(['talk', 'run', 'stream', 'segment', 'session', 'epoch']);

export const TRACKS: readonly Track[] = ['input', 'messages', 'context', 'model', 'tools', 'agents', 'annotation'];

export const TRACK_NAME: Record<Track, keyof ViewStrings> = {
  input: 'laneInput',
  messages: 'laneResponses',
  context: 'laneContext',
  model: 'laneModel',
  tools: 'laneTools',
  agents: 'laneAgents',
  annotation: 'laneNotices',
};

/**
 * What the harness put into the model's context, said plainly. An injection
 * arrives as a small object with a type, and the type is the only part a reader
 * needs — measured over 358 of them, two thirds are the remaining token budget
 * and a sixth the task list restated. Runtime vocabulary, kept here on purpose:
 * it names Claude Code's injection types, which is the one place the renderer
 * knows a runtime's words, and only to say them in English.
 */
const INJECTION: Record<string, string> = {
  total_tokens: 'the remaining token budget',
  todo_reminder: 'the task list, restated',
  task_reminder: 'a reminder about the running task',
  edited_text_file: 'a file changed on disk',
  queued_command: 'a message sent while the agent was working',
  ultra_effort_enter: 'effort mode turned on',
  ultra_effort_exit: 'effort mode turned off',
  deferred_tools_delta: 'the tool list changed',
  agent_listing_delta: 'the list of agents changed',
  nested_memory: 'memory loaded from another file',
  date_change: 'the date changed',
  command_permissions: 'a permission decision',
  compact_file_reference: 'a pointer left behind by compaction',
  read_truncation_notice: 'a file read was cut short',
  invoked_skills: 'a skill was loaded',
  auto_mode: 'auto mode changed',
  file: 'a file was attached',
  system_reminder: 'a reminder from the harness',
  command_message: 'a command was run in line',
};

function injectionKind(text: string): string | null {
  const t = text.trim();
  const m = /^\{"type"\s*:\s*"([A-Za-z_]+)"/.exec(t);
  if (m) return m[1]!;
  const tag = /^<([a-z_-]+)>/.exec(t);
  if (tag) return tag[1]!.replace(/-/g, '_');
  return null;
}

/** What an injection says, or its own first line when it has no type. */
export function injectionSays(text: string | undefined): { key: string; says: string } | null {
  if (!text) return null;
  const k = injectionKind(text);
  if (k) return { key: k, says: INJECTION[k] ?? k.replace(/_/g, ' ') };
  const first = text.trim().split('\n').find((l) => l.trim());
  if (!first) return null;
  return { key: '', says: first.replace(/^[-*#\s]+/, '').slice(0, 60) };
}

/** A quiet stretch inside a talk is drawn as a gap rather than as empty width.
 *  Two minutes is the shortest pause that is visibly a pause and not a slow
 *  tool. */
export const QUIET_MS = 120 * 1000;

/** One lane: a 28px clip with room to breathe. */
export const LANE_H = 36;
