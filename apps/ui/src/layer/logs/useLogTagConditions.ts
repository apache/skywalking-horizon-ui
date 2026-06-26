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
 * Tag + level filter state for the Logs conditions bar.
 *
 * Tags are booster-style: one `key=value` text input, Enter commits a
 * chip into `customTags`, and the chips ride along on the OAP log query
 * as filters.
 *
 * The level filter goes to OAP as a `level=<UPPER>` tag filter so the
 * server-side total + pagination match the visible rows; it's
 * single-select (booster-ui uses the same pattern). `allTags` merges the
 * custom chips with the active level chip — that's what the query consumes.
 *
 * Editing any condition resets `page` to 1 (the host owns paging and
 * passes its ref in).
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { LogTagFilter } from '@/api/client';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_TAG_VALUES: Record<LogLevel, string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  debug: 'DEBUG',
};

export interface LogTagConditions {
  tagInput: Ref<string>;
  customTags: Ref<LogTagFilter[]>;
  selectedLevel: Ref<LogLevel | null>;
  allTags: ComputedRef<LogTagFilter[]>;
  addTagFilter: () => void;
  removeTagFilter: (i: number) => void;
  toggleLevel: (l: LogLevel | 'other') => void;
}

export function useLogTagConditions(page: Ref<number>): LogTagConditions {
  const tagInput = ref('');
  const customTags = ref<LogTagFilter[]>([]);
  const selectedLevel = ref<LogLevel | null>(null);

  function addTagFilter(): void {
    const raw = tagInput.value.trim();
    if (!raw || !raw.includes('=')) return;
    const idx = raw.indexOf('=');
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!key) return;
    if (customTags.value.some((t) => t.key === key && t.value === value)) return;
    customTags.value = [...customTags.value, { key, value }];
    tagInput.value = '';
    page.value = 1;
  }
  function removeTagFilter(i: number): void {
    customTags.value = customTags.value.filter((_, idx) => idx !== i);
    page.value = 1;
  }

  const allTags = computed<LogTagFilter[]>(() => {
    const out = [...customTags.value];
    if (selectedLevel.value) {
      out.push({ key: 'level', value: LEVEL_TAG_VALUES[selectedLevel.value] });
    }
    return out;
  });

  function toggleLevel(l: LogLevel | 'other'): void {
    if (l === 'other') return; // server-side has no canonical value for "other"
    selectedLevel.value = selectedLevel.value === l ? null : l;
    page.value = 1;
  }

  return {
    tagInput,
    customTags,
    selectedLevel,
    allTags,
    addTagFilter,
    removeTagFilter,
    toggleLevel,
  };
}
