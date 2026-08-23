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
 * State for the login audit page: the statistics block, the filters and the
 * list, which are three independent queries against one screen.
 */

import { computed, ref } from 'vue';
import { bff } from '@/api/client';
import type {
  AuditEntry,
  AuditHealth,
  AuditKind,
  AuditQuery,
  AuditStatResult,
  AuditStatWindow,
} from '@/api/scopes/admin-audit';

const PAGE_SIZE = 50;

/** The whole retention window — the page's default, and what "no range" means. */
export const ALL_TIME = 0;
/** Same sentinel the trace conditions use for "pick the two ends yourself". */
export const CUSTOM_RANGE_SENTINEL = -1;

export interface AuditFilters {
  username: string;
  /** One kind or none — the wire takes a list, but the page offers a single
   *  choice, so an empty string is "all". */
  kind: AuditKind | '';
  /** A rolling window in minutes, `ALL_TIME`, or `CUSTOM_RANGE_SENTINEL`. */
  windowMinutes: number;
  /** `datetime-local` text, browser-local. Only read in custom mode, and
   *  populated when that mode is entered, so the field always carries a value
   *  rather than the browser's own placeholder. */
  customStart: string | null;
  customEnd: string | null;
}

function emptyFilters(): AuditFilters {
  return { username: '', kind: '', windowMinutes: ALL_TIME, customStart: null, customEnd: null };
}

/** `epochMs → 'YYYY-MM-DDTHH:mm'`, the only shape `datetime-local` accepts.
 *  Browser-local, which is also how the list renders timestamps. */
export function toLocalInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The bounds a filter selects, or the complaint that stops the query. */
function rangeOf(f: AuditFilters): { from?: number; to?: number } | string {
  if (f.windowMinutes === ALL_TIME) return {};
  if (f.windowMinutes !== CUSTOM_RANGE_SENTINEL) {
    const to = Date.now();
    return { from: to - f.windowMinutes * 60_000, to };
  }
  const from = f.customStart ? new Date(f.customStart).getTime() : NaN;
  const to = f.customEnd ? new Date(f.customEnd).getTime() : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'Invalid date';
  // `to` is exclusive server-side, so equal bounds select nothing — an empty
  // list the operator reads as "nobody signed in".
  if (to <= from) return 'End must be after start';
  return { from, to };
}

