<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import {
  isCatalog,
  type ApplyPhase,
  type Catalog,
  type RuleResponse,
} from '@skywalking-horizon-ui/api-client';
import { useAuthStore } from '@/state/auth';
import { useRuleEditor, type SaveOutcome } from '@/features/operate/dsl/useRuleEditor';
import { sha256Hex } from '@/features/operate/dsl/contentHash';
import Btn from '@/components/primitives/Btn.vue';
import Pill from '@/components/primitives/Pill.vue';
import MonacoYaml from '@/features/operate/_shared/MonacoYaml.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';
import DestructiveConfirm from '@/features/operate/_shared/DestructiveConfirm.vue';
import ApplyProgress from '@/features/operate/dsl/ApplyProgress.vue';
import AdminFeatureWarning from '@/shell/AdminFeatureWarning.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const catalog = computed<Catalog | null>(() => {
  const raw = route.query.catalog;
  return typeof raw === 'string' && isCatalog(raw) ? raw : null;
});
const name = computed<string | null>(() => {
  const raw = route.query.name;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
});

const editor = useRuleEditor({ catalog, name });

const showAdvanced = ref(false);
const force = ref(false);

// Live structural-apply state, driving the phase stepper. Declared ABOVE the
// (immediate) resume watch below — that watch fires during setup and reads
// these, so hoisting them avoids a TDZ ReferenceError that would blank the
// page. `null` = no apply in flight / panel dismissed.
interface ApplyState {
  phase: ApplyPhase;
  applyId: string;
  hash: string;
  failureReason?: string;
  fenceLaggards?: string[];
  derivedFrom?: string;
}
const apply = ref<ApplyState | null>(null);
const polling = ref(false);
/** Inline YAML diagnostic for a 400 compile_failed — the operator's to fix. */
const compileError = ref<string | null>(null);

type DiffMode = 'none' | 'current' | 'bundled';
const diffMode = ref<DiffMode>('none');
const bundled = shallowRef<RuleResponse | null>(null);
const diffLoadError = ref<string | null>(null);

interface ConfirmConfig {
  title: string;
  intent: string;
  warning: string[];
  perform: () => Promise<void>;
}
const confirm = ref<ConfirmConfig | null>(null);
const confirmBusy = ref(false);

/** Live-debugger jump from a `- name: <X>` line in the editor.
 *  MAL catalogs route to
 *  `/operate/live-debug/mal?catalog=&name=<file>&ruleName=<X>` (file +
 *  metric — what OAP needs for the install); LAL routes to
 *  `/operate/live-debug/lal?name=<X>&file=<file>`. */
function onDebugClick(ruleName: string): void {
  const c = catalog.value;
  const n = name.value;
  if (!c || !n) return;
  if (c === 'lal') {
    void router.push({
      path: '/operate/live-debug/lal',
      query: { name: ruleName, file: n },
    });
  } else {
    void router.push({
      path: '/operate/live-debug/mal',
      query: { catalog: c, name: n, ruleName },
    });
  }
}

const canWriteStructural = computed(() => auth.hasVerb('rule:write:structural'));
const canDelete = computed(() => auth.hasVerb('rule:delete'));
const canWrite = computed(() => auth.hasVerb('rule:write'));

const flash = ref<string | null>(null);
function setFlash(msg: string): void {
  flash.value = msg;
  setTimeout(() => {
    if (flash.value === msg) flash.value = null;
  }, 4000);
}

// Every action button is gated on `busy` so retries can't stack on OAP's
// per-file lock while a save / structural poll / revert poll / confirm is in
// flight.
const busy = computed(
  () => editor.saving.value || polling.value || applying.value || confirmBusy.value,
);

// ── Structural apply: poll /status by applyId, show the phase stepper ──

/** Poll a structural apply to a terminal phase. APPLIED auto-collapses the
 *  panel; DEGRADED / FAILED keep it so the operator can recover or dismiss. */
