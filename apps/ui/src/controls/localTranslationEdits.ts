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
 * Browser-side TEMP store for in-progress translation-overlay drafts.
 *
 * Per-locale per-template — keyed by `<sourceName>:<locale>` so two
 * operators (or one operator switching between locales) don't smear
 * each other's work. Mirrors the OAP storage shape after the split:
 * one source row + N overlay rows per template, one localStorage
 * slot per row.
 *
 * Separate from {@link useLocalTemplateEdits} because the value here
 * is an overlay map (source-shape mirror, leaves are the translation
 * strings) — NOT a full source template. Consumers that iterate the
 * other store assume source content; mixing the two would break them.
 *
 * Lifecycle:
 *   - Operator types in the Translations editor → in-memory draft.
 *   - Operator clicks "Stage local" → set(name, locale, overlay).
 *   - Operator clicks "Push to OAP" → saveTranslation succeeds →
 *     remove(name, locale).
 *   - Local drafts survive page reloads but never reach other users.
 */

import { ref, computed, type ComputedRef } from 'vue';

const STORAGE_KEY = 'horizon:localTranslationEdits:v1';

interface PerLocaleMap {
  [locale: string]: unknown;
}
type EditMap = Record<string, PerLocaleMap>;

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

export interface UseLocalTranslationEdits {
  edits: typeof edits;
  /** Count of (name, locale) pairs across every template. */
  count: ComputedRef<number>;
  has: (name: string, locale: string) => boolean;
  get: <T = unknown>(name: string, locale: string) => T | undefined;
  set: (name: string, locale: string, overlay: unknown) => void;
  /** Remove a single (name, locale) draft, or every locale of a template
   *  when `locale` is omitted. */
  remove: (name: string, locale?: string) => void;
  /** All (name, locale) pairs with a draft. */
  pairs: () => Array<{ name: string; locale: string }>;
  /** Locales drafted for one template. */
  localesFor: (name: string) => string[];
}

export function useLocalTranslationEdits(): UseLocalTranslationEdits {
  return {
    edits,
    count: computed(() =>
      Object.values(edits.value).reduce((n, m) => n + Object.keys(m).length, 0),
    ),
    has: (name, locale) =>
      Object.prototype.hasOwnProperty.call(edits.value, name) &&
      Object.prototype.hasOwnProperty.call(edits.value[name] ?? {}, locale),
    get: <T = unknown>(name: string, locale: string) =>
      (edits.value[name]?.[locale] as T | undefined),
    set: (name, locale, overlay) => {
      const tplMap = { ...(edits.value[name] ?? {}) };
      tplMap[locale] = overlay;
      edits.value = { ...edits.value, [name]: tplMap };
      persist();
    },
    remove: (name, locale) => {
      if (!Object.prototype.hasOwnProperty.call(edits.value, name)) return;
      if (locale === undefined) {
        const next = { ...edits.value };
        delete next[name];
        edits.value = next;
      } else {
        const tplMap = { ...(edits.value[name] ?? {}) };
        if (!Object.prototype.hasOwnProperty.call(tplMap, locale)) return;
        delete tplMap[locale];
        const next = { ...edits.value };
        if (Object.keys(tplMap).length === 0) delete next[name];
        else next[name] = tplMap;
        edits.value = next;
      }
      persist();
    },
    pairs: () => {
      const out: Array<{ name: string; locale: string }> = [];
      for (const [name, tplMap] of Object.entries(edits.value)) {
        for (const locale of Object.keys(tplMap)) out.push({ name, locale });
      }
      return out;
    },
    localesFor: (name) => Object.keys(edits.value[name] ?? {}),
  };
}
