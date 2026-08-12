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

// Conversation history persistence. Records are owner-scoped (per username).
// Each mode selects its own impl via createHistoryStore; only `client`
// (browser IndexedDB, unencrypted) is implemented today. All ops degrade
// silently (resolve, never reject) when IndexedDB is unavailable or a write
// fails — the same posture as the localStorage impl it replaced.
import type { Conversation } from './types';

export type HistoryMode = 'client' | 'server';

export interface UpsertResult {
  /** Ids actually written. */
  written: string[];
  /** Ids NOT written because the stored version had turns this one does not —
   *  the same conversation was continued somewhere else and the two diverged.
   *  Nothing is overwritten on a conflict; the operator decides (write mine, or
   *  take theirs), and only then does the caller re-issue with `force`. */
  conflicted: string[];
}

/** Conversations are append-only, so a stored version is safe to overwrite when
 *  its messages are a PREFIX of the incoming one — same ids, in order. Anything
 *  else means the stored copy carries turns this one never saw. */
function isContinuationOf(stored: Conversation, incoming: Conversation): boolean {
  if (stored.messages.length > incoming.messages.length) return false;
  return stored.messages.every((m, i) => m.id === incoming.messages[i]?.id);
}

export interface HistoryStore {
  load(owner: string): Promise<Conversation[]>;
  /** Write conversations BY KEY — puts only, never deletes. The store is keyed
   *  per conversation, so a writer only ever touches the rows it names: a stale
   *  caller cannot drop or resurrect anyone else's row, and concurrent writers
   *  converge without locking. (The previous whole-collection replace is what
   *  made deletion implicit — "absent from the list" — and forced tombstones
   *  and a lock to defend against it.) */
  upsert(owner: string, conversations: Conversation[], opts?: { force?: boolean }): Promise<UpsertResult>;
  /** Re-read ONE conversation by uuid — used to take the other tab's version
   *  when the operator resolves a conflict that way. */
  loadOne(owner: string, id: string): Promise<Conversation | null>;
  /** Enforce the byte budget, oldest-first, and report the ids it evicted so the
   *  caller can drop them from its in-memory list. The ONE operation that needs a
   *  whole-owner view — kept off the write path so ordinary writes stay row-local. */
  enforceBudget(owner: string): Promise<string[]>;
  remove(owner: string, id: string): Promise<void>;
  clear(owner: string): Promise<void>;
  usageBytes(owner: string): Promise<number>;
}

const DB_NAME = 'sw.ai.history';
const STORE = 'conversations';
const ENABLED_PREFIX = 'sw.ai.history.enabled:';
/** Pre-IndexedDB store: ONE localStorage key holding a plain Conversation[],
 *  with no owner scoping (it predates per-user history). */
const LEGACY_KEY = 'sw.ai.history.v1';

type StoredConversation = Conversation & { owner: string };

function sizeOf(v: unknown): number {
  return new Blob([JSON.stringify(v)]).size;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
// Resolves null (never rejects) when IndexedDB is unavailable (private mode, old
// browser) so callers degrade to no persistence instead of throwing.
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 2);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('owner', 'owner', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function reqToPromise<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Newest-first, dropping oldest past the byte cap (always keeps at least one).
function capToBytes(conversations: Conversation[], maxBytes: number): Conversation[] {
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  if (maxBytes <= 0) return sorted;
  const kept: Conversation[] = [];
  let total = 0;
  for (const c of sorted) {
    const sz = sizeOf(c);
    if (kept.length > 0 && total + sz > maxBytes) break;
    kept.push(c);
    total += sz;
  }
  return kept;
}

function stripOwner(rec: StoredConversation): Conversation {
  const { owner: _owner, ...conv } = rec;
  return conv;
}

/** Discard the pre-IndexedDB localStorage history rather than adopting it.
 *  That store had NO owner scoping, so there is no way to tell whose
 *  conversations it holds — adopting them would attribute one person's prompts
 *  and captured telemetry to whoever happens to sign in first on a shared
 *  browser. Nothing is lost by dropping it: the assistant is unreleased (it has
 *  never shipped in a tagged version), so the only data here belongs to dev
 *  builds. */
function discardLegacy(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* storage disabled — nothing to discard */
  }
}