async function runStructuralPoll(applyId: string, hash: string): Promise<void> {
  if (polling.value) return;
  polling.value = true;
  flash.value = null;
  compileError.value = null;
  apply.value = { phase: 'FENCING', applyId, hash };
  const final = await editor.awaitPhase(applyId, hash, (s) => {
    apply.value = {
      phase: (s.phase as ApplyPhase) || 'UNKNOWN',
      applyId,
      hash,
      failureReason: s.failureReason,
      fenceLaggards: s.fenceLaggards,
      derivedFrom: s.derivedFrom,
    };
  });
  polling.value = false;
  await stripApplyQuery();
  const phase = final?.phase;
  if (phase === 'APPLIED') {
    setFlash(t('applied ✓'));
    window.setTimeout(() => {
      if (apply.value?.applyId === applyId) apply.value = null;
    }, 2500);
    return;
  }
  if (phase === 'DEGRADED' || phase === 'FAILED') {
    return; // keep the banner so the operator can recover / dismiss
  }
  // No terminal phase reached: the applyId is no longer tracked (UNKNOWN /
  // not found), the budget elapsed while still applying, or every poll
  // errored. Drop the stale stepper — the apply (if any) finishes on OAP and
  // a reload shows the durable state.
  apply.value = null;
  if (final && (final.found === false || final.phase === 'UNKNOWN')) {
    await editor.load();
    setFlash(t('Apply status is no longer tracked — reload to see the stored rule.'));
  } else {
    setFlash(t('still applying on OAP — refresh in a moment to confirm'));
  }
}

/** Start tracking a fresh structural apply. The applyId + content hash live
 *  in the URL ONLY while in-flight (stripped on terminal) so a reload resumes
 *  the stepper; after terminal, a reload resolves from the durable row, which
 *  reads a DEGRADED apply back as applied-from-stored-state — by design. */
async function beginStructural(applyId: string, content?: string): Promise<void> {
  // Hash the content that was actually applied — the editor buffer for a save,
  // the bundled content for a revert — so the durable-row resume can match it.
  const hash = await sha256Hex(content ?? editor.buffer.value);
  await router.replace({ path: route.path, query: { ...route.query, applyId, hash } });
  await runStructuralPoll(applyId, hash);
}

function resumeStructural(applyId: string, hash: string): void {
  if (!polling.value) void runStructuralPoll(applyId, hash);
}

async function stripApplyQuery(): Promise<void> {
  if (!('applyId' in route.query) && !('hash' in route.query)) return;
  const q = { ...route.query };
  delete q.applyId;
  delete q.hash;
  await router.replace({ path: route.path, query: q });
}

function onRecheck(): void {
  if (apply.value) resumeStructural(apply.value.applyId, apply.value.hash);
}

function onDismissApply(): void {
  apply.value = null;
}

/** Force re-apply the current content to recover a DEGRADED / FAILED apply:
 *  re-runs the schema fence (re-checking laggards) and re-resumes any stuck
 *  peers. Byte-identical content is a no-op against a healthy node, but the
 *  re-apply still pauses collection for the rule's metrics — gate it. */
function onRecover(): void {
  if (!name.value) return;
  confirm.value = {
    title: t('Force re-apply to recover'),
    intent: t('force re-apply to recover'),
    warning: [
      t('Re-applies the rule across the cluster to recover — this briefly pauses collection for this rule’s metrics, even though the content is unchanged.'),
      t('Use this to clear a stuck apply or coax laggard nodes to re-confirm the schema.'),
    ],
    perform: async () => {
      const r = await editor.save({ force: true });
      handleSaveOutcome(r);
    },
  };
}

function handleSaveOutcome(r: SaveOutcome): void {
  if (r.kind === 'ok') {
    apply.value = null;
    setFlash(t('saved · {status}', { status: r.result.applyStatus }));
    return;
  }
  if (r.kind === 'structural') {
    void beginStructural(r.applyId);
    return;
  }
  if (r.kind === 'needs-storage-change') {
    confirm.value = {
      title: t('Storage change required'),
      intent: t('push a STRUCTURAL change to'),
      warning: [
        t('This edit moves the metric’s storage identity (scope, downsampling, or single↔labeled↔histogram).'),
        t('OAP drops the existing measure’s data on BanyanDB and orphans rows on JDBC / Elasticsearch.'),
        t('Alarm rules, dashboards, and historical queries that reference the old shape will miss the pre-change window.'),
      ],
      perform: async () => {
        const ok = await editor.save({ allowStorageChange: true, force: force.value });
        handleSaveOutcome(ok);
      },
    };
    return;
  }
  if (r.kind === 'compile-failed') {
    apply.value = null;
    compileError.value = r.message;
    return;
  }
  setFlash(extractErrorMessage(r.error));
}

