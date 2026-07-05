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
<!--
  Admin view for the Alarms page setup. The operator pins a small set
  of OAP layers — those layers get a dedicated KPI tile at the top of
  the Alarms page (TOTAL · pinned-1 · pinned-2 · …); every other
  layer with at least one firing alarm appears in the overflow chip
  row underneath. Order here is render order on the page.

  Defaults seed `GENERAL` (agent) + `MESH` (mesh) — the two most
  common drivers of alarm volume on every install.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useLayers } from '@/shell/useLayers';
import {
  ALARMS_WINDOW_OPTIONS,
  OVERVIEW_ALARMS_LIMIT_DEFAULT,
  OVERVIEW_ALARMS_LIMIT_MAX,
  OVERVIEW_ALARMS_LIMIT_MIN,
  bff,
  type AlarmsConfig,
} from '@/api/client';
import SyncStatusBanner from '@/features/admin/_shared/SyncStatusBanner.vue';
import TemplateDiffModal from '@/features/admin/_shared/TemplateDiffModal.vue';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import { refreshConfigBundle } from '@/controls/configBundle';

const { t } = useI18n({ useScope: 'global' });
const queryClient = useQueryClient();

// OAP UI-template sync status for the alert page-setup template
// (`horizon.alert.page-setup`). Drives the read-only banner + Save
// gating + the diff-and-reset modal (defined later, after the local
// fns it references are in scope).
const sync = useTemplateSync({ kind: 'alert' });

/* Cap matches the BFF's `configSaveSchema.max(8)` — keeps the header
 * row from wrapping into a second line at typical widths. */
const MAX_PINNED = 8;

const WINDOW_LABELS = computed<Record<number, string>>(() => ({
  [20 * 60_000]: t('20 minutes'),
  [2 * 60 * 60_000]: t('2 hours'),
  [4 * 60 * 60_000]: t('4 hours'),
}));

const layersList = useLayers();
const knownLayerKeys = computed<string[]>(() =>
  (layersList.availableLayers.value ?? []).map((l) => l.key.toUpperCase()),
);

const q = useQuery({
  queryKey: ['alarms/config'],
  queryFn: (): Promise<AlarmsConfig> => bff.alarms.config(),
  staleTime: Infinity,
});

const draft = ref<string[]>([]);
const draftWindowMs = ref<number>(ALARMS_WINDOW_OPTIONS[0]);
const draftLimit = ref<number>(OVERVIEW_ALARMS_LIMIT_DEFAULT);
const limitError = ref<string | null>(null);

watch(
  () => q.data.value,
  (cfg) => {
    if (cfg) {
      draft.value = [...cfg.pinnedLayers];
      draftWindowMs.value = cfg.defaultWindowMs;
      draftLimit.value = cfg.overviewAlarmsLimit;
    }
  },
  { immediate: true },
);

function validateLimit(): boolean {
  const v = Number(draftLimit.value);
  if (!Number.isInteger(v)) {
    limitError.value = t('must be an integer');
    return false;
  }
  if (v < OVERVIEW_ALARMS_LIMIT_MIN || v > OVERVIEW_ALARMS_LIMIT_MAX) {
    limitError.value = t('must be between {min} and {max}', { min: OVERVIEW_ALARMS_LIMIT_MIN, max: OVERVIEW_ALARMS_LIMIT_MAX });
    return false;
  }
  limitError.value = null;
  return true;
}

const flash = ref<string | null>(null);
const saving = ref(false);

function setFlash(msg: string): void {
  flash.value = msg;
  setTimeout(() => {
    if (flash.value === msg) flash.value = null;
  }, 4000);
}

// Diff & reset modal — alert page-setup is a singleton, so the
// trigger lives near the Save button instead of per-row.
const alertStatus = computed(() => sync.badgeFor('horizon.alert.page-setup'));
const alertDiverged = computed(() => alertStatus.value === 'diverged');
const diffModalOpen = ref(false);
function openDiffModal(): void { diffModalOpen.value = true; }
function onDiffReset(): void {
  setFlash(t('OAP reset to bundled · reload to see header changes'));
  void q.refetch();
}

/* Layers the operator can still add — known to OAP AND not already
 * pinned. Pinned-but-unknown layers (e.g. an older install removed a
 * layer that's still in the saved config) stay rendered as pinned
 * chips so the operator can remove them; they just don't appear in
 * the "add" palette. */
const addableLayers = computed<string[]>(() => {
  const used = new Set(draft.value);
  return knownLayerKeys.value.filter((k) => !used.has(k)).sort();
});

