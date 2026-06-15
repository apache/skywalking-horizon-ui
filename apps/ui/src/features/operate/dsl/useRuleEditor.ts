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
 * Editor state machine — load / dirty-track / save / inactivate /
 * delete, with applyStatus mapping. Pure composable so tests target
 * it directly without booting Monaco.
 *
 * The component (Editor.vue) wires inputs (catalog/name/buffer ref)
 * and renders the four action buttons; this composable owns the
 * actual transitions.
 */

import { computed, ref, watch, type Ref } from 'vue';
import type { ApplyResult, Catalog, DeleteMode, RuleResponse } from '@skywalking-horizon-ui/api-client';
import { bff, type BffApiError } from '@/api/client';

// `pending` = the BFF returned 202 `submitted`: OAP accepted a structural
// apply that runs past its admin request timeout, so the HTTP call can't
// confirm completion. The caller polls (see `awaitApplied`) instead of
// retrying — a retry would pile another waiter on OAP's per-file lock.
export type SaveOutcome =
  | { kind: 'ok'; result: ApplyResult }
  | { kind: 'pending'; result: ApplyResult }
  | { kind: 'needs-storage-change'; result: ApplyResult }
  | { kind: 'error'; error: BffApiError | Error };

export type DeleteOutcome =
  | { kind: 'ok'; result: ApplyResult }
  | { kind: 'pending'; result: ApplyResult }
  | { kind: 'needs-inactivate-first'; result: ApplyResult }
  | { kind: 'no-bundled-twin'; result: ApplyResult }
  | { kind: 'error'; error: BffApiError | Error };

export interface UseRuleEditorOptions {
  catalog: Ref<Catalog | null>;
  name: Ref<string | null>;
  /** Optional override of the BFF singleton — for tests. */
  client?: typeof bff;
}