async function onSave(): Promise<void> {
  compileError.value = null;
  const r = await editor.save({ force: force.value });
  handleSaveOutcome(r);
}

// Revert-to-bundled has no applyId (OAP runs its pipeline inline), so it
// still confirms by re-reading the rule after a `pending` (202 submitted).
// The action row stays disabled via `busy` so the operator can't stack
// retries on OAP's per-file lock.
const applying = ref(false);
async function trackApply(): Promise<void> {
  applying.value = true;
  setFlash(t('submitted — OAP is applying it; a structural apply can take a minute…'));
  const done = (r: RuleResponse | null): boolean =>
    r != null && (r.status === 'BUNDLED' || r.status === 'STATIC');
  const res = await editor.awaitApplied(done);
  applying.value = false;
  setFlash(res === 'applied' ? t('applied ✓') : t('still applying on OAP — refresh in a moment to confirm'));
}

async function onInactivate(): Promise<void> {
  const r = await editor.inactivate();
  if (r.kind === 'ok') {
    setFlash(t('inactivated · {status}', { status: r.result.applyStatus }));
    return;
  }
  if (r.kind === 'error') {
    setFlash(extractErrorMessage(r.error));
  }
}

async function onDeleteDefault(): Promise<void> {
  const r = await editor.deleteRule('');
  if (r.kind === 'ok') {
    setFlash(t('deleted · {status}', { status: r.result.applyStatus }));
    await router.push({ name: 'catalog', params: { catalog: catalog.value ?? '' } });
    return;
  }
  if (r.kind === 'pending') {
    // Plain delete is synchronous; a 202 is not expected here, but stay
    // honest if OAP ever defers it.
    setFlash(t('still applying on OAP — refresh in a moment to confirm'));
    return;
  }
  if (r.kind === 'needs-inactivate-first') {
    setFlash(t('rule is ACTIVE — inactivate first, then delete'));
    return;
  }
  if (r.kind === 'error') {
    setFlash(extractErrorMessage(r.error));
    return;
  }
  // 'no-bundled-twin' shouldn't reach the default-delete path.
  setFlash(t('unexpected outcome: {kind}', { kind: r.kind }));
}

function onDeleteRevertToBundled(): void {
  if (!name.value) return;
  confirm.value = {
    title: t('Revert to bundled'),
    intent: t('revert to bundled (STRUCTURAL apply)'),
    warning: [
      t('OAP runs the standard apply pipeline against the bundled YAML — this is a schema change.'),
      t('Runtime-only metrics that the bundled rule does not define will be dropped from BanyanDB.'),
      t('Bundled-only metrics will be installed.'),
      ...(editor.original.value?.status === 'ACTIVE'
        ? [t('An ACTIVE rule is inactivated first, then reverted.')]
        : []),
      t('Returns 400 no_bundled_twin if the rule has no bundled version on disk.'),
    ],
    perform: async () => {
      let r = await editor.deleteRule('revertToBundled');
      // OAP gates revert behind the row being INACTIVE (same two-step gate as
      // delete). The operator already confirmed the revert, so inactivate and
      // retry as one action rather than dead-ending with a 409.
      if (r.kind === 'needs-inactivate-first') {
        const ina = await editor.inactivate();
        if (ina.kind === 'error') {
          setFlash(extractErrorMessage(ina.error));
          return;
        }
        r = await editor.deleteRule('revertToBundled');
      }
      // New OAP: revert is async with an applyId — drive the same phase stepper
      // as a structural save, hashing the bundled content that's being applied.
      if (r.kind === 'structural') {
        void beginStructural(r.applyId, bundled.value?.content);
        return;
      }
      if (r.kind === 'ok') {
        setFlash(t('reverted · {status}', { status: r.result.applyStatus }));
        await router.push({ name: 'catalog', params: { catalog: catalog.value ?? '' } });
        return;
      }
      if (r.kind === 'pending') {
        void trackApply();
        return;
      }
      if (r.kind === 'needs-inactivate-first') {
        setFlash(t('rule is ACTIVE — inactivate first, then revert to bundled'));
        return;
      }
      if (r.kind === 'no-bundled-twin') {
        setFlash(t('no bundled version on disk for this rule'));
        return;
      }
      if (r.kind === 'error') {
        setFlash(extractErrorMessage(r.error));
      }
    },
  };
}

