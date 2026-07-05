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

// Conversation history in localStorage — swap the HistoryStore impl for a DB later.
// Prune to newest MAX_CONVERSATIONS, then drop oldest until under the ~5MB budget.
import type { Conversation } from './types';

export interface HistoryStore {
  load(): Conversation[];
  save(conversations: Conversation[]): void;
}

const KEY = 'sw.ai.history.v1';
const MAX_CONVERSATIONS = 30;
const MAX_BYTES = 4 * 1024 * 1024;

function prune(conversations: Conversation[]): Conversation[] {
  // newest first, cap count, then cap total size
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
  let json = JSON.stringify(sorted);
  while (sorted.length > 1 && json.length > MAX_BYTES) {
    sorted.pop();
    json = JSON.stringify(sorted);
  }
  return sorted;
}

export const localStorageHistory: HistoryStore = {
  load(): Conversation[] {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Conversation[]) : [];
    } catch {
      return [];
    }
  },
  save(conversations: Conversation[]): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(prune(conversations)));
    } catch {
      /* quota exceeded / storage disabled: history just won't persist this session */
    }
  },
};

export const HISTORY_KEY = KEY;
