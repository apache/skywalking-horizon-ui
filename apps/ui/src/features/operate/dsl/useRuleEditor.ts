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
import type {
  ApplyResult,
  Catalog,
  DeleteMode,
  RuleResponse,
  RuleStatusResponse,
} from '@skywalking-horizon-ui/api-client';
import { isTerminalPhase } from '@skywalking-horizon-ui/api-client';
import { bff, type BffApiError } from '@/api/client';

// A STRUCTURAL `/addOrUpdate` returns 200 `structural_applied` + an `applyId`
// at phase FENCING ("accepted, not yet durable") — the fence → persist →
// commit → resume tail runs in OAP's background. `structural` hands the
// applyId back so the caller polls `awaitPhase` until the phase is terminal.
// `compile-failed` is the inline-diagnostic case (400 compile_failed).
export type SaveOutcome =
  | { kind: 'ok'; result: ApplyResult }
  | { kind: 'structural'; result: ApplyResult; applyId: string }
  | { kind: 'needs-storage-change'; result: ApplyResult }
  | { kind: 'compile-failed'; message: string }
  | { kind: 'error'; error: BffApiError | Error };

// `structural` = revert-to-bundled adopted the async apply API: OAP returns
// `reverted_to_bundled` + an applyId and runs the schema change in the
// background — the caller drives the phase stepper via `awaitPhase`, same as a
// structural save. `pending` is the legacy fallback for an OAP that runs revert
// inline (no applyId) and times out into a 202 `submitted`: the caller confirms
// via `awaitApplied` (poll-by-reread) rather than retrying onto OAP's per-file
// lock.
export type DeleteOutcome =
  | { kind: 'ok'; result: ApplyResult }
  | { kind: 'structural'; result: ApplyResult; applyId: string }
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
      // Structural apply is async: it's accepted at FENCING but not durable
      // yet. Hand back the applyId; the caller polls /status and only then
      // refreshes — re-reading now would still show the pre-apply row.
      if (result.applyStatus === 'structural_applied' && result.applyId) {
        return { kind: 'structural', result, applyId: result.applyId };
      }
      // no_change / filter_only_applied / filter_only_persisted — synchronous;
      // refresh the original to the just-pushed body so dirty resets.
      await load();
      return { kind: 'ok', result };
    } catch (err) {
      if (isApiError(err)) {
        const body = err.body as ApplyResult | undefined;
        if (err.status === 409 && body?.applyStatus === 'storage_change_requires_explicit_approval') {
          return { kind: 'needs-storage-change', result: body };
        }
        // A compile/parse failure is the operator's to fix in the editor —
        // surface it inline rather than as a transient error toast.
        if (err.status === 400 && body?.applyStatus === 'compile_failed') {
          return { kind: 'compile-failed', message: body.message };
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
      // Inactivate carries no schema change — it returns synchronously, so
      // there's nothing async to poll.
      const result = await client.dsl.inactivateRule(opts.catalog.value, opts.name.value);
      lastApplyStatus.value = result.applyStatus;
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
      // Revert-to-bundled is structural; a new OAP returns an applyId to poll
      // (same phase machine as a structural save). Old OAP runs it inline and
      // may time out into the legacy 202 `submitted` (poll-by-reread).
      if (
        result.applyId &&
        (result.applyStatus === 'reverted_to_bundled' || result.applyStatus === 'structural_applied')
      ) {
        return { kind: 'structural', result, applyId: result.applyId };
      }
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

  /**
   * Drive a STRUCTURAL apply to completion by polling `/runtime/rule/status`.
   * `onPhase` fires on every poll so the caller can render a phase stepper.
   * Polls by `applyId` (the live tracker) and carries `contentHash` so the
   * server can degrade to the durable rule row if the applyId was evicted.
   * Resolves with the terminal {@link RuleStatusResponse} (APPLIED / DEGRADED
   * / FAILED) — or the last seen status if the budget elapses (OAP itself
   * moves to a terminal phase by `deferredFenceTimeoutSeconds`, so a real
   * apply lands well inside the default budget). On APPLIED / DEGRADED the
   * durable row advanced, so it refreshes `original` (dirty resets); FAILED
   * rolled back, so the operator's buffer is left intact to fix and retry.
   * Stops early if the operator navigated to a different (catalog, name).
   */
  async function awaitPhase(
    applyId: string,
    contentHash: string,
    onPhase: (status: RuleStatusResponse) => void,
    o: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<RuleStatusResponse | null> {
    if (!opts.catalog.value || !opts.name.value) return null;
    const cat = opts.catalog.value;
    const nm = opts.name.value;
    const timeoutMs = o.timeoutMs ?? 200_000;
    const intervalMs = o.intervalMs ?? 1_800;
    const start = Date.now();
    let last: RuleStatusResponse | null = null;
    while (Date.now() - start < timeoutMs) {
      if (opts.catalog.value !== cat || opts.name.value !== nm) return last;
      try {
        const status = await client.dsl.ruleStatus({ catalog: cat, name: nm, applyId, contentHash });
        last = status;
        onPhase(status);
        // Stop on a terminal phase, OR when the apply is no longer tracked
        // (UNKNOWN / found:false) — e.g. the applyId was evicted (~1h TTL,
        // main restart) and no durable row matched the contentHash. Polling
        // on past that just burns the budget. APPLIED/DEGRADED advanced the
        // durable row, so refresh; FAILED/UNKNOWN leave the buffer alone.
        if (isTerminalPhase(status.phase) || !status.found || status.phase === 'UNKNOWN') {
          if (status.phase === 'APPLIED' || status.phase === 'DEGRADED') await load();
          return status;
        }
      } catch {
        // transient read error mid-apply — keep polling.
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return last;
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
    awaitPhase,
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
