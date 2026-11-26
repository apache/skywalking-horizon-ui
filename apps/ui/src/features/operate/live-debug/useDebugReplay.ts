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
import { useRoute, useRouter, type RouteLocationNormalizedLoaded, type Router } from 'vue-router';
import { isDebugCatalog, isGranularity, type Granularity, type SessionResponse } from '@skywalking-horizon-ui/api-client';
import type { CaptureSettings, UseDebugSessionResult } from './useDebugSession.js';
import type { DebugHistoryHandle, DebugWidget, HistoryEntry } from './useDebugHistory.js';
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
  /** The picker's granularity, for a view that offers one; saved with the
   *  capture and restored with it. */
  granularity?: Ref<Granularity>;
  /** Stable widget key persisted on saved entries. */
  widget: HistoryEntry['widget'];
}

export interface DebugReplay {
  historicalEntry: ShallowRef<HistoryEntry | null>;
  displaySession: ComputedRef<SessionResponse | null>;
  clearHistorical: () => void;
  /** What the capture on screen was started with: the saved one's, or the live one's; null before any. */
  shownMeta: ComputedRef<CaptureMeta | null>;
}

/** The settings a saved capture ran with, to resume it with; null for an entry whose catalog is not one OAP debugs. */
export function settingsOf(entry: HistoryEntry): CaptureSettings | null {
  if (!isDebugCatalog(entry.catalog)) return null;
  return {
    catalog: entry.catalog,
    name: entry.name,
    ruleName: entry.ruleName,
    ...(isGranularity(entry.granularity) ? { granularity: entry.granularity } : {}),
    ...(entry.recordCap !== undefined ? { recordCap: entry.recordCap } : {}),
    ...(entry.retentionMillis !== undefined ? { retentionMillis: entry.retentionMillis } : {}),
  };
}

/** Save the live capture in Capture history, under its session id and the settings it runs with, whichever capture
 *  is on screen. Each tab calls it as its session changes. */
export function saveLiveCapture(dbg: UseDebugSessionResult, history: DebugHistoryHandle, widget: DebugWidget): void {
  const id = dbg.sessionId.value;
  const settings = dbg.startedWith.value;
  if (!id || !settings || !settings.name || !settings.ruleName) return;
  // Findable from the moment OAP gives the capture its id, before its first read.
  const sess: SessionResponse = dbg.session.value ?? { sessionId: id, capturedAt: Date.now(), nodes: [] };
  history.save({
    widget,
    catalog: settings.catalog,
    name: settings.name,
    ruleName: settings.ruleName,
    granularity: settings.granularity,
    recordCap: settings.recordCap,
    retentionMillis: settings.retentionMillis,
    retentionDeadline: dbg.retentionDeadline.value ?? undefined,
    recordCount: sess.nodes.reduce((n, x) => n + (x.records?.length ?? 0), 0),
    nodeCount: sess.nodes.length,
    session: sess,
  });
}

/** Leave the address of the capture on screen, saved (`historyId`) or resumed (`resumeSessionId`): a reload then opens
 *  the tab, not that capture again. Every tab's way out of a capture — back to live, or a start — goes through it. */
export function forgetCaptureAddress(router: Router, route: RouteLocationNormalizedLoaded): void {
  if (route.query.historyId === undefined && route.query.resumeSessionId === undefined) return;
  const { historyId: _saved, resumeSessionId: _resumed, ...query } = route.query;
  void router.replace({ path: route.path, query });
}

/** Whether the address is the given tab's. The tabs stay mounted while another shows (`KeepAlive`) and all watch the
 *  one route, so a deep link — a capture to resume or open, a rule to pick — is taken only by the tab it names. */
export function routeIsTab(route: RouteLocationNormalizedLoaded, tab: DebugWidget): boolean {
  return ((route.params.tab as string | undefined) || 'mal') === tab;
}

export function useDebugReplay(opts: DebugReplayOptions): DebugReplay {
  const { dbg, history, name, ruleName, recordCap, retentionMinutes, granularity, widget } = opts;
  const route = useRoute();
  const router = useRouter();

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
    if (granularity && (entry.granularity === 'block' || entry.granularity === 'statement')) {
      granularity.value = entry.granularity;
    }
  }

  function loadHistorical(entry: HistoryEntry): void {
    historicalEntry.value = entry;
    applyEntryPicker(entry);
  }

  function clearHistorical(): void {
    historicalEntry.value = null;
    forgetCaptureAddress(router, route);
  }

  /** What the live capture runs with. */
  const liveMeta = computed<CaptureMeta | null>(() => {
    const settings = dbg.startedWith.value;
    if (settings === null) return null;
    return {
      name: settings.name,
      ruleName: settings.ruleName,
      granularity: settings.granularity,
      recordCap: settings.recordCap,
      retentionMillis: settings.retentionMillis,
    };
  });

  /** What the capture on screen was started with: the saved one's, or the live one's. */
  const shownMeta = computed<CaptureMeta | null>(() => {
    const entry = historicalEntry.value;
    if (entry === null) return liveMeta.value;
    return {
      name: entry.name,
      ruleName: entry.ruleName,
      granularity: entry.granularity === 'block' || entry.granularity === 'statement' ? entry.granularity : undefined,
      recordCap: entry.recordCap,
      retentionMillis: entry.retentionMillis,
    };
  });

  watch(
    () => [dbg.sessionId.value, dbg.session.value, dbg.retentionDeadline.value] as const,
    () => saveLiveCapture(dbg, history, widget),
  );

  // The tab is watched too: a deep link is taken when its tab becomes the one the address names.
  watch(
    () => [route.params.tab, route.query.resumeSessionId] as const,
    ([, id]) => {
      if (typeof id !== 'string' || id === '' || !routeIsTab(route, widget)) return;
      if (dbg.sessionId.value === id) return;
      // Cross-widget lookup (`history.all`) — the check above pinned the
      // route to this tab, so filtering again by widget would silently
      // swallow entries with a mismatched widget field.
      const entry = history.all.value.find((e) => e.session.sessionId === id);
      if (!entry) return;
      applyEntryPicker(entry);
      dbg.resume(id, entry.retentionDeadline ?? null, entry.session, settingsOf(entry));
    },
    { immediate: true },
  );

  watch(
    () => [route.params.tab, route.query.historyId] as const,
    ([, id]) => {
      if (typeof id !== 'string' || id === '') {
        // Only this tab's view: the address is the one the route moved to, maybe another tab's to keep.
        historicalEntry.value = null;
        return;
      }
      if (historicalEntry.value?.id === id || !routeIsTab(route, widget)) return;
      const entry = history.all.value.find((e) => e.id === id);
      if (entry) loadHistorical(entry);
    },
    { immediate: true },
  );

  return { historicalEntry, displaySession, clearHistorical, shownMeta };
}

/** What a capture was started with. */
export interface CaptureMeta {
  name: string;
  ruleName: string;
  granularity?: Granularity;
  recordCap?: number;
  retentionMillis?: number;
}