function addLayer(key: string): void {
  if (draft.value.includes(key)) return;
  if (draft.value.length >= MAX_PINNED) return;
  draft.value = [...draft.value, key];
}

function removeLayer(i: number): void {
  draft.value = draft.value.filter((_, j) => j !== i);
}

function moveLayer(i: number, dir: -1 | 1): void {
  const next = [...draft.value];
  const j = i + dir;
  if (j < 0 || j >= next.length) return;
  [next[i], next[j]] = [next[j], next[i]];
  draft.value = next;
}

async function onSave(): Promise<void> {
  if (!validateLimit()) return;
  if (sync.readOnly.value) {
    setFlash(t('cannot save — OAP is unreachable, page is read-only'));
    return;
  }
  saving.value = true;
  try {
    const next: AlarmsConfig = {
      pinnedLayers: draft.value,
      defaultWindowMs: draftWindowMs.value,
      overviewAlarmsLimit: Number(draftLimit.value),
    };
    // Save to OAP via the template-sync proxy (canonical envelope wrapped
    // server-side) — the alert page-setup is the `horizon.alert.page-setup`
    // singleton, stored only on OAP like every other template.
    await bff.templateSync.save('horizon.alert.page-setup', next);
    // Wait for the write to land, then refresh so BOTH the page's sync-status
    // badge and every reader reflect it: resync drops the BFF's 30s sync cache,
    // then re-pull the config bundle (which drives the "Synced / Diverged"
    // badge) and invalidate the shared ['alarms/config'] query (alarms page +
    // topbar badge + overview widget). Mirrors the singleton editor's push.
    await bff.templateSync.resync();
    await refreshConfigBundle({ force: true });
    await queryClient.invalidateQueries({ queryKey: ['alarms/config'] });
    draft.value = [...next.pinnedLayers];
    draftWindowMs.value = next.defaultWindowMs;
    draftLimit.value = next.overviewAlarmsLimit;
    setFlash(
      t('saved · {pinned} pinned · {window} · limit {limit}', {
        pinned: next.pinnedLayers.length,
        window: WINDOW_LABELS.value[next.defaultWindowMs] ?? '—',
        limit: next.overviewAlarmsLimit,
      }),
    );
  } catch (err) {
    setFlash(err instanceof Error ? t('error: {msg}', { msg: err.message }) : t('save failed'));
  } finally {
    saving.value = false;
  }
}

function onReset(): void {
  if (q.data.value) {
    draft.value = [...q.data.value.pinnedLayers];
    draftWindowMs.value = q.data.value.defaultWindowMs;
    draftLimit.value = q.data.value.overviewAlarmsLimit;
    limitError.value = null;
  }
}

const isDirty = computed<boolean>(() => {
  const saved = q.data.value?.pinnedLayers ?? [];
  if (saved.length !== draft.value.length) return true;
  for (let i = 0; i < saved.length; i++) {
    if (saved[i] !== draft.value[i]) return true;
  }
  if (q.data.value) {
    if (draftWindowMs.value !== q.data.value.defaultWindowMs) return true;
    if (Number(draftLimit.value) !== q.data.value.overviewAlarmsLimit) return true;
  }
  return false;
});

function prettyLayer(k: string): string {
  return k
    .toLowerCase()
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}
</script>

