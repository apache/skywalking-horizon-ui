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


/**
 * Guarantee a working `localStorage` for every test file.
 *
 * jsdom installs one per environment, and the environment is torn down and
 * rebuilt between files. Under heavy parallel load — the three workspace suites
 * at once, straight after both app builds, which is exactly what the release
 * script does — a file has been observed running against a global whose Storage
 * methods were already gone: `TypeError: localStorage.clear is not a function`,
 * in all four files that touch it at once. It reproduced once in a release and
 * not in a dozen repeat runs, so it is a timing race, not a defect in those
 * tests.
 *
 * Installing a Storage when the ambient one is unusable removes the dependency
 * on that timing. It is deliberately NOT unconditional: when jsdom's own
 * Storage is present the tests keep exercising the real thing.
 */

import { beforeEach } from 'vitest';

function usable(store: unknown): boolean {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof (store as Storage).clear === 'function' &&
    typeof (store as Storage).getItem === 'function' &&
    typeof (store as Storage).setItem === 'function'
  );
}

/** A Storage with the same observable behaviour as the browser's, including
 *  the string coercion the real one performs. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(String(k)) ? map.get(String(k))! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(String(k)),
    setItem: (k: string, v: string) => void map.set(String(k), String(v)),
  } as Storage;
}

function ensureStorage(name: 'localStorage' | 'sessionStorage'): void {
  const current = (globalThis as Record<string, unknown>)[name];
  if (usable(current)) return;
  Object.defineProperty(globalThis, name, {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });
}

ensureStorage('localStorage');
ensureStorage('sessionStorage');
beforeEach(() => {
  ensureStorage('localStorage');
  ensureStorage('sessionStorage');
});
