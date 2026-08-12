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
import { useAuthStore } from '@/state/auth';
import { createHistoryStore, noopHistory, historyEnabledPref, setHistoryEnabledPref, type HistoryStore } from './historyStore';
import { aiHistorySettings } from './useAiChat';
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
    } else if (b.kind === 'profiling') {
      parts.push(`(profiling: ${b.spec.profilingType} for ${b.spec.service})`);
    } else if (b.kind === 'process-topology') {
      parts.push(`(process map: ${b.spec.service})`);
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
    } else if (b.kind === 'proposal') {
      // Carry the OUTCOME and the created task id. Without the id a follow-up
      // "analyze it" has nothing to pass to analyze_profiling, which then falls
      // back to the most recent task of that type — possibly a different one.
      // An approval WITHOUT a task id must say so: analyze_profiling would
      // otherwise fall back to the most recent task of that type and silently
      // analyse something the operator never approved.
      const outcome =
        b.status !== 'approved'
          ? b.status
          : b.taskId
            ? `approved, taskId ${b.taskId}`
            : 'approved but OAP returned no task id — no task to analyse by id; say so rather than analysing a different recent task';
      parts.push(`(suggested action: ${b.spec.profilingType} profiling for ${b.spec.service} — ${outcome})`);
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

/** `active` — a turn is in flight (you are composing, or an answer is streaming),
 *  so the newest state is not written yet. `saved` — written to the browser
 *  store. `conflicted` — the stored copy was continued elsewhere and diverged;
 *  nothing was overwritten and the operator has to choose. */
export type ConversationStatus = 'active' | 'saved' | 'conflicted';

const conversations = ref<Conversation[]>([]);
const currentId = ref<string | null>(null);
const streaming = ref(false);
// Aborts the in-flight answer (stop button / panel close), so a closed panel
// stops consuming the model instead of streaming to nowhere.
let streamController: AbortController | null = null;

let store: HistoryStore = noopHistory;
let owner = '';
let storeIsReal = false;
let loadedOwner: string | null = null;
let loadedReal = false;

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function applyLoaded(loaded: Conversation[]): void {
  conversations.value = loaded;
  if (!loaded.some((c) => c.id === currentId.value)) currentId.value = loaded[0]?.id ?? null;
}

function rebuildStore(): boolean {
  const settings = aiHistorySettings();
  storeIsReal = historyEnabledPref(owner) && !!settings && !!owner;
  store = storeIsReal && settings ? createHistoryStore(settings.mode, { maxBytes: settings.maxBytes }) : noopHistory;
  return storeIsReal;
}

// Build the store for the current user + config and load their history. Loads on
// first run, owner change, or when a real store first becomes usable (config
// arrived after an initial no-op hydrate). Call after ensureConfig.
async function hydrate(): Promise<void> {
  const nextOwner = useAuthStore().user?.username ?? '';
  owner = nextOwner;
  const real = rebuildStore();
  if (nextOwner === loadedOwner && !(real && !loadedReal)) return;
  const loaded = await store.load(nextOwner);
  if (owner !== nextOwner) return; // user switched during the load — discard the stale result
  loadedOwner = nextOwner;
  loadedReal = real;
  applyLoaded(loaded);
}

// Every store mutation runs through ONE chain. `save` is a read-modify-write
// over the WHOLE owner set, so a save racing a clear/remove resurrects rows that
// were just deleted. Queued tasks also read the CURRENT list when they RUN, not
// when they were queued, so a save enqueued before a Clear all writes the
// post-clear truth instead of its stale snapshot.
let mutations: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = mutations.then(task, task);
  mutations = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Persist immediately (send() persists once per finished turn, not per token),
// notifying other tabs only when the write was real (a no-op store must not make
// a peer reload to empty).
/** Per-conversation persistence state, keyed by uuid. Runtime only — never
 *  stored. `active` = a turn is in flight or there are unwritten changes;
 *  `saved` = written to the browser store; `conflicted` = the stored copy
 *  diverged (continued in another tab) and NOTHING was overwritten — the
 *  operator chooses. */
const status = ref<Record<string, ConversationStatus>>({});
function setStatus(id: string, s: ConversationStatus): void {
  status.value = { ...status.value, [id]: s };
}

// Write ONE conversation, by its uuid. The store is keyed per conversation, so
// this touches only that row: it cannot drop, resurrect or reorder anyone
// else's, which is what the old whole-collection save could do.
function persist(target?: Conversation): void {
  const own = owner;
  void enqueue(async () => {
    if (own !== owner) return; // user switched while this was queued
    const conv = target ?? current.value;
    if (!conv) return;
    const s = store;
    const { conflicted } = await s.upsert(own, [conv]);
    if (own !== owner) return;
    if (conflicted.length) {
      // Nothing was written. Leave the conversation flagged so the operator can
      // choose; re-persisting on the next turn will conflict again until they do.
      setStatus(conv.id, 'conflicted');
      return;
    }
    setStatus(conv.id, 'saved');
    const evicted = await s.enforceBudget(own);
    if (own !== owner || !evicted.length) return;
    // Only ids the budget actually dropped — no whole-set reconcile to get wrong.
    const gone = new Set(evicted);
    conversations.value = conversations.value.filter((c) => !gone.has(c.id));
    if (currentId.value && gone.has(currentId.value)) {
      currentId.value = conversations.value[0]?.id ?? null;
    }
  });
}

const current = computed<Conversation | null>(() => conversations.value.find((c) => c.id === currentId.value) ?? null);

function newChat(): Conversation {
  const conv: Conversation = { id: uid(), title: '', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  conversations.value.unshift(conv);
  currentId.value = conv.id;
  setStatus(conv.id, 'active');
  persist(conversations.value[0]);
  // Return the reactive array element, not the raw literal — streamed mutations must go
  // through the proxy or the transcript won't re-render.
  return conversations.value[0];
}

function select(id: string): void {
  currentId.value = id;
}

// Bind the owner + store at CALL time. The queued closure would otherwise read
// the module-level values when it eventually RUNS, so an account switch while
// the queue drains would apply Alice's delete/clear to Bob's history.
async function remove(id: string): Promise<void> {
  const own = owner;
  const s = store;
  conversations.value = conversations.value.filter((c) => c.id !== id);
  if (currentId.value === id) currentId.value = conversations.value[0]?.id ?? null;
  await enqueue(() => s.remove(own, id));
}

async function clearAll(): Promise<void> {
  const own = owner;
  const s = store;
  conversations.value = [];
  currentId.value = null;
  await enqueue(() => s.clear(own));
}

// On: merge stored history with the session's in-memory conversations, then
// persist — never overwrite the store with a possibly-empty in-memory list. Off:
// switch to no-op; existing records stay until Clear all.
async function setHistoryEnabled(on: boolean): Promise<void> {
  const own = owner;
  setHistoryEnabledPref(own, on);
  rebuildStore();
  if (on && storeIsReal) {
    const s = store;
    const stored = await s.load(own);
    // The load is async: if the account switched while it was in flight, the
    // in-memory list is now the NEW user's — merging would file Alice's rows
    // under Bob.
    if (own !== owner) return;
    const haveIds = new Set(conversations.value.map((c) => c.id));
    const merged = [...conversations.value, ...stored.filter((c) => !haveIds.has(c.id))].sort((a, b) => b.updatedAt - a.updatedAt);
    applyLoaded(merged);
    void enqueue(() => s.upsert(own, merged));
  }
}

function usageBytes(): Promise<number> {
  return store.usageBytes(owner);
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

  conv.messages.push({ id: uid(), role: 'user', blocks: [{ kind: 'text', text: q }], at: Date.now() });
  // Prior turns (including the just-added user turn) become the LLM history;
  // the not-yet-streamed assistant placeholder is excluded.
  const history: AiTurn[] = conv.messages
    .map((m) => ({ role: m.role, content: textOf(m.blocks) }))
    .filter((m) => m.content.trim().length > 0);
  conv.messages.push({ id: uid(), role: 'assistant', blocks: [], streaming: true });
  const assistant = conv.messages[conv.messages.length - 1] as ChatMessage;

  setStatus(conv.id, 'active');
  streaming.value = true;
  streamController = new AbortController();
  try {
    for await (const ev of streamAnswer(history, rangeForCurrentPreset(), streamController.signal)) {
      if (ev.type === 'token') appendToken(assistant.blocks, ev.text);
      else if (ev.type === 'tool') applyTool(assistant.blocks, ev.name, ev.status);
      // Stamp the capture time so a reloaded (frozen) figure documents WHEN its
      // point-in-time data is from, not read as current.
      else if (ev.type === 'figure') assistant.blocks.push({ kind: 'figure', n: ev.n, title: ev.title, layout: ev.layout, figures: ev.figures, capturedAt: Date.now() });
      else if (ev.type === 'proposal') assistant.blocks.push({ kind: 'proposal', n: ev.n, spec: ev.spec, status: 'pending' });
      else if (ev.type === 'profiling') assistant.blocks.push({ kind: 'profiling', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'process-topology') assistant.blocks.push({ kind: 'process-topology', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'podlogs') assistant.blocks.push({ kind: 'podlogs', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'hierarchy') assistant.blocks.push({ kind: 'hierarchy', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'topology') assistant.blocks.push({ kind: 'topology', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'deployment') assistant.blocks.push({ kind: 'deployment', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'instance-topology') assistant.blocks.push({ kind: 'instance-topology', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'endpoint-dependency') assistant.blocks.push({ kind: 'endpoint-dependency', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'traces') assistant.blocks.push({ kind: 'traces', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'zipkin-traces') assistant.blocks.push({ kind: 'zipkin-traces', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'logs') assistant.blocks.push({ kind: 'logs', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'browser-errors') assistant.blocks.push({ kind: 'browser-errors', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'error') appendToken(assistant.blocks, `\n\n⚠ ${ev.message}`);
      else if (ev.type === 'done') break;
    }
  } finally {
    streamController = null;
    assistant.streaming = false;
    assistant.at = Date.now(); // reply-finished time
    streaming.value = false;
    conv.updatedAt = Date.now();
    persist(conv);
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
  persist(conv ?? undefined);
}

/** Operator's answer to a conflict. `mine` force-writes this tab's version;
 *  `theirs` reloads the stored one, discarding the local divergence. */
async function resolveConflict(id: string, choice: 'mine' | 'theirs'): Promise<void> {
  const own = owner;
  const s = store;
  await enqueue(async () => {
    if (own !== owner) return;
    if (choice === 'mine') {
      const conv = conversations.value.find((c) => c.id === id);
      if (!conv) return;
      await s.upsert(own, [conv], { force: true });
    } else {
      const stored = await s.loadOne(own, id);
      if (own !== owner) return;
      if (!stored) return;
      conversations.value = conversations.value.map((c) => (c.id === id ? stored : c));
    }
    setStatus(id, 'saved');
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
  remove: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  hydrate: () => Promise<void>;
  setHistoryEnabled: (on: boolean) => Promise<void>;
  historyEnabled: () => boolean;
  usageBytes: () => Promise<number>;
  /** Per-conversation persistence state, keyed by uuid. */
  status: Ref<Record<string, ConversationStatus>>;
  /** Resolve a conflicted conversation: keep THIS tab's version (force-write it)
   *  or take the stored one (discard the local divergence). */
  resolveConflict: (id: string, choice: 'mine' | 'theirs') => Promise<void>;
}

export function useAiConversations(): AiConversations {
  return {
    conversations,
    current,
    currentId,
    streaming,
    send,
    stop,
    resolveProposal,
    newChat,
    select,
    remove,
    clearAll,
    hydrate,
    setHistoryEnabled,
    historyEnabled: () => historyEnabledPref(owner),
    usageBytes,
    status,
    resolveConflict,
  };
}