<template>
  <div class="aps">
    <header class="aps__head">
      <div>
        <div class="aps__kicker">{{ t('Dashboard setup · Alert page') }}</div>
        <h1>{{ t('Alert page setup') }}</h1>
        <p class="aps__lede">
          <!-- Single translation unit so non-English locales see one coherent
               sentence; the agent's earlier split-into-three-t-calls left
               operators on zh-CN/de seeing English prose with one Chinese
               word in the middle. -->
          <i18n-t keypath="Pin the OAP layers that get their own KPI tile at the top of {alarms}." tag="span" scope="global">
            <template #alarms><RouterLink to="/alarms">{{ t('Alarms') }}</RouterLink></template>
          </i18n-t>
          {{ ' ' }}
          {{ t('Every other layer with at least one firing alarm appears in the overflow chip row underneath. Reorder with the arrows — left-to-right matches the page header. Up to {n} layers.', { n: MAX_PINNED }) }}
        </p>
      </div>
    </header>

    <SyncStatusBanner :banner="sync.banner.value" />

    <div v-if="q.isPending.value" class="aps__empty">{{ t('loading…') }}</div>

    <template v-else>
      <section class="aps__panel">
        <header class="aps__panel-head">
          <h3>{{ t('Pinned ({n} / {max})', { n: draft.length, max: MAX_PINNED }) }}</h3>
        </header>
        <div v-if="draft.length === 0" class="aps__empty-row">
          {{ t('No pinned layers. Add one from the palette below.') }}
        </div>
        <ol v-else class="aps__pinned">
          <li v-for="(key, i) in draft" :key="key" class="aps__pin">
            <button
              type="button"
              class="aps__pin-arrow"
              :disabled="i === 0"
              :title="t('Move left')"
              @click="moveLayer(i, -1)"
            >‹</button>
            <span class="aps__pin-pos mono">{{ i + 1 }}</span>
            <span class="aps__pin-label">{{ prettyLayer(key) }}</span>
            <code class="aps__pin-key">{{ key }}</code>
            <button
              type="button"
              class="aps__pin-arrow"
              :disabled="i === draft.length - 1"
              :title="t('Move right')"
              @click="moveLayer(i, 1)"
            >›</button>
            <button
              type="button"
              class="aps__pin-del"
              :title="t('Unpin')"
              @click="removeLayer(i)"
            >×</button>
          </li>
        </ol>
      </section>

      <section class="aps__panel">
        <header class="aps__panel-head">
          <h3>{{ t('Default time window') }}</h3>
        </header>
        <div class="aps__win">
          <p class="aps__win-lede">
            {{ t('Time window applied to all three alarm surfaces — the topbar alarm badge, the alarms page\'s first load, and the overview "Active alarms" widget. Unified here so the counts reconcile across pages.') }}
          </p>
          <div class="aps__win-options">
            <label
              v-for="opt in ALARMS_WINDOW_OPTIONS"
              :key="opt"
              class="aps__win-opt"
              :class="{ active: draftWindowMs === opt }"
            >
              <input
                type="radio"
                name="defaultWindow"
                :value="opt"
                v-model="draftWindowMs"
              />
              <span>{{ WINDOW_LABELS[opt] }}</span>
            </label>
          </div>
        </div>
      </section>

      <section class="aps__panel">
        <header class="aps__panel-head">
          <h3>{{ t('Overview alarms widget') }}</h3>
        </header>
        <div class="aps__win">
          <p class="aps__win-lede">
            {{ t('Per-poll fetch cap for the "Active alarms" widget on overview dashboards. The widget merges the fetched events into incidents client-side and surfaces the top N by recency. Higher caps catch more variety in noisy installs; smaller caps cut the per-poll payload. Range') }}
            <code>{{ OVERVIEW_ALARMS_LIMIT_MIN }}</code>–<code>{{ OVERVIEW_ALARMS_LIMIT_MAX }}</code>,
            {{ t('default') }} <code>{{ OVERVIEW_ALARMS_LIMIT_DEFAULT }}</code>.
          </p>
          <div class="aps__limit">
            <label>
              <span>{{ t('Fetch cap') }}</span>
              <input
                v-model.number="draftLimit"
                type="number"
                :min="OVERVIEW_ALARMS_LIMIT_MIN"
                :max="OVERVIEW_ALARMS_LIMIT_MAX"
                step="10"
                class="aps__in aps__in--num"
                @blur="validateLimit"
              />
            </label>
            <span v-if="limitError" class="aps__limit-err">{{ limitError }}</span>
          </div>
        </div>
      </section>

      <section class="aps__panel">
        <header class="aps__panel-head">
          <h3>{{ t('Add layer') }}</h3>
        </header>
        <div v-if="addableLayers.length === 0" class="aps__empty-row">
          {{ t('Every OAP-known layer is already pinned.') }}
        </div>
        <div v-else class="aps__add">
          <button
            v-for="key in addableLayers"
            :key="key"
            type="button"
            class="aps__add-chip"
            :disabled="draft.length >= MAX_PINNED"
            @click="addLayer(key)"
          >
            <span>+ {{ prettyLayer(key) }}</span>
            <code>{{ key }}</code>
          </button>
        </div>
      </section>
    </template>

    <div class="aps__actions">
      <span v-if="flash" class="aps__flash">{{ flash }}</span>
      <span v-else-if="isDirty" class="aps__dirty">{{ t('unsaved changes') }}</span>
      <span v-else class="aps__clean">{{ t('saved') }}</span>
      <button
        type="button"
        class="aps__btn"
        :disabled="!isDirty || saving"
        @click="onReset"
      >{{ t('reset') }}</button>
      <button
        v-if="alertDiverged && !sync.readOnly.value"
        type="button"
        class="aps__btn"
        :title="t('Show side-by-side diff vs OAP, and reset OAP back to bundled (with confirmation).')"
        @click="openDiffModal"
      >{{ t('show diff & reset') }}</button>
      <button
        type="button"
        class="aps__btn aps__btn--primary"
        :disabled="!isDirty || saving || sync.readOnly.value"
        :title="sync.readOnly.value ? t('OAP unreachable — page is read-only') : ''"
        @click="onSave"
      >{{ saving ? t('saving…') : sync.readOnly.value ? t('read-only') : t('save to OAP') }}</button>
    </div>

    <TemplateDiffModal
      :open="diffModalOpen"
      name="horizon.alert.page-setup"
      confirm-key="page-setup"
      @close="diffModalOpen = false"
      @reset="onDiffReset"
    />
  </div>
