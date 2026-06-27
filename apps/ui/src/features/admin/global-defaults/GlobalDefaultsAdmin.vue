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
  Admin: global defaults — theme + time-defaults in one place.

  Two singletons on OAP (`horizon.theme.active`, `horizon.time-defaults.global`)
  share this page because both are "set once, leave" preferences. The
  five themes themselves are code-shipped CSS files — operators pick one;
  they don't author a theme here. Time-defaults captures the topbar
  global picker's default window (the only knob — refresh interval and
  triage-page time stay code defaults).

  Per-user overrides land in localStorage and surface in the topbar
  (theme chip + time-picker overflow). This page is the org-default
  setting.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import SyncStatusBanner from '@/features/admin/_shared/SyncStatusBanner.vue';
import TemplateStatusBadge from '@/features/admin/_shared/TemplateStatusBadge.vue';
import TemplateDiffModal from '@/features/admin/_shared/TemplateDiffModal.vue';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import { AVAILABLE_THEMES, useThemeStore, type ThemeId } from '@/state/theme';
import ThemePreviewCard from './ThemePreviewCard.vue';

const { t } = useI18n();

// Theme store — for distinguishing the currently-ACTIVE theme (what the
// renderer is showing right now, combining user override + org default
// + bundled) from the operator's pending SELECTION in this picker.
const themeStoreRef = useThemeStore();

// Two kinds in scope; we union by reading them both as separate sync
// calls (`useTemplateSync` is per-kind, so we call it twice).
const themeSync = useTemplateSync({ kind: 'theme' });
const timeSync = useTemplateSync({ kind: 'time-defaults' });

// readOnly is shared — both kinds depend on the same OAP admin
// reachability. The composables return the same value because
// syncStatus.unreachable is a global flag.
const readOnly = computed<boolean>(() => themeSync.readOnly.value);

const themeStatus = computed(() => themeSync.badgeFor('horizon.theme.active'));
const timeStatus = computed(() => timeSync.badgeFor('horizon.time-defaults.global'));
const themeDiverged = computed(() => themeStatus.value === 'diverged');
const timeDiverged = computed(() => timeStatus.value === 'diverged');

