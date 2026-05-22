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
 * Browser-side TEMP store for in-progress dashboard-template edits.
 *
 * An operator's edit is a *local draft* that lives only in this browser
 * (localStorage) until they explicitly push it to OAP. It is NOT written
 * to the BFF's on-disk bundled files (those stay the pristine shipped
 * defaults) and it is NOT shared with other users. The config bundle
 * overlays these drafts on top of the remote/bundled content so the
 * editing operator previews their own edits on live pages; everyone else
 * keeps seeing remote.
 *
 * Keyed by the canonical template name the sync layer uses:
 *   `horizon.layer.<KEY>`  /  `horizon.overview.<id>`
 *
 * Push-to-remote clears the entry (it's now the live version); reset-to-
 * bundled also clears it (the operator abandoned the draft).
 */

import { ref, computed, type ComputedRef } from 'vue';

const STORAGE_KEY = 'horizon:localTemplateEdits:v1';

type EditMap = Record<string, unknown>;

function read(): EditMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as EditMap) : {};
  } catch {
    return {};
  }
}

const edits = ref<EditMap>(read());

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(edits.value));
  } catch {
    /* quota / disabled — in-memory copy still works for this session */
  }
}

/** Canonical name builders — match the sync layer's `horizon.<kind>.<key>`. */
export function layerEditName(key: string): string {
  return `horizon.layer.${key.toUpperCase()}`;
}
export function overviewEditName(id: string): string {
  return `horizon.overview.${id}`;
}

export function useLocalTemplateEdits(): {
  /** Reactive map of name → draft content. */
  edits: typeof edits;
  /** Count of unpushed drafts (drives badges / the conflict prompt). */
  count: ComputedRef<number>;
  has: (name: string) => boolean;
  get: <T = unknown>(name: string) => T | undefined;
  set: (name: string, content: unknown) => void;
  remove: (name: string) => void;
  names: () => string[];
} {
  return {
    edits,
    count: computed(() => Object.keys(edits.value).length),
    has: (name) => Object.prototype.hasOwnProperty.call(edits.value, name),
    get: <T = unknown>(name: string) => edits.value[name] as T | undefined,
    set: (name, content) => {
      edits.value = { ...edits.value, [name]: content };
      persist();
    },
    remove: (name) => {
      if (!Object.prototype.hasOwnProperty.call(edits.value, name)) return;
      const next = { ...edits.value };
      delete next[name];
      edits.value = next;
      persist();
    },
    names: () => Object.keys(edits.value),
  };
}
