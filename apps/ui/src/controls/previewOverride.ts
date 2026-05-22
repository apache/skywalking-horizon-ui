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
 * Per-template "preview this exact content" override, used by the admin's
 * Preview dropdown to render ANY source (local / bundled / remote) on the
 * real page. The admin writes the chosen source's content here, then opens
 * the live page in a new tab with `?mode=preview`; the config bundle
 * overlay reads this override (taking precedence over the local draft).
 *
 * Stored in localStorage — NOT sessionStorage — because the preview opens
 * in a new tab, which does not share sessionStorage. Keyed by the canonical
 * template name (`horizon.layer.<KEY>` / `horizon.overview.<id>`).
 */

import { ref } from 'vue';

const STORAGE_KEY = 'horizon:previewOverride:v1';
type OverrideMap = Record<string, unknown>;

function read(): OverrideMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as OverrideMap;
  } catch {
    return {};
  }
}

const overrides = ref<OverrideMap>(read());

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides.value));
  } catch {
    /* quota / disabled — in-memory copy still works for this tab */
  }
}

export function usePreviewOverride(): {
  get: <T = unknown>(name: string) => T | undefined;
  set: (name: string, content: unknown) => void;
  clear: (name: string) => void;
  names: () => string[];
} {
  return {
    names: () => Object.keys(overrides.value),
    get: <T = unknown>(name: string) => overrides.value[name] as T | undefined,
    set: (name, content) => {
      overrides.value = { ...overrides.value, [name]: content };
      persist();
    },
    clear: (name) => {
      if (!Object.prototype.hasOwnProperty.call(overrides.value, name)) return;
      const next = { ...overrides.value };
      delete next[name];
      overrides.value = next;
      persist();
    },
  };
}
