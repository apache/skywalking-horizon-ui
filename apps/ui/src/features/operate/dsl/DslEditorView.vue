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
import { isCatalog, type Catalog, type RuleResponse } from '@skywalking-horizon-ui/api-client';
import { useAuthStore } from '@/state/auth';
import { useRuleEditor } from '@/features/operate/dsl/useRuleEditor';
import Btn from '@/components/primitives/Btn.vue';
import Pill from '@/components/primitives/Pill.vue';
import MonacoYaml from '@/features/operate/_shared/MonacoYaml.vue';
import MonacoDiff from '@/features/operate/_shared/MonacoDiff.vue';
import DestructiveConfirm from '@/features/operate/_shared/DestructiveConfirm.vue';
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

// A structural apply (revert-to-bundled, storage-change save) runs past
// OAP's admin request timeout, so the mutation returns `pending` before it
// lands. Poll the rule to its expected end state instead of re-firing
// (a retry just queues another waiter on OAP's per-file lock). The action
// row stays disabled via `applying` for the duration so the operator can't
// stack retries.
const applying = ref(false);
async function trackApply(op: 'revert' | 'inactivate' | 'delete'): Promise<void> {
  applying.value = true;
  setFlash(t('submitted — OAP is applying it; a structural apply can take a minute…'));
  const done =
    op === 'revert'
      ? (r: RuleResponse | null): boolean => r != null && (r.status === 'BUNDLED' || r.status === 'STATIC')
      : op === 'inactivate'
        ? (r: RuleResponse | null): boolean => r?.status === 'INACTIVE'
        : (r: RuleResponse | null): boolean => r === null;
  const res = await editor.awaitApplied(done);
  applying.value = false;
  if (res === 'applied') {
    setFlash(t('applied ✓'));
    if (op === 'delete') {
      await router.push({ name: 'catalog', params: { catalog: catalog.value ?? '' } });
    }
  } else {
    setFlash(t('still applying on OAP — refresh in a moment to confirm'));
  }
}

async function onSave(): Promise<void> {
  const r = await editor.save({ force: force.value });
  if (r.kind === 'ok') {
    setFlash(t('saved · {status}', { status: r.result.applyStatus }));
    return;
  }
  if (r.kind === 'error') {
    setFlash(extractErrorMessage(r.error));
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
        if (ok.kind === 'ok') setFlash(t('saved · {status}', { status: ok.result.applyStatus }));
        else if (ok.kind === 'error') setFlash(extractErrorMessage(ok.error));
      },
    };
  }
}

async function onInactivate(): Promise<void> {
  const r = await editor.inactivate();
  if (r.kind === 'ok') {
    setFlash(t('inactivated · {status}', { status: r.result.applyStatus }));
    return;
  }
  if (r.kind === 'pending') {
    void trackApply('inactivate');
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
    void trackApply('delete');
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
      t('Returns 400 no_bundled_twin if the rule has no bundled version on disk.'),
    ],
    perform: async () => {
      const r = await editor.deleteRule('revertToBundled');
      if (r.kind === 'ok') {
        setFlash(t('reverted · {status}', { status: r.result.applyStatus }));
        await router.push({ name: 'catalog', params: { catalog: catalog.value ?? '' } });
        return;
      }
      if (r.kind === 'pending') {
        void trackApply('revert');
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
// a stale fetch resolving after a newer rule was selected.
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
      <Pill v-if="!applying && editor.lastApplyStatus.value" tone="info">
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
        :disabled="!canWrite || !editor.dirty.value || editor.saving.value || applying"
        :data-testid="'editor-save'"
        @click="onSave"
      >
        {{ editor.saving.value ? t('saving…') : t('save') }}
      </Btn>
      <!-- Inactivate only applies to an ACTIVE operator row — hidden once
           the rule is already INACTIVE (or a pure bundled rule). -->
      <Btn
        v-if="editor.original.value?.status === 'ACTIVE'"
        :disabled="!canWrite || editor.saving.value || applying"
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
        :disabled="!canDelete || editor.saving.value || applying"
        @click="onDeleteDefault"
      >
        {{ t('delete') }}
      </Btn>
      <Btn
        v-if="isOperatorRow && hasBundledTwin"
        kind="danger"
        :disabled="!canDelete || !canWriteStructural || editor.saving.value || applying"
        :data-testid="'editor-revert'"
        @click="onDeleteRevertToBundled"
      >
        {{ t('revert to bundled') }}
      </Btn>
    </div>

    <p v-if="flash" class="ed__flash" :data-testid="'editor-flash'">{{ flash }}</p>

    <div class="ed__editorWrap">
      <div v-if="editor.loading.value" class="ed__placeholder">{{ t('loading…') }}</div>
      <div v-else-if="editor.loadError.value" class="ed__placeholder ed__placeholder--err">
        {{ t('Could not load: {err}', { err: editor.loadError.value }) }}
      </div>

      <MonacoYaml
        v-else-if="diffMode === 'none'"
        :model-value="editor.buffer.value"
        :catalog="catalog"
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