export function indexedDbHistory(maxBytes: number): HistoryStore {
  return {
    async load(owner) {
      const db = await openDb();
      if (!db) return [];
      discardLegacy();
      try {
        const tx = db.transaction(STORE, 'readonly');
        const rows = await reqToPromise<StoredConversation[]>(tx.objectStore(STORE).index('owner').getAll(owner));
        return rows.map(stripOwner).sort((a, b) => b.updatedAt - a.updatedAt);
      } catch {
        return [];
      }
    },
    async loadOne(owner, id) {
      const db = await openDb();
      if (!db) return null;
      try {
        const rec = await reqToPromise<StoredConversation | undefined>(
          db.transaction(STORE, 'readonly').objectStore(STORE).get(id),
        );
        return rec && rec.owner === owner ? stripOwner(rec) : null;
      } catch {
        return null;
      }
    },
    async upsert(owner, conversations, opts) {
      const conflicted: string[] = [];
      const written: string[] = [];
      if (!conversations.length) return { written, conflicted };
      const db = await openDb();
      if (!db) return { written, conflicted };
      try {
        // Compare against what is stored BEFORE writing: same key + a stored copy
        // that is not a prefix of ours means this conversation was continued in
        // another tab too, and one side's turns are about to be lost.
        // Fetch BY KEY, not the owner index — a turn must not deserialize the
        // user's entire history (megabytes of captured blocks) to look at one
        // row. Every get() is issued before the first await so the read tx does
        // not auto-commit underneath us.
        const readTx = db.transaction(STORE, 'readonly').objectStore(STORE);
        const prior = await Promise.all(
          conversations.map((c) => reqToPromise<StoredConversation | undefined>(readTx.get(c.id))),
        );
        const toWrite = conversations.filter((c, i) => {
          const prev = prior[i];
          // A direct key get bypasses the owner index, so confirm ownership
          // rather than compare against another user's row.
          const clash = !!prev && prev.owner === owner && !isContinuationOf(stripOwner(prev), c);
          if (clash && !opts?.force) {
            conflicted.push(c.id);
            return false; // never overwrite silently — the operator decides
          }
          return true;
        });
        if (!toWrite.length) return { written, conflicted };
        // IndexedDB's structured clone can't clone Vue reactive proxies — unwrap
        // to plain objects first (the JSON round-trip the localStorage impl used).
        const plain = JSON.parse(JSON.stringify(toWrite)) as Conversation[];
        const tx = db.transaction(STORE, 'readwrite');
        const s = tx.objectStore(STORE);
        for (const c of plain) s.put({ ...c, owner });
        await txDone(tx);
        written.push(...plain.map((c) => c.id));
        return { written, conflicted };
      } catch {
        /* degrade: this write just won't persist */
        return { written, conflicted };
      }
    },
    async enforceBudget(owner) {
      const db = await openDb();
      if (!db || maxBytes <= 0) return [];
      try {
        const rows = await reqToPromise<StoredConversation[]>(
          db.transaction(STORE, 'readonly').objectStore(STORE).index('owner').getAll(owner),
        );
        const keep = new Set(capToBytes(rows.map(stripOwner), maxBytes).map((c) => c.id));
        const evicted = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
        if (!evicted.length) return [];
        const tx = db.transaction(STORE, 'readwrite');
        const s = tx.objectStore(STORE);
        for (const id of evicted) s.delete(id);
        await txDone(tx);
        return evicted;
      } catch {
        return [];
      }
    },
    async remove(owner, id) {
      const db = await openDb();
      if (!db) return;
      try {
        const rec = await reqToPromise<StoredConversation | undefined>(
          db.transaction(STORE, 'readonly').objectStore(STORE).get(id),
        );
        if (!rec || rec.owner !== owner) return;
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        await txDone(tx);
      } catch {
        /* ignore */
      }
    },
    async clear(owner) {
      const db = await openDb();
      if (!db) return;
      try {
        const ids = await reqToPromise<IDBValidKey[]>(
          db.transaction(STORE, 'readonly').objectStore(STORE).index('owner').getAllKeys(owner),
        );
        const tx = db.transaction(STORE, 'readwrite');
        const s = tx.objectStore(STORE);
        for (const id of ids) s.delete(id);
        await txDone(tx);
      } catch {
        /* ignore */
      }
    },
    async usageBytes(owner) {
      const db = await openDb();
      if (!db) return 0;
      try {
        const tx = db.transaction(STORE, 'readonly');
        const rows = await reqToPromise<StoredConversation[]>(tx.objectStore(STORE).index('owner').getAll(owner));
        return rows.reduce((n, r) => n + sizeOf(stripOwner(r)), 0);
      } catch {
        return 0;
      }
    },
  };
}

export const noopHistory: HistoryStore = {
  async load() {
    return [];
  },
  async upsert() {
    return { written: [], conflicted: [] };
  },
  async loadOne() {
    return null;
  },
  async enforceBudget() {
    return [];
  },
  async remove() {},
  async clear() {},
  async usageBytes() {
    return 0;
  },
};

export function createHistoryStore(mode: HistoryMode, opts: { maxBytes: number }): HistoryStore {
  switch (mode) {
    case 'client':
      return indexedDbHistory(opts.maxBytes);
    default:
      return noopHistory; // server store not built yet
  }
}

// Whether client persistence is on, per user (its own key — it can't live in the
// store it gates, and must not leak across users on a shared browser). Default ON.
export function historyEnabledPref(owner: string): boolean {
  try {
    return localStorage.getItem(ENABLED_PREFIX + owner) !== '0';
  } catch {
    return true;
  }
}
export function setHistoryEnabledPref(owner: string, on: boolean): void {
  try {
    localStorage.setItem(ENABLED_PREFIX + owner, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
