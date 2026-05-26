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
import { computed, ref, shallowRef } from 'vue';
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

async function onSave(): Promise<void> {
  const r = await editor.save({ force: force.value });
  if (r.kind === 'ok') {
    setFlash(`saved · ${r.result.applyStatus}`);
    return;
  }
  if (r.kind === 'error') {
    setFlash(extractErrorMessage(r.error));
    return;
  }
  if (r.kind === 'needs-storage-change') {
    confirm.value = {
      title: 'Storage change required',
      intent: 'push a STRUCTURAL change to',
      warning: [
        'This edit moves the metric’s storage identity (scope, downsampling, or single↔labeled↔histogram).',
        'OAP drops the existing measure’s data on BanyanDB and orphans rows on JDBC / Elasticsearch.',
        'Alarm rules, dashboards, and historical queries that reference the old shape will miss the pre-change window.',
      ],
      perform: async () => {
        const ok = await editor.save({ allowStorageChange: true, force: force.value });
        if (ok.kind === 'ok') setFlash(`saved · ${ok.result.applyStatus}`);
        else if (ok.kind === 'error') setFlash(extractErrorMessage(ok.error));
      },
    };
  }
}

async function onInactivate(): Promise<void> {
  const r = await editor.inactivate();
  if (r.kind === 'ok') {
    setFlash(`inactivated · ${r.result.applyStatus}`);
    return;
  }
  if (r.kind === 'error') {
    setFlash(extractErrorMessage(r.error));
  }
}

async function onDeleteDefault(): Promise<void> {
  const r = await editor.deleteRule('');
  if (r.kind === 'ok') {
    setFlash(`deleted · ${r.result.applyStatus}`);
    await router.push({ name: 'catalog', params: { catalog: catalog.value ?? '' } });
    return;
  }
  if (r.kind === 'needs-inactivate-first') {
    setFlash('rule is ACTIVE — inactivate first, then delete');
    return;
  }
  if (r.kind === 'error') {
    setFlash(extractErrorMessage(r.error));
    return;
  }
  // 'no-bundled-twin' shouldn't reach the default-delete path.
  setFlash(`unexpected outcome: ${r.kind}`);
}

function onDeleteRevertToBundled(): void {
  if (!name.value) return;
  confirm.value = {
    title: 'Revert to bundled',
    intent: 'revert to bundled (STRUCTURAL apply)',
    warning: [
      'OAP runs the standard apply pipeline against the bundled YAML — this is a schema change.',
      'Runtime-only metrics that the bundled rule does not define will be dropped from BanyanDB.',
      'Bundled-only metrics will be installed.',
      'Returns 400 no_bundled_twin if the rule has no bundled version on disk.',
    ],
    perform: async () => {
      const r = await editor.deleteRule('revertToBundled');
      if (r.kind === 'ok') {
        setFlash(`reverted · ${r.result.applyStatus}`);
        await router.push({ name: 'catalog', params: { catalog: catalog.value ?? '' } });
        return;
      }
      if (r.kind === 'no-bundled-twin') {
        setFlash('no bundled version on disk for this rule');
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
      diffLoadError.value = 'no bundled version on disk for this rule';
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

const hasBundledTwin = computed(
  () => editor.original.value?.source === 'static' || bundled.value !== null,
);
</script>

<template>
  <div class="ed">
    <AdminFeatureWarning module="receiver-runtime-rule" feature-label="DSL Editor" />
    <header class="ed__header">
      <h1 class="ed__h1">
        <span class="ed__catalog">{{ catalog ?? '?' }}</span>
        <span class="ed__sep">/</span>
        <span class="ed__name">{{ name ?? '?' }}</span>
      </h1>
      <Pill v-if="editor.original.value" :tone="statusTone">
        {{ editor.original.value.status }}
      </Pill>
      <Pill v-if="editor.dirty.value" tone="active">unsaved</Pill>
      <Pill v-if="editor.lastApplyStatus.value" tone="info">
        {{ editor.lastApplyStatus.value }}
      </Pill>
      <div class="ed__spacer" />
      <Btn @click="router.back()">← catalog</Btn>
    </header>

    <div class="ed__toolbar">
      <div class="ed__diffgroup">
        <button
          type="button"
          class="ed__tab"
          :class="{ 'ed__tab--active': diffMode === 'none' }"
          @click="setDiffMode('none')"
        >
          edit
        </button>
        <button
          type="button"
          class="ed__tab"
          :class="{ 'ed__tab--active': diffMode === 'current' }"
          :disabled="!editor.original.value"
          @click="setDiffMode('current')"
        >
          diff vs. server
        </button>
        <button
          type="button"
          class="ed__tab"
          :class="{ 'ed__tab--active': diffMode === 'bundled' }"
          @click="setDiffMode('bundled')"
        >
          diff vs. bundled
        </button>
      </div>

      <div class="ed__spacer" />

      <Btn
        kind="primary"
        :disabled="!canWrite || !editor.dirty.value || editor.saving.value"
        :data-testid="'editor-save'"
        @click="onSave"
      >
        {{ editor.saving.value ? 'saving…' : 'save' }}
      </Btn>
      <Btn
        :disabled="!canWrite || !editor.exists.value || editor.saving.value"
        @click="onInactivate"
      >
        inactivate
      </Btn>
      <Btn
        kind="danger"
        :disabled="!canDelete || !editor.exists.value || editor.saving.value"
        @click="onDeleteDefault"
      >
        delete
      </Btn>
      <Btn
        v-if="hasBundledTwin"
        kind="danger"
        :disabled="!canDelete || !canWriteStructural || editor.saving.value"
        :data-testid="'editor-revert'"
        @click="onDeleteRevertToBundled"
      >
        revert to bundled
      </Btn>
    </div>

    <p v-if="flash" class="ed__flash" :data-testid="'editor-flash'">{{ flash }}</p>

    <div class="ed__editorWrap">
      <div v-if="editor.loading.value" class="ed__placeholder">loading…</div>
      <div v-else-if="editor.loadError.value" class="ed__placeholder ed__placeholder--err">
        Could not load: {{ editor.loadError.value }}
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
        <p v-else class="ed__placeholder">loading bundled…</p>
      </div>
    </div>

    <details
      class="ed__advanced"
      :open="showAdvanced"
      @toggle="(e: Event) => (showAdvanced = (e.target as HTMLDetailsElement).open)"
    >
      <summary>advanced</summary>
      <label class="ed__force">
        <input v-model="force" type="checkbox" :disabled="!canWriteStructural" />
        <span>
          recovery: <code>force=true</code> on save
          <small>
            re-runs apply on byte-identical content (subsumes the old <code>/fix</code>
            route). Requires <code>rule:write:structural</code>.
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
  font-size: 13px;
  font-weight: 500;
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
  font-size: 11.5px;
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
  font-size: 12px;
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
  font-size: 12px;
  color: var(--rr-dim);
}

.ed__placeholder--err {
  color: var(--rr-err);
}

.ed__advanced {
  font-size: 12px;
  color: var(--rr-ink2);
}

.ed__advanced summary {
  cursor: pointer;
  font-family: var(--rr-font-mono);
  color: var(--rr-dim);
  letter-spacing: 0.4px;
  padding: 4px 0;
}

.ed__force {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--rr-ink2);
}

.ed__force code {
  font-family: var(--rr-font-mono);
  color: var(--rr-info);
}

.ed__force small {
  display: block;
  font-size: 11.5px;
  color: var(--rr-dim);
  line-height: 1.4;
  margin-top: 2px;
}
</style>