// We hydrate from the bundle's syncStatus (badge tells us what's there,
// but not the value); call sync-status once on mount to get the live
// values. After save, refetch.
const themeDraft = ref<ThemeId>('horizon');
const timeDraftMinutes = ref<number>(60);
const orig = ref<{ themeId: ThemeId; minutes: number } | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function loadFromOap(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const status = await bff.templateSync.syncStatus();
    const themeRow = status.rows.find((r) => r.name === 'horizon.theme.active');
    const timeRow = status.rows.find((r) => r.name === 'horizon.time-defaults.global');
    const themeContent = pickContent<{ themeId?: string }>(themeRow);
    const timeContent = pickContent<{ defaultWindowMinutes?: number }>(timeRow);
    const tId =
      themeContent?.themeId &&
      AVAILABLE_THEMES.some((t) => t.id === themeContent.themeId)
        ? (themeContent.themeId as ThemeId)
        : 'horizon';
    const tMin =
      typeof timeContent?.defaultWindowMinutes === 'number' &&
      Number.isInteger(timeContent.defaultWindowMinutes) &&
      timeContent.defaultWindowMinutes > 0
        ? timeContent.defaultWindowMinutes
        : 60;
    themeDraft.value = tId;
    timeDraftMinutes.value = tMin;
    orig.value = { themeId: tId, minutes: tMin };
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function pickContent<T>(row: { effective: 'remote' | 'bundled' | null; remote: { configuration: string } | null; bundled: { configuration: string } | null } | undefined): T | null {
  if (!row) return null;
  const source = row.effective === 'remote' && row.remote ? row.remote.configuration : row.bundled?.configuration;
  if (!source) return null;
  try {
    const envelope = JSON.parse(source) as { content?: T };
    return envelope.content ?? null;
  } catch {
    return null;
  }
}

void loadFromOap();

// Re-fetch whenever the syncStatus generation changes (operator hit a
// resync elsewhere, etc.).
watch(
  () => themeSync.status.value?.generatedAt,
  () => { void loadFromOap(); },
);

const saving = ref(false);
const flash = ref<string | null>(null);
function setFlash(msg: string): void {
  flash.value = msg;
  setTimeout(() => { if (flash.value === msg) flash.value = null; }, 4000);
}

const themeDirty = computed(() => orig.value !== null && themeDraft.value !== orig.value.themeId);
const timeDirty = computed(() => orig.value !== null && timeDraftMinutes.value !== orig.value.minutes);
const dirty = computed(() => themeDirty.value || timeDirty.value);

async function onSave(): Promise<void> {
  if (!dirty.value || saving.value) return;
  if (readOnly.value) {
    setFlash(t('cannot save — OAP is unreachable, page is read-only'));
    return;
  }
  saving.value = true;
  try {
    // Batched as two separate /api/admin/templates/save calls (each
    // template is a distinct OAP row). If the second fails the first
    // still landed — surface the partial state to the operator.
    if (themeDirty.value) {
      await bff.templateSync.save('horizon.theme.active', { themeId: themeDraft.value });
    }
    if (timeDirty.value) {
      await bff.templateSync.save('horizon.time-defaults.global', {
        defaultWindowMinutes: timeDraftMinutes.value,
      });
    }
    await loadFromOap();
    setFlash(t('saved to OAP'));
  } catch (err) {
    setFlash(err instanceof Error ? t('save failed: {msg}', { msg: err.message }) : t('save failed'));
  } finally {
    saving.value = false;
  }
}

function onReset(): void {
  if (orig.value) {
    themeDraft.value = orig.value.themeId;
    timeDraftMinutes.value = orig.value.minutes;
  }
}

// A small whitelist — operators can pick from these or type a custom
// number. Step precision (the OAP `Duration.step` value) is derived
// from the window size automatically: ≤ 4h → MINUTE, 6h…14d → HOUR,
// ≥ 30d → DAY. The thresholds match the timeRange store's
// TIME_PRESETS table and OAP's `DurationUtils` mapping (see
// CLAUDE.md "Time, step, and timezone").
const PRESETS = [
  { label: '15 m', value: 15 },
  { label: '30 m', value: 30 },
  { label: '1 h', value: 60 },
  { label: '2 h', value: 120 },
  { label: '4 h', value: 240 },
  { label: '12 h', value: 720 },
  { label: '24 h', value: 1440 },
  { label: '7 d', value: 10080 },
];

/** Resolve the OAP `step` precision for a given window in minutes.
 *  Mirrors the TIME_PRESETS thresholds in `controls/timeRange.ts`. */
function precisionForMinutes(m: number): 'MINUTE' | 'HOUR' | 'DAY' {
  if (m <= 240) return 'MINUTE';        // ≤ 4 h
  if (m < 30 * 24 * 60) return 'HOUR';  // < 30 d
  return 'DAY';
}
const draftPrecision = computed(() => precisionForMinutes(timeDraftMinutes.value));
const draftBucketCount = computed(() => {
  const m = timeDraftMinutes.value;
  // 60-min window @ MINUTE step → 60 one-minute buckets;
  // hour-precision divides by 60, day-precision by 60*24.
  if (draftPrecision.value === 'MINUTE') return m;
  if (draftPrecision.value === 'HOUR') return Math.round(m / 60);
  return Math.round(m / 60 / 24);
});

const themeDiffOpen = ref(false);
const timeDiffOpen = ref(false);
async function onDiffReset(): Promise<void> {
  await loadFromOap();
  setFlash(t('OAP reset to bundled — reload to pick up the change'));
}
</script>

<template>
  <div class="gd">
    <header class="gd__head">
      <div>
        <div class="gd__kicker">{{ t('Dashboard setup · Global defaults') }}</div>
        <h1>{{ t('Global defaults') }}</h1>
        <p class="gd__lede">
          {{ t('Org-wide defaults for the UI theme and the topbar\'s default time window. Both can be overridden per-user in the browser (theme chip in the topbar, "Save as my default" in the time picker). Edits here write to OAP; bundled JSON is the seed + read-only fallback.') }}
        </p>
      </div>
    </header>

    <SyncStatusBanner :banner="themeSync.banner.value" />

    <div v-if="loading" class="gd__empty">{{ t('Loading from OAP…') }}</div>
    <div v-else-if="loadError" class="gd__err">{{ loadError }}</div>

    <template v-else>
      <section class="gd__section">
        <header class="gd__sec-head">
          <h2>{{ t('Theme') }}</h2>
          <TemplateStatusBadge :status="themeStatus" />
          <button
            v-if="themeDiverged && !readOnly"
            type="button"
            class="gd__small"
            @click="themeDiffOpen = true"
          >{{ t('show diff & reset') }}</button>
        </header>
        <p class="gd__sec-lede">
          {{ t('Five bundled themes ship with Horizon. The org default is the starting theme every user sees on first visit. Each user can override locally via the topbar theme chip (stored in {key}).', { key: "localStorage['horizon:theme:user']" }) }}
        </p>
        <div class="gd__theme-grid">
          <ThemePreviewCard
            v-for="t in AVAILABLE_THEMES"
            :key="t.id"
            :theme="t"
            :selected="themeDraft === t.id"
            :active="themeStoreRef.active === t.id"
            @pick="!readOnly && (themeDraft = t.id)"
          />
        </div>
      </section>

      <section class="gd__section">
        <header class="gd__sec-head">
          <h2>{{ t('Default time window') }}</h2>
          <TemplateStatusBadge :status="timeStatus" />
          <button
            v-if="timeDiverged && !readOnly"
            type="button"
            class="gd__small"
            @click="timeDiffOpen = true"
          >{{ t('show diff & reset') }}</button>
        </header>
        <p class="gd__sec-lede">
          <i18n-t keypath="Default window for the topbar time picker, which feeds {scope}. The OAP {step} precision is derived from the window — you don't pick it separately:" tag="span">
            <template #scope><strong>{{ t('dashboards and overviews only') }}</strong></template>
            <template #step><code>step</code></template>
          </i18n-t>
        </p>
        <ul class="gd__sec-lede gd__sec-lede--list">
          <li>
            <i18n-t keypath="{range} → {step} step (one bucket per minute)" tag="span" scope="global">
              <template #range><strong>{{ t('≤ 4 hours') }}</strong></template>
              <template #step><code>MINUTE</code></template>
            </i18n-t>
          </li>
          <li>
            <i18n-t keypath="{range} → {step} step (one bucket per hour)" tag="span" scope="global">
              <template #range><strong>{{ t('6 hours … 14 days') }}</strong></template>
              <template #step><code>HOUR</code></template>
            </i18n-t>
          </li>
          <li>
            <i18n-t keypath="{range} → {step} step (one bucket per day)" tag="span" scope="global">
              <template #range><strong>{{ t('≥ 30 days') }}</strong></template>
              <template #step><code>DAY</code></template>
            </i18n-t>
          </li>
        </ul>
        <p class="gd__sec-lede">
          <i18n-t keypath="{triage} (alarms / traces / logs / live-debugger) own their own time range and always query at {sec} precision — they are {not} affected by this setting." tag="span">
            <template #triage><strong>{{ t('Triage pages') }}</strong></template>
            <template #sec><code>SECOND</code></template>
            <template #not><em>{{ t('not') }}</em></template>
          </i18n-t>
        </p>
        <div class="gd__presets">
          <button
            v-for="p in PRESETS"
            :key="p.value"
            type="button"
            class="gd__preset"
            :class="{ active: timeDraftMinutes === p.value }"
            :disabled="readOnly"
            @click="timeDraftMinutes = p.value"
          >{{ p.label }}</button>
          <label class="gd__custom">
            {{ t('custom (min)') }}
            <input
              v-model.number="timeDraftMinutes"
              type="number"
              min="1"
              max="44640"
              :disabled="readOnly"
            />
          </label>
        </div>
        <p class="gd__resolved">
          <i18n-t keypath="{minutes} → {precision} step, {buckets} per query." tag="span">
            <template #minutes><strong>{{ t('{n} min', { n: timeDraftMinutes }) }}</strong></template>
            <template #precision><code>{{ draftPrecision }}</code></template>
            <template #buckets>{{ draftBucketCount === 1 ? t('{n} bucket', { n: draftBucketCount }) : t('{n} buckets', { n: draftBucketCount }) }}</template>
          </i18n-t>
        </p>
      </section>

      <footer class="gd__actions">
        <span v-if="flash" class="gd__flash">{{ flash }}</span>
        <span v-else-if="dirty" class="gd__dirty">{{ t('unsaved changes') }}</span>
        <span v-else class="gd__clean">{{ t('saved') }}</span>
        <button
          type="button"
          class="gd__btn"
          :disabled="!dirty || saving"
          @click="onReset"
        >{{ t('reset') }}</button>
        <button
          type="button"
          class="gd__btn gd__btn--primary"
          :disabled="!dirty || saving || readOnly"
          :title="readOnly ? t('OAP unreachable — page is read-only') : ''"
          @click="onSave"
        >{{ saving ? t('saving…') : readOnly ? t('read-only') : t('save to OAP') }}</button>
      </footer>
    </template>

    <TemplateDiffModal
      :open="themeDiffOpen"
      name="horizon.theme.active"
      confirm-key="active"
      @close="themeDiffOpen = false"
      @reset="onDiffReset"
    />
    <TemplateDiffModal
      :open="timeDiffOpen"
      name="horizon.time-defaults.global"
      confirm-key="global"
      @close="timeDiffOpen = false"
      @reset="onDiffReset"
    />
  </div>
</template>

<style scoped>
.gd {
  padding: 20px 20px 60px;
  max-width: 1100px;
  margin: 0 auto;
  color: var(--sw-fg-1);
}
.gd__head { margin-bottom: 14px; }
/* Page-title kicker. Accent-coloured to match the rest of the admin
 * surface (Overview templates, Layer dashboards, Alert page setup);
 * the standardised uppercase-label grey `--sw-fg-3` is for in-page
 * labels (table headers, kpi captions), not the top-of-page kicker. */
.gd__kicker {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.gd h1 {
  margin: 0;
  font-size: var(--sw-fs-xl);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.gd__lede {
  margin: 6px 0 0;
  font-size: var(--sw-fs-base);
  line-height: var(--sw-lh-normal);
  color: var(--sw-fg-2);
  max-width: 880px;
}
.gd__empty, .gd__err {
  padding: 20px;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-2);
}
.gd__err { color: var(--sw-err); }

.gd__section {
  margin-top: 18px;
  padding: 16px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
}
.gd__sec-head {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 4px;
}
.gd__sec-head h2 {
  margin: 0;
  font-size: var(--sw-fs-md);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.gd__sec-lede {
  margin: 0 0 12px;
  font-size: var(--sw-fs-sm);
  line-height: var(--sw-lh-normal);
  color: var(--sw-fg-2);
}
.gd__sec-lede--list {
  list-style: disc;
  padding-left: 22px;
}
.gd__sec-lede--list li {
  margin: 2px 0;
}
.gd__sec-lede code,
.gd__resolved code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  padding: 1px 4px;
  background: var(--sw-bg-2);
  border-radius: 3px;
  color: var(--sw-fg-0);
}
.gd__resolved {
  margin: 10px 0 0;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
  padding: 6px 10px;
  border-left: 2px solid var(--sw-accent-line);
  background: var(--sw-accent-soft);
  border-radius: 0 4px 4px 0;
}
.gd__resolved strong {
  color: var(--sw-fg-0);
}

.gd__theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.gd__presets {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
}
.gd__preset {
  padding: 4px 12px;
  border: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  border-radius: 3px;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.gd__preset.active {
  border-color: var(--sw-accent-line);
  background: var(--sw-accent-soft);
  color: var(--sw-fg-0);
}
.gd__preset[disabled] { opacity: 0.5; cursor: not-allowed; }

.gd__custom {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
  margin-left: 6px;
}
.gd__custom input {
  width: 80px;
  padding: 3px 6px;
  border: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  border-radius: 3px;
  font-size: var(--sw-fs-sm);
}

.gd__actions {
  margin-top: 18px;
  display: flex; align-items: center; gap: 10px;
  justify-content: flex-end;
}
.gd__flash { font-size: var(--sw-fs-sm); color: var(--sw-ok); }
.gd__dirty { font-size: var(--sw-fs-sm); color: var(--sw-warn); }
.gd__clean { font-size: var(--sw-fs-sm); color: var(--sw-fg-3); }
.gd__btn {
  padding: 5px 14px;
  border: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  border-radius: 3px;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.gd__btn--primary {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #fff;
  font-weight: var(--sw-fw-semibold);
}
.gd__btn[disabled] { opacity: 0.5; cursor: not-allowed; }

.gd__small {
  padding: 2px 8px;
  font-size: var(--sw-fs-xs);
  border: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  border-radius: 3px;
  cursor: pointer;
}
</style>
