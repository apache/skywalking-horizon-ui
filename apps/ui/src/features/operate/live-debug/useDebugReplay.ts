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
 * Deep-link + session-restore wiring for a live-debugger view.
 *
 * Folds together three behaviours that all hang off the route query
 * and the shared history store:
 *   - `?historyId=` — render a frozen past capture (read-only replay).
 *   - `?resumeSessionId=` — re-attach to a still-live OAP session a
 *     prior tab started (polling resumes without re-installing).
 *   - auto-persist — every poll while live saves a history snapshot so
 *     the capture survives a reload / cross-tab deep-link.
 *
 * The picker refs (`name` / `ruleName` / `recordCap` /
 * `retentionMinutes`) are written back when a historical entry or a
 * resumable session is loaded, so the controls reflect what's on
 * screen. `displaySession` is the single source the view renders from —
 * the historical snapshot when one is loaded, the live session
 * otherwise.
 *
 * No lifecycle to tear down beyond the watchers, which Vue stops with
 * the owning component's scope.
 */

import { computed, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import { useRoute } from 'vue-router';
import type { SessionResponse } from '@skywalking-horizon-ui/api-client';
import type { UseDebugSessionResult } from './useDebugSession.js';
import type { DebugHistoryHandle, HistoryEntry } from './useDebugHistory.js';
import { MS_PER_MINUTE } from './constants.js';

export interface DebugReplayOptions {
  dbg: UseDebugSessionResult;
  history: DebugHistoryHandle;
  /** The picker's `name` ref (the .oal file / dispatcher file). */
  name: Ref<string>;
  /** The picker's `ruleName` ref (the metric / rule name). */
  ruleName: Ref<string>;
  recordCap: Ref<number>;
  retentionMinutes: Ref<number>;
  /** Stable widget key persisted on saved entries. */
  widget: HistoryEntry['widget'];
}

export interface DebugReplay {
  historicalEntry: ShallowRef<HistoryEntry | null>;
  displaySession: ComputedRef<SessionResponse | null>;
  clearHistorical: () => void;
}

export function useDebugReplay(opts: DebugReplayOptions): DebugReplay {
  const { dbg, history, name, ruleName, recordCap, retentionMinutes, widget } = opts;
  const route = useRoute();

  const historicalEntry = shallowRef<HistoryEntry | null>(null);

  const displaySession = computed<SessionResponse | null>(
    () => historicalEntry.value?.session ?? dbg.session.value,
  );

  function applyEntryPicker(entry: HistoryEntry): void {
    name.value = entry.name;
    ruleName.value = entry.ruleName;
    if (entry.recordCap !== undefined) recordCap.value = entry.recordCap;
    if (entry.retentionMillis !== undefined) {
      retentionMinutes.value = Math.max(1, Math.round(entry.retentionMillis / MS_PER_MINUTE));
    }
  }

  function loadHistorical(entry: HistoryEntry): void {
    historicalEntry.value = entry;
    applyEntryPicker(entry);
  }

  function clearHistorical(): void {
    historicalEntry.value = null;
  }

  function persistCapture(): void {
    if (historicalEntry.value !== null) return;
    const id = dbg.sessionId.value;
    if (!id || !name.value || !ruleName.value) return;
    const sess: SessionResponse = dbg.session.value ?? {
      sessionId: id,
      capturedAt: Date.now(),
      nodes: [],
    };
    history.save({
      widget,
      catalog: widget,
      name: name.value,
      ruleName: ruleName.value,
      recordCap: recordCap.value,
      retentionMillis: retentionMinutes.value * MS_PER_MINUTE,
      retentionDeadline: dbg.retentionDeadline.value ?? undefined,
      recordCount: sess.nodes.reduce((n, x) => n + (x.records?.length ?? 0), 0),
      nodeCount: sess.nodes.length,
      session: sess,
    });
  }

  watch(
    () => [dbg.sessionId.value, dbg.session.value, dbg.retentionDeadline.value] as const,
    () => persistCapture(),
  );

  watch(
    () => route.query.resumeSessionId,
    (id) => {
      if (typeof id !== 'string' || id === '') return;
      if (dbg.sessionId.value === id) return;
      // Cross-widget lookup (`history.all`) — routing already pinned us
      // to the right widget, so filtering again by widget would silently
      // swallow entries with a mismatched widget field.
      const entry = history.all.value.find((e) => e.session.sessionId === id);
      if (!entry) return;
      applyEntryPicker(entry);
      dbg.resume(id, entry.retentionDeadline ?? null);
    },
    { immediate: true },
  );

  watch(
    () => route.query.historyId,
    (id) => {
      if (typeof id !== 'string' || id === '') {
        if (historicalEntry.value !== null) clearHistorical();
        return;
      }
      if (historicalEntry.value?.id === id) return;
      const entry = history.all.value.find((e) => e.id === id);
      if (entry) loadHistorical(entry);
    },
    { immediate: true },
  );

  return { historicalEntry, displaySession, clearHistorical };
}
