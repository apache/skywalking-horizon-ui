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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from './useDebugHistory';
import { writeAll } from './useDebugHistory';

const KEY = 'vs:debug-history:v1';

const entry = (id: string, widget: HistoryEntry['widget'], padding = 0): HistoryEntry => ({
  id,
  savedAt: 1,
  widget,
  catalog: widget,
  name: 'f',
  ruleName: 'r',
  recordCount: 1,
  nodeCount: 1,
  session: { sessionId: id, capturedAt: 1, nodes: [{ status: 'ok', records: [], detail: 'x'.repeat(padding) }] },
});

/** A storage that refuses any value longer than `limit` characters. */
function storageLimitedTo(limit: number): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => {
      if (v.length > limit) throw new DOMException('quota', 'QuotaExceededError');
      items.set(k, v);
    },
  };
}

describe('writeAll', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = storageLimitedTo(2_000);
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  const stored = (): string[] => (JSON.parse(storage.getItem(KEY) ?? '[]') as HistoryEntry[]).map((e) => e.id);

  it('drops the oldest captures until the newest fits', () => {
    writeAll([entry('new', 'tal', 600), entry('mid', 'lal', 600), entry('old', 'mal', 600)]);
    expect(stored()).toEqual(['new', 'mid']);
  });

  it('keeps every saved capture when the newest alone is too large to store', () => {
    writeAll([entry('a', 'lal'), entry('b', 'oal')]);
    writeAll([entry('huge', 'tal', 5_000), entry('a', 'lal'), entry('b', 'oal')]);
    expect(stored()).toEqual(['a', 'b']);
  });

  it('keeps the older captures beside a new one while a capture too large to store sits between them', () => {
    writeAll([entry('a', 'lal'), entry('b', 'oal')]);
    writeAll([entry('small', 'mal'), entry('huge', 'tal', 5_000), entry('a', 'lal'), entry('b', 'oal')]);
    expect(stored()).toEqual(['small', 'a', 'b']);
  });

  it('still saves the removal of the last capture that fits, with only a capture too large to store left', () => {
    writeAll([entry('a', 'lal')]);
    writeAll([entry('huge', 'tal', 5_000)]);
    expect(stored()).toEqual([]);
  });

  it('keeps a capture’s last stored copy when it grows too large to store', () => {
    writeAll([entry('grow', 'tal', 200), entry('a', 'lal')]);
    const before = storage.getItem(KEY)!;
    writeAll([entry('grow', 'tal', 5_000), entry('a', 'lal')]);
    expect(stored()).toEqual(['grow', 'a']);
    expect(storage.getItem(KEY), 'the copy that fit').toBe(before);
  });

  it('still saves a removal while the newest capture is too large to store', () => {
    writeAll([entry('a', 'lal'), entry('b', 'oal')]);
    writeAll([entry('huge', 'tal', 5_000), entry('a', 'lal')]);
    expect(stored()).toEqual(['a']);
  });
});