async function runConfirm(): Promise<void> {
  if (!confirm.value) return;
  confirmBusy.value = true;
  try {
    await confirm.value.perform();
  } finally {
    confirmBusy.value = false;
    confirm.value = null;
  }
}

async function loadBundled(): Promise<void> {
  diffLoadError.value = null;
  try {
    bundled.value = await editor.fetchBundled();
    if (!bundled.value) {
      diffLoadError.value = t('no bundled version on disk for this rule');
    }
  } catch (err) {
    diffLoadError.value = err instanceof Error ? err.message : String(err);
  }
}

function setDiffMode(mode: DiffMode): void {
  diffMode.value = mode;
  diffLoadError.value = null;
  if (mode === 'bundled' && !bundled.value) void loadBundled();
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'body' in err) {
    const body = (err as { body: unknown }).body;
    if (typeof body === 'object' && body !== null && 'message' in body) {
      return String((body as { message: unknown }).message);
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

const statusTone = computed(() => {
  switch (editor.original.value?.status) {
    case 'ACTIVE':
      return 'ok' as const;
    case 'INACTIVE':
      return 'warn' as const;
    case 'BUNDLED':
    case 'STATIC':
      return 'dim' as const;
    case 'n/a':
      return 'err' as const;
  }
  return 'dim' as const;
});

// Probe the bundled twin eagerly on every (catalog, name) so the action
// buttons reflect its existence on load — NOT only after the operator opens
// the "diff vs. bundled" tab (the old `source === 'static'` clause was dead:
// RuleSource is only ever 'runtime' | 'bundled'). The fetched content is
// cached in `bundled`, so the diff tab then opens instantly. Guarded against
// a stale fetch resolving after a newer rule was selected. Also resumes an
// in-flight structural apply across a reload, or clears stale apply state
// when navigating to a different rule.
watch(
  [catalog, name],
  () => {
    bundled.value = null;
    const c = catalog.value;
    const n = name.value;
    void editor
      .fetchBundled()
      .then((b) => {
        if (catalog.value === c && name.value === n) bundled.value = b;
      })
      .catch(() => {});

    // applyId lives in the URL only while a structural apply is non-terminal,
    // so its presence on (re)mount means "was applying when the page was
    // left" — resume the stepper. Otherwise this is a fresh rule view.
    const aid = route.query.applyId;
    const hash = route.query.hash;
    if (typeof aid === 'string' && aid && typeof hash === 'string' && hash) {
      resumeStructural(aid, hash);
    } else {
      apply.value = null;
      compileError.value = null;
    }
  },
  { immediate: true },
);
const hasBundledTwin = computed<boolean>(() => bundled.value !== null);
// An operator-pushed runtime row (vs. a pure bundled rule served from disk).
// Only operator rows can be inactivated / deleted / reverted.
const isOperatorRow = computed<boolean>(() => {
  const s = editor.original.value?.status;
  return s === 'ACTIVE' || s === 'INACTIVE';
});
</script>

<template>
  <div class="ed">
    <AdminFeatureWarning module="receiver-runtime-rule" :feature-label="t('DSL Editor')" />
    <header class="ed__header">
      <h1 class="ed__h1">
        <span class="ed__catalog">{{ catalog ?? '?' }}</span>
        <span class="ed__sep">/</span>
        <span class="ed__name">{{ name ?? '?' }}</span>
      </h1>
      <Pill v-if="editor.original.value" :tone="statusTone">
        {{ editor.original.value.status }}
      </Pill>
      <Pill v-if="editor.dirty.value" tone="active">{{ t('unsaved') }}</Pill>
      <Pill v-if="applying" tone="info">{{ t('applying…') }}</Pill>
      <!-- The structural-apply phase stepper owns the live status while a
           structural apply is tracked; suppress the raw applyStatus pill then. -->
      <Pill v-if="!applying && !apply && editor.lastApplyStatus.value" tone="info">
        {{ editor.lastApplyStatus.value }}
      </Pill>
      <div class="ed__spacer" />
      <Btn @click="router.back()">{{ t('← catalog') }}</Btn>
    </header>

    <div class="ed__toolbar">
      <div class="ed__diffgroup">
        <button
          type="button"
          class="ed__tab"
          :class="{ 'ed__tab--active': diffMode === 'none' }"
          @click="setDiffMode('none')"
        >
          {{ t('edit') }}
        </button>
        <button
          type="button"
          class="ed__tab"
          :class="{ 'ed__tab--active': diffMode === 'current' }"
          :disabled="!editor.original.value"
          @click="setDiffMode('current')"
        >
          {{ t('diff vs. server') }}
        </button>
        <button
          type="button"
          class="ed__tab"
          :class="{ 'ed__tab--active': diffMode === 'bundled' }"
          @click="setDiffMode('bundled')"
        >
          {{ t('diff vs. bundled') }}
        </button>
      </div>

      <div class="ed__spacer" />

      <Btn
        kind="primary"
        :disabled="!canWrite || !editor.dirty.value || busy"
        :data-testid="'editor-save'"
        @click="onSave"
      >
        {{ editor.saving.value ? t('saving…') : t('save') }}
      </Btn>
      <!-- Inactivate only applies to an ACTIVE operator row — hidden once
           the rule is already INACTIVE (or a pure bundled rule). -->
      <Btn
        v-if="editor.original.value?.status === 'ACTIVE'"
        :disabled="!canWrite || busy"
        @click="onInactivate"
      >
        {{ t('inactivate') }}
      </Btn>
      <!-- Plain delete is valid ONLY when there's no bundled twin; OAP
           refuses it with 409 requires_revert_to_bundled when one exists,
           so for those rules we surface "revert to bundled" instead. -->
      <Btn
        v-if="isOperatorRow && !hasBundledTwin"
        kind="danger"
        :disabled="!canDelete || busy"
        @click="onDeleteDefault"
      >
        {{ t('delete') }}
      </Btn>
      <Btn
        v-if="isOperatorRow && hasBundledTwin"
        kind="danger"
        :disabled="!canDelete || !canWriteStructural || busy"
        :data-testid="'editor-revert'"
        @click="onDeleteRevertToBundled"
      >
        {{ t('revert to bundled') }}
      </Btn>
    </div>

    <!-- Structural-apply progress (phase stepper) takes the flash slot while
         an apply is tracked; DEGRADED / FAILED keep it for recover / dismiss. -->
    <ApplyProgress
      v-if="apply"
      :phase="apply.phase"
      :failure-reason="apply.failureReason"
      :fence-laggards="apply.fenceLaggards"
      :derived-from="apply.derivedFrom"
      :can-recover="canWriteStructural"
      :busy="busy"
      @recover="onRecover"
      @recheck="onRecheck"
      @dismiss="onDismissApply"
    />
    <p v-else-if="flash" class="ed__flash" :data-testid="'editor-flash'">{{ flash }}</p>

    <p v-if="compileError" class="ed__compile" :data-testid="'editor-compile-error'">
      {{ compileError }}
    </p>

    <div class="ed__editorWrap">
      <div v-if="editor.loading.value" class="ed__placeholder">{{ t('loading…') }}</div>
      <div v-else-if="editor.loadError.value" class="ed__placeholder ed__placeholder--err">
        {{ t('Could not load: {err}', { err: editor.loadError.value }) }}
      </div>

      <!-- Read-only while a save / apply poll is in flight: a terminal
           APPLIED refreshes the buffer from the server, which would silently
           discard edits typed during the poll. -->
      <MonacoYaml
        v-else-if="diffMode === 'none'"
        :model-value="editor.buffer.value"
        :catalog="catalog"
        :read-only="busy"
        @update:model-value="(v: string) => (editor.buffer.value = v)"
        @debug-click="onDebugClick"
      />

      <div v-else-if="diffMode === 'current'" class="ed__diffhost">
        <MonacoDiff
          :original="editor.original.value?.content ?? ''"
          :modified="editor.buffer.value"
        />
      </div>

      <div v-else class="ed__diffhost">
        <p v-if="diffLoadError" class="ed__placeholder ed__placeholder--err">
          {{ diffLoadError }}
        </p>
        <MonacoDiff
          v-else-if="bundled"
          :original="bundled.content"
          :modified="editor.buffer.value"
        />
        <p v-else class="ed__placeholder">{{ t('loading bundled…') }}</p>
      </div>
    </div>

    <details
      class="ed__advanced"
      :open="showAdvanced"
      @toggle="(e: Event) => (showAdvanced = (e.target as HTMLDetailsElement).open)"
    >
      <summary>{{ t('advanced') }}</summary>
      <label class="ed__force">
        <input v-model="force" type="checkbox" :disabled="!canWriteStructural" />
        <span>
          <i18n-t keypath="recovery: {force} on save" tag="span">
            <template #force><code>force=true</code></template>
          </i18n-t>
          <small>
            <i18n-t keypath="re-runs apply on byte-identical content (subsumes the old {fix} route). Requires {verb}." tag="span">
              <template #fix><code>/fix</code></template>
              <template #verb><code>rule:write:structural</code></template>
            </i18n-t>
          </small>
        </span>
      </label>
    </details>

    <DestructiveConfirm
      v-if="confirm"
      :open="confirm !== null"
      :title="confirm.title"
      :intent="confirm.intent"
      :rule-name="name ?? ''"
      :warning="confirm.warning"
      :busy="confirmBusy"
      @close="confirm = null"
      @confirm="runConfirm"
    />
  </div>
</template>

<style scoped>
.ed {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 14px 20px 20px;
  gap: 12px;
  min-width: 0;
}

.ed__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ed__h1 {
  margin: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-md);
  font-weight: var(--sw-fw-semibold);
  color: var(--rr-heading);
}

.ed__catalog,
.ed__name {
  color: var(--rr-active);
}

.ed__sep {
  margin: 0 4px;
  color: var(--rr-dim);
}

.ed__spacer {
  flex: 1 1 auto;
}

.ed__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.ed__diffgroup {
  display: flex;
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-md);
  overflow: hidden;
}