export function useAuditPage() {
  const health = ref<AuditHealth | null>(null);
  const healthError = ref<'denied' | 'error' | null>(null);
  const stat = ref<AuditStatResult | null>(null);
  const rows = ref<AuditEntry[]>([]);

  const statWindow = ref<AuditStatWindow>(6);
  const filters = ref<AuditFilters>(emptyFilters());
  const pageNum = ref(1);
  const hasNext = ref(false);

  /** The filters the current result set was fetched with. */
  const applied = ref<AuditFilters>(emptyFilters());
  /**
   * The time bounds the CURRENT result set was fetched with, resolved once.
   *
   * A rolling preset resolves against `Date.now()`, so recomputing it per page
   * moved the window under the reader: page two asked about a slightly later
   * span than page one, which drops or repeats rows at the boundary. Frozen
   * when the filters are applied and reused until they change.
   */
  const appliedRange = ref<{ from?: number; to?: number }>({});
  /**
   * One cursor per page boundary — `cursors[n]` is where page `n + 2` starts.
   * Kept as a stack so Previous is a position we already held rather than a
   * backwards offset.
   */
  const cursors = ref<string[]>([]);
  /** Set when the typed range cannot be read, so the form can say so instead
   *  of firing a query the operator did not describe. */
  const rangeError = ref<string | null>(null);
  /**
   * Generation counters, one per query.
   *
   * The two loaders are fired by controls an operator can click faster than
   * the server answers, and nothing ordered the responses: 2h then 12h could
   * leave 2h's late reply on screen under a 12h control, and filters A then B
   * could show A's rows beside B's pagination. Each request takes a ticket and
   * only the newest is allowed to write.
   */
  let statGeneration = 0;
  let listGeneration = 0;
  const loadingStat = ref(false);
  const loadingList = ref(false);
  const listError = ref<string | null>(null);
  const statError = ref<string | null>(null);

  /** `off` is reachable ONLY from a health response that says so. Folding a
   *  failed read into it told an operator whose audit log is running fine to
   *  go and turn it on, and told a denied one the wrong reason for being
   *  denied — the exact "empty state that is a lie" the page is built to
   *  avoid. */
  const state = computed<'loading' | 'denied' | 'unknown' | 'off' | 'misconfigured' | 'unconfigured' | 'unreachable' | 'ready'>(() => {
    if (healthError.value === 'denied') return 'denied';
    if (healthError.value) return 'unknown';
    const h = health.value;
    if (!h) return 'loading';
    if (!h.enabled) return 'off';
    // Before `unconfigured`: a refused configuration is a fault in the YAML,
    // named in the boot log, and must not read as "you forgot to pick one".
    if (h.configProblem) return 'misconfigured';
    if (!h.configured) return 'unconfigured';
    if (!h.available) return 'unreachable';
    return 'ready';
  });

  async function loadHealth(): Promise<void> {
    try {
      health.value = await bff.adminAudit.status();
      healthError.value = null;
    } catch (err) {
      health.value = null;
      const status = (err as { status?: number } | null)?.status;
      healthError.value = status === 401 || status === 403 ? 'denied' : 'error';
    }
  }

  async function loadStat(): Promise<void> {
    const generation = (statGeneration += 1);
    // Cascade-clear: the previous window's numbers must not sit under the
    // spinner while the new ones are in flight — an operator reads them as
    // the new state.
    stat.value = null;
    statError.value = null;
    loadingStat.value = true;
    try {
      const next = await bff.adminAudit.stat(statWindow.value);
      if (generation !== statGeneration) return;
      stat.value = next;
    } catch (err) {
      if (generation !== statGeneration) return;
      statError.value = err instanceof Error ? err.message : String(err);
    } finally {
      // The spinner belongs to the newest request too, or an overtaken reply
      // clears it while the one still running has nothing on screen.
      if (generation === statGeneration) loadingStat.value = false;
    }
  }


  async function loadList(use?: AuditFilters): Promise<void> {
    const generation = (listGeneration += 1);
    rows.value = [];
    listError.value = null;
    loadingList.value = true;
    const f = use ?? { ...filters.value };
    applied.value = f;
    const cursor = pageNum.value > 1 ? cursors.value[pageNum.value - 2] : undefined;
    const query: AuditQuery = {
      pageNum: pageNum.value,
      pageSize: PAGE_SIZE,
      ...(f.username ? { username: f.username } : {}),
      ...(f.kind ? { kind: [f.kind] } : {}),
      ...appliedRange.value,
      ...(cursor ? { cursor } : {}),
    };
    try {
      const page = await bff.adminAudit.list(query);
      // A superseded reply must not land: its rows belong to a predicate the
      // controls no longer show, and its `hasNext` would page the wrong query.
      if (generation !== listGeneration) return;
      rows.value = page.rows;
      hasNext.value = page.hasNext;
      // Record where this page ended so the next one can resume from it.
      if (page.nextCursor) cursors.value[pageNum.value - 1] = page.nextCursor;
    } catch (err) {
      if (generation !== listGeneration) return;
      listError.value = err instanceof Error ? err.message : String(err);
      hasNext.value = false;
    } finally {
      if (generation === listGeneration) loadingList.value = false;
    }
  }

  /**
   * Re-reads what is currently ON SCREEN.
   *
   * It reuses the APPLIED filters rather than the live form, for the same
   * reason paging does: refreshing must not silently submit an edit the
   * operator was still typing. The page number is kept too — a refresh is
   * "show me this again", not "start over".
   */
  async function refresh(): Promise<void> {
    await loadHealth();
    if (state.value !== 'ready') {
      stat.value = null;
      rows.value = [];
      return;
    }
    await Promise.all([loadStat(), loadList(applied.value)]);
  }

  /** Any filter change resets to page 1: keeping the page number across a
   *  changed predicate lands the reader on an arbitrary offset of a different
   *  result set. */
  async function applyFilters(): Promise<void> {
    const f = { ...filters.value };
    const range = rangeOf(f);
    if (typeof range === 'string') {
      rangeError.value = range;
      return;
    }
    rangeError.value = null;
    // Freeze the window with the rest of the predicate: everything the result
    // set was fetched with changes together, or not at all.
    appliedRange.value = range;
    pageNum.value = 1;
    cursors.value = [];
    await loadList(f);
  }

  /** Entering custom mode seeds both ends from the window that was showing,
   *  so the inputs are never empty. An empty `datetime-local` paints the
   *  BROWSER's locale placeholder, which reads as Chinese on an English page
   *  when the two locales differ. */
  function setWindowMinutes(next: number): void {
    const previous = filters.value.windowMinutes;
    filters.value.windowMinutes = next;
    if (next !== CUSTOM_RANGE_SENTINEL) {
      filters.value.customStart = null;
      filters.value.customEnd = null;
      return;
    }
    if (filters.value.customStart && filters.value.customEnd) return;
    const end = new Date();
    const spanMinutes = previous > 0 ? previous : 60;
    filters.value.customStart = toLocalInput(new Date(end.getTime() - spanMinutes * 60_000));
    filters.value.customEnd = toLocalInput(end);
  }

  async function clearFilters(): Promise<void> {
    filters.value = emptyFilters();
    rangeError.value = null;
    await applyFilters();
  }

  async function setWindow(w: AuditStatWindow): Promise<void> {
    statWindow.value = w;
    await loadStat();
  }

  async function go(delta: number): Promise<void> {
    const next = pageNum.value + delta;
    if (next < 1) return;
    if (delta > 0 && !hasNext.value) return;
    pageNum.value = next;
    // Page with the filters that produced THIS result set, not whatever is
    // half-typed in the form. Reading the live refs would silently apply an
    // edit the operator never submitted, and page 2 would be page 2 of a
    // different query.
    await loadList(applied.value);
  }

  return {
    health, stat, rows, statWindow, filters, pageNum, hasNext,
    loadingStat, loadingList, listError, statError, healthError, rangeError,
    state,
    refresh, loadList, applyFilters, clearFilters, setWindow, setWindowMinutes, go,
  };
}
