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

export interface AuditFilters {
  username: string;
  kind: AuditKind[];
}

function emptyFilters(): AuditFilters {
  return { username: '', kind: [] };
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
    // Cascade-clear: the previous window's numbers must not sit under the
    // spinner while the new ones are in flight — an operator reads them as
    // the new state.
    stat.value = null;
    statError.value = null;
    loadingStat.value = true;
    try {
      stat.value = await bff.adminAudit.stat(statWindow.value);
    } catch (err) {
      statError.value = err instanceof Error ? err.message : String(err);
    } finally {
      loadingStat.value = false;
    }
  }


  async function loadList(use?: AuditFilters): Promise<void> {
    rows.value = [];
    listError.value = null;
    loadingList.value = true;
    const f = use ?? { ...filters.value };
    applied.value = f;
    const query: AuditQuery = {
      pageNum: pageNum.value,
      pageSize: PAGE_SIZE,
      ...(f.username ? { username: f.username } : {}),
      ...(f.kind.length ? { kind: f.kind } : {}),
    };
    try {
      const page = await bff.adminAudit.list(query);
      rows.value = page.rows;
      hasNext.value = page.hasNext;
    } catch (err) {
      listError.value = err instanceof Error ? err.message : String(err);
      hasNext.value = false;
    } finally {
      loadingList.value = false;
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
    pageNum.value = 1;
    await loadList({ ...filters.value });
  }

  async function clearFilters(): Promise<void> {
    filters.value = emptyFilters();
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
    loadingStat, loadingList, listError, statError, healthError,
    state,
    refresh, loadList, applyFilters, clearFilters, setWindow, go,
  };
}