.ed__tab {
  background: var(--rr-bg2);
  color: var(--rr-ink2);
  border: none;
  border-right: 1px solid var(--rr-border);
  padding: 4px 12px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.ed__tab:last-child {
  border-right: none;
}
.ed__tab:hover:not(:disabled) {
  background: var(--rr-bg3);
  color: var(--rr-heading);
}
.ed__tab:disabled {
  cursor: not-allowed;
  color: var(--rr-dim);
}
.ed__tab--active {
  background: var(--rr-active);
  color: var(--rr-bg);
}

.ed__flash {
  margin: 0;
  padding: 8px 12px;
  background: var(--rr-bg2);
  border-left: 2px solid var(--rr-info);
  border-radius: var(--rr-radius-md);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-info);
}

.ed__compile {
  margin: 0;
  padding: 8px 12px;
  background: var(--rr-bg2);
  border-left: 2px solid var(--rr-err);
  border-radius: var(--rr-radius-md);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-err);
  white-space: pre-wrap;
  word-break: break-word;
}

.ed__editorWrap {
  flex: 1 1 auto;
  min-height: 320px;
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-md);
  overflow: hidden;
  display: flex;
}

.ed__diffhost {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: stretch;
}

.ed__placeholder {
  width: 100%;
  padding: 36px;
  text-align: center;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-dim);
}

.ed__placeholder--err {
  color: var(--rr-err);
}

.ed__advanced {
  font-size: var(--sw-fs-base);
  color: var(--rr-ink2);
}

.ed__advanced summary {
  cursor: pointer;
  font-family: var(--rr-font-mono);
  color: var(--rr-dim);
  letter-spacing: var(--sw-ls-tight);
  padding: 4px 0;
}

.ed__force {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  font-size: var(--sw-fs-base);
  color: var(--rr-ink2);
}

.ed__force code {
  font-family: var(--rr-font-mono);
  color: var(--rr-info);
}

.ed__force small {
  display: block;
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
  line-height: var(--sw-lh-tight);
  margin-top: 2px;
}
</style>