export function useRuleEditor(opts: UseRuleEditorOptions) {
  const client = opts.client ?? bff;

  const original = ref<RuleResponse | null>(null);
  const buffer = ref<string>('');
  const loading = ref<boolean>(false);
  const loadError = ref<string | null>(null);
  const saving = ref<boolean>(false);
  /** Last save's `applyStatus`, surfaced as a transient status note in
   *  the UI ("filter_only_applied", "structural_applied", "no_change"). */
  const lastApplyStatus = ref<string | null>(null);

  const dirty = computed<boolean>(() => {
    if (!original.value) return buffer.value.length > 0;
    return buffer.value !== original.value.content;
  });

  const exists = computed<boolean>(() => original.value !== null);

  async function load(): Promise<void> {
    if (!opts.catalog.value || !opts.name.value) return;
    loading.value = true;
    loadError.value = null;
    try {
      const r = await client.dsl.getRule({
        catalog: opts.catalog.value,
        name: opts.name.value,
      });
      original.value = r;
      buffer.value = r?.content ?? '';
    } catch (err) {
      loadError.value = errorMessage(err);
    } finally {
      loading.value = false;
    }
  }

  /** Fetch the bundled twin (used by "diff against bundled" affordance
   *  and by the `revertToBundled` preview). Returns `null` if no
   *  bundled twin exists. */
  async function fetchBundled(): Promise<RuleResponse | null> {
    if (!opts.catalog.value || !opts.name.value) return null;
    try {
      return await client.dsl.getRule({
        catalog: opts.catalog.value,
        name: opts.name.value,
        source: 'bundled',
      });
    } catch (err) {
      // 404 from the BFF is the "no bundled twin" case; surfaced as null.
      if (isApiError(err) && err.status === 404) return null;
      throw err;
    }
  }

  async function save(
    args: {
      allowStorageChange?: boolean;
      force?: boolean;
    } = {},
  ): Promise<SaveOutcome> {
    if (!opts.catalog.value || !opts.name.value) {
      return { kind: 'error', error: new Error('no rule selected') };
    }
    saving.value = true;
    try {
      const result = await client.dsl.saveRule({
        catalog: opts.catalog.value,
        name: opts.name.value,
        body: buffer.value,
        ...args,
      });
      lastApplyStatus.value = result.applyStatus;
      if (result.applyStatus === 'submitted') return { kind: 'pending', result };
      // Refresh the original to the just-pushed body so dirty resets.
      await load();
      return { kind: 'ok', result };
    } catch (err) {
      if (isApiError(err) && err.status === 409) {
        const body = err.body as ApplyResult | undefined;
        if (body && body.applyStatus === 'storage_change_requires_explicit_approval') {
          return { kind: 'needs-storage-change', result: body };
        }
      }
      return { kind: 'error', error: err as Error };
    } finally {
      saving.value = false;
    }
  }

  async function inactivate(): Promise<SaveOutcome> {
    if (!opts.catalog.value || !opts.name.value) {
      return { kind: 'error', error: new Error('no rule selected') };
    }
    saving.value = true;
    try {
      const result = await client.dsl.inactivateRule(opts.catalog.value, opts.name.value);
      lastApplyStatus.value = result.applyStatus;
      if (result.applyStatus === 'submitted') return { kind: 'pending', result };
      await load();
      return { kind: 'ok', result };
    } catch (err) {
      return { kind: 'error', error: err as Error };
    } finally {
      saving.value = false;
    }
  }

  async function deleteRule(mode: DeleteMode = ''): Promise<DeleteOutcome> {
    if (!opts.catalog.value || !opts.name.value) {
      return { kind: 'error', error: new Error('no rule selected') };
    }
    saving.value = true;
    try {
      const result = await client.dsl.deleteRule(opts.catalog.value, opts.name.value, mode);
      lastApplyStatus.value = result.applyStatus;
      if (result.applyStatus === 'submitted') return { kind: 'pending', result };
      return { kind: 'ok', result };
    } catch (err) {
      if (isApiError(err) && err.status === 409) {
        const body = err.body as ApplyResult | undefined;
        if (body?.applyStatus === 'requires_inactivate_first') {
          return { kind: 'needs-inactivate-first', result: body };
        }
      }
      if (isApiError(err) && err.status === 400) {
        const body = err.body as ApplyResult | undefined;
        if (body?.applyStatus === 'no_bundled_twin') {
          return { kind: 'no-bundled-twin', result: body };
        }
      }
      return { kind: 'error', error: err as Error };
    } finally {
      saving.value = false;
    }
  }

  /**
   * Confirm an async ("submitted") apply by polling the rule until `done`
   * holds or the budget elapses. OAP runs structural applies past its admin
   * request timeout, so the mutation HTTP call returns before the apply
   * lands — we re-read the rule here rather than re-firing the mutation
   * (which would queue another waiter on OAP's per-file lock). On success it
   * refreshes `original` so the editor reflects the new state. `done`
   * receives the polled rule (or `null` when the rule no longer exists).
   */
  async function awaitApplied(
    done: (rule: RuleResponse | null) => boolean,
    o: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<'applied' | 'timeout'> {
    if (!opts.catalog.value || !opts.name.value) return 'timeout';
    const cat = opts.catalog.value;
    const nm = opts.name.value;
    const timeoutMs = o.timeoutMs ?? 150_000;
    const intervalMs = o.intervalMs ?? 4_000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      // Operator navigated to a different rule — stop polling the old one.
      if (opts.catalog.value !== cat || opts.name.value !== nm) return 'timeout';
      let rule: RuleResponse | null;
      try {
        rule = await client.dsl.getRule({ catalog: cat, name: nm });
      } catch {
        continue; // transient read error mid-apply — keep waiting
      }
      if (done(rule)) {
        await load();
        return 'applied';
      }
    }
    return 'timeout';
  }

  // Auto-load whenever (catalog, name) settles.
  watch(
    [opts.catalog, opts.name],
    () => {
      void load();
    },
    { immediate: true },
  );

  return {
    original,
    buffer,
    loading,
    loadError,
    saving,
    dirty,
    exists,
    lastApplyStatus,
    load,
    fetchBundled,
    save,
    inactivate,
    deleteRule,
    awaitApplied,
  };
}

function isApiError(v: unknown): v is BffApiError {
  return typeof v === 'object' && v !== null && 'status' in v && 'body' in v;
}

function errorMessage(err: unknown): string {
  if (isApiError(err)) {
    const body = err.body;
    if (typeof body === 'object' && body !== null && 'message' in body) {
      return String((body as { message: unknown }).message);
    }
    return `HTTP ${err.status}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
