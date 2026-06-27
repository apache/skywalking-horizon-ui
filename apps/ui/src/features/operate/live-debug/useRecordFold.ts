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
 * Per-record fold state for a debugger waterfall. Each captured source
 * row / record is independently collapsible; `fold all` / `expand all`
 * drive the whole set from the subhead.
 *
 * Fold keys are `(nodeKey, index)` strings so the same record stays
 * folded across polls (the node's identity, not its array position,
 * keys the set). The caller supplies an `enumerate()` that walks the
 * current view model and emits every `(nodeKey, index)` pair — the
 * composable derives the total count + `fold all` target from it.
 *
 * No lifecycle to tear down — a `ref<Set>` plus derived `computed`s,
 * GC'd with the owning component.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';

export interface RecordFoldCoord {
  nodeKey: string;
  index: number;
}

export interface RecordFold {
  foldedRecords: Ref<Set<string>>;
  isRecordFolded: (nKey: string, idx: number) => boolean;
  toggleRecord: (nKey: string, idx: number) => void;
  foldAllRecords: () => void;
  expandAllRecords: () => void;
  totalRecordCount: ComputedRef<number>;
  allFolded: ComputedRef<boolean>;
}

function recordFoldKey(nKey: string, idx: number): string {
  return `${nKey}#${idx}`;
}

export function useRecordFold(enumerate: () => RecordFoldCoord[]): RecordFold {
  const foldedRecords = ref<Set<string>>(new Set());

  function isRecordFolded(nKey: string, idx: number): boolean {
    return foldedRecords.value.has(recordFoldKey(nKey, idx));
  }

  function toggleRecord(nKey: string, idx: number): void {
    const k = recordFoldKey(nKey, idx);
    const next = new Set(foldedRecords.value);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    foldedRecords.value = next;
  }

  function foldAllRecords(): void {
    const next = new Set<string>();
    for (const { nodeKey, index } of enumerate()) next.add(recordFoldKey(nodeKey, index));
    foldedRecords.value = next;
  }

  function expandAllRecords(): void {
    foldedRecords.value = new Set();
  }

  const totalRecordCount = computed<number>(() => enumerate().length);

  const allFolded = computed<boolean>(
    () => totalRecordCount.value > 0 && foldedRecords.value.size === totalRecordCount.value,
  );

  return {
    foldedRecords,
    isRecordFolded,
    toggleRecord,
    foldAllRecords,
    expandAllRecords,
    totalRecordCount,
    allFolded,
  };
}
