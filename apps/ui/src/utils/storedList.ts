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

function store(key: string, parts: readonly string[]): boolean {
  try {
    localStorage.setItem(key, `[${parts.join(',')}]`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Store a list, newest first, under one localStorage key. Over the quota, it keeps what fits: each item that fits
 * beside the newer ones kept, else the copy of it stored before when that fits, so an item that grew too large keeps
 * its last stored copy and costs no other item. When nothing fits, the stored items the list dropped still go.
 *
 * @param key        the localStorage key
 * @param items      the list, newest first
 * @param idOf       an item's id, the same across its versions
 * @param readStored the list as stored now
 * @returns the ids of the items stored as they are now; an item left out may still have an older copy stored
 */
export function storeWhatFits<T>(
  key: string,
  items: readonly T[],
  idOf: (item: T) => string,
  readStored: () => T[],
): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  // Each item is serialised once: a debugger capture can run to megabytes.
  const parts = items.map((item) => JSON.stringify(item));
  if (store(key, parts)) return new Set(items.map(idOf));
  // Read before the writes below replace it.
  const stored = readStored();
  const storedParts = new Map(stored.map((item) => [idOf(item), JSON.stringify(item)]));
  const current = new Set<string>();
  const chosen: string[] = [];
  items.forEach((item, i) => {
    const part = parts[i]!;
    if (store(key, [...chosen, part])) {
      chosen.push(part);
      current.add(idOf(item));
      return;
    }
    const older = storedParts.get(idOf(item));
    if (older !== undefined && older !== part && store(key, [...chosen, older])) chosen.push(older);
  });
  if (chosen.length > 0) return current;
  const kept = new Set(items.map(idOf));
  const left = stored.filter((item) => kept.has(idOf(item)));
  if (left.length !== stored.length) store(key, left.map((item) => JSON.stringify(item)));
  return current;
}