</template>

<style scoped>
.aps {
  padding: 20px 20px 60px;
  max-width: 1100px;
  margin: 0 auto;
}
.aps__head {
  margin-bottom: 18px;
}
/* Page-title kicker. Same uppercase typography as `.sw-uplabel`, but
 * accent-coloured so the kicker reads as a branded crumb above the
 * page title (matches the Layer Dashboards + Overview Templates admin
 * pages). The standardised uppercase-label colour `--sw-fg-3` is too
 * muted for a top-of-page kicker. */
.aps__kicker {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.aps h1 {
  font-size: var(--sw-fs-2xl);
  font-weight: var(--sw-fw-semibold);
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.aps__lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 760px;
}
.aps__lede a {
  color: var(--sw-accent);
  text-decoration: none;
}
.aps__lede a:hover {
  text-decoration: underline;
}
.aps__lede code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.aps__empty {
  padding: 24px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-base);
}

.aps__panel {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  margin-bottom: 14px;
  overflow: hidden;
}
.aps__panel-head {
  padding: 8px 14px;
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.aps__panel-head h3 {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  margin: 0;
}
.aps__empty-row {
  padding: 20px 14px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-base);
}

.aps__pinned {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.aps__pin {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
}
.aps__pin-pos {
  font-size: var(--sw-fs-xs);
  color: var(--sw-accent);
  font-weight: var(--sw-fw-semibold);
}
.aps__pin-label {
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-medium);
  color: var(--sw-fg-0);
}
.aps__pin-key {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  background: var(--sw-bg-1);
  padding: 1px 5px;
  border-radius: 3px;
}
.aps__pin-arrow,
.aps__pin-del {
  background: transparent;
  border: 0;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: var(--sw-fs-lg);
  line-height: 1;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  cursor: pointer;
}
.aps__pin-arrow:not(:disabled):hover {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
}
.aps__pin-arrow:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.aps__pin-del:hover {
  background: var(--sw-err-soft);
  color: var(--sw-err);
}

.aps__win { padding: 10px 14px 12px; }
.aps__win-lede {
  margin: 0 0 8px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
  line-height: 1.5;
}
.aps__win-options {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.aps__win-opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
  cursor: pointer;
}
.aps__win-opt input { margin: 0; cursor: pointer; }
.aps__win-opt:hover { border-color: var(--sw-line-2); color: var(--sw-fg-0); }
.aps__win-opt.active {
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
  background: var(--sw-bg-3);
}
.aps__limit {
  display: flex;
  align-items: center;
  gap: 12px;
}
.aps__limit label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.aps__in--num {
  width: 100px;
  font-variant-numeric: tabular-nums;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-base);
  padding: 5px 8px;
  border-radius: 4px;
}
.aps__limit-err {
  color: var(--sw-err);
  font-size: var(--sw-fs-sm);
}

.aps__add {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px;
}
.aps__add-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.aps__add-chip:not(:disabled):hover {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  border-color: var(--sw-line-2);
}
.aps__add-chip:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.aps__add-chip code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}

.aps__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.aps__flash {
  font-size: var(--sw-fs-sm);
  color: var(--sw-ok);
  margin-right: auto;
}
.aps__dirty {
  font-size: var(--sw-fs-sm);
  color: var(--sw-warn);
  margin-right: auto;
}
.aps__clean {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  margin-right: auto;
}
.aps__btn {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-base);
  padding: 6px 14px;
  border-radius: 4px;
  cursor: pointer;
}
.aps__btn:not(:disabled):hover {
  background: var(--sw-bg-2);
}
.aps__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.aps__btn--primary {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: var(--sw-fw-semibold);
}
.aps__btn--primary:not(:disabled):hover {
  background: var(--sw-accent-light, #fb923c);
}
</style>
