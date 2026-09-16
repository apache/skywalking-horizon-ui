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
 * What a view holds of the provider bodies: one store per session, and the read in flight.
 *
 * A body refers to bodies and pieces that landed before it, so a session's files are loaded in seq
 * order and kept. Opening a later call then loads only the files after the ones already held, and
 * moving back to an earlier call loads nothing at all.
 */

import { PromptStore, type StoredFile } from './store.js';

/** How a read ended, for the words the panel shows. */
export interface LoadOutcome {
  /** The seqs asked for and not answered: the OAP leaves out what it does not store. */
  missing: number[];
  /**
   * The seqs answered but still not held: their records refer to a file that is not there, so the store
   * kept none of them. Asking again brings the same bytes and the same answer, so the panel must not
   * offer the read again - but a later read that brings the missing file makes them readable, which is
   * why they are named apart from the ones the server never sent.
   */
  unresolved: number[];
  /** Why the read stopped early, when it did. */
  failed?: string;
}

export class PromptCache {
  private readonly stores = new Map<string, PromptStore>();
  private readonly outcomes = new Map<string, LoadOutcome>();
  private running: { key: string; controller: AbortController } | null = null;

  store(session: string): PromptStore {
    let s = this.stores.get(session);
    if (!s) {
      s = new PromptStore();
      this.stores.set(session, s);
    }
    return s;
  }

  outcome(session: string): LoadOutcome | null {
    return this.outcomes.get(session) ?? null;
  }

  /** Whether a read is in flight for that session. */
  reading(session: string): boolean {
    return this.running?.key === session;
  }

  /**
   * Loads the files of a session up to and including `throughSeq`, skipping what is held, at most
   * `batch` seqs a request, and tells `onProgress` after each file. One read runs at a time: starting
   * another ends the one before it, as a reader who moves on has stopped waiting for it.
   */
  async load(
    session: string,
    seqs: number[],
    loader: (request: { session: string; seqs: number[]; signal: AbortSignal }, onFile: (file: StoredFile) => void) => Promise<void>,
    batch: number,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<LoadOutcome> {
    this.running?.controller.abort();
    const controller = new AbortController();
    this.running = { key: session, controller };
    const store = this.store(session);
    const want = seqs.filter((seq) => !store.has(seq)).sort((a, b) => a - b);
    const outcome: LoadOutcome = { missing: [], unresolved: [] };
    let loaded = 0;
    try {
      for (let at = 0; at < want.length; at += batch) {
        const asked = want.slice(at, at + batch);
        const answered = new Set<number>();
        await loader({ session, seqs: asked, signal: controller.signal }, (file) => {
          // in seq order, as the route answers, so a body's earlier bodies are held before it
          store.addFile(file);
          answered.add(file.seq);
          loaded++;
          onProgress(loaded, want.length);
        });
        for (const seq of asked) {
          if (!answered.has(seq)) {
            outcome.missing.push(seq);
          } else if (!store.has(seq)) {
            outcome.unresolved.push(seq);
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) throw err;
      outcome.failed = err instanceof Error ? err.message : String(err);
    } finally {
      if (this.running?.controller === controller) this.running = null;
    }
    this.outcomes.set(session, outcome);
    return outcome;
  }

  /** Ends any read in flight, as a view being destroyed must. */
  stop(): void {
    this.running?.controller.abort();
    this.running = null;
  }
}
