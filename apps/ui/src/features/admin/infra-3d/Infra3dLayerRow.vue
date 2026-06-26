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
  One dense per-layer line for the 3D-map admin: colour · key · metric
  (mqe/label/unit) · tier-select · trailing action. Two variants share this
  markup:

    - `tier`     — rendered inside a tier card; trailing action UNPINS the
      layer (× → moves it to the Unpinned bucket).
    - `unpinned` — rendered in the Unpinned section; shows the resolved
      `via` tag (→ <failover tier> / "filtered out"), highlights an
      unclassified row, and the trailing action DELETES the layer from the
      config entirely.

  The metric inputs bind straight at `row.spec.metric` (a live reference
  into the editor draft) so two-way editing stays in the parent's `draft`;
  structural mutations (colour, tier, +/⊘ metric, remove) go up as events.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { InfraLayerSpec, InfraLevelSpec } from '@/api/client';
import type { LevelVia } from './useInfra3dLevels';

/** Union of OAP-known + config-known layers. Keys are canonical upper-case;
 *  `inOap`/`inConfig` drive the row badges. */
export interface LayerRow {
  key: string;
  inOap: boolean;
  inConfig: boolean;
  hasTopology: boolean;
  spec: InfraLayerSpec | null;
}

defineProps<{
  row: LayerRow;
  variant: 'tier' | 'unpinned';
  levels: InfraLevelSpec[];
  /** Tier id this layer is explicitly pinned to, or '' when unpinned. */
  pinnedTier: string;
  /** Unpinned variant only — how the layer resolves when no tier pins it. */
  resolved?: { levelId: string | null; via: LevelVia };
  /** Unpinned variant only — resolved level's display label (for the via tag). */
  resolvedLabel?: string;
  /** Unpinned variant only — highlights a layer nothing places. */
  unclassified?: boolean;
}>();

const emit = defineEmits<{
  (e: 'set-color', value: string): void;
  (e: 'update-metric', field: 'mqe' | 'label' | 'unit', value: string): void;
  (e: 'change-tier', event: Event): void;
  (e: 'ensure-metric'): void;
  (e: 'clear-metric'): void;
  (e: 'remove'): void;
}>();

const { t } = useI18n();

function onColor(e: Event): void {
  emit('set-color', (e.target as HTMLInputElement).value);
}
function onMetric(field: 'mqe' | 'label' | 'unit', e: Event): void {
  emit('update-metric', field, (e.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="layer-row" :class="{ unclassified: variant === 'unpinned' && unclassified }">
    <input type="color" class="color-pick" :value="row.spec?.color ?? '#8a8a8a'" @input="onColor" />
    <span class="layer-key">{{ row.key }}</span>
    <template v-if="row.spec?.metric">
      <input
        class="inp mono metric-mqe"
        :value="row.spec.metric.mqe"
        :placeholder="variant === 'tier' ? t('mqe e.g. service_cpm') : 'mqe'"
        @input="(e) => onMetric('mqe', e)"
      />
      <input class="inp metric-lbl" :value="row.spec.metric.label" :placeholder="t('label')" @input="(e) => onMetric('label', e)" />
      <input class="inp metric-unit" :value="row.spec.metric.unit" :placeholder="t('unit')" @input="(e) => onMetric('unit', e)" />
      <button class="btn tiny danger" type="button" :title="t('remove metric')" @click="emit('clear-metric')">⊘</button>
    </template>
    <button v-else class="btn tiny ghost" type="button" @click="emit('ensure-metric')">{{ t('+ metric') }}</button>
    <div class="row-spacer" />
    <span
      v-if="variant === 'unpinned'"
      class="via-tag"
      :data-via="resolved?.via"
      :title="t('falls to {via}', { via: resolved?.via })"
    >
      {{ resolved?.via === 'filtered' ? t('filtered out') : '→ ' + (resolvedLabel ?? '—') }}
    </span>
    <select class="inp tier-select" :value="pinnedTier" @change="emit('change-tier', $event)">
      <option value="">{{ variant === 'tier' ? t('— unpinned —') : t('— pin to tier —') }}</option>
      <option v-for="tier in levels" :key="tier.id" :value="tier.id">{{ tier.label }}</option>
    </select>
    <button
      v-if="variant === 'tier'"
      class="btn tiny ghost"
      type="button"
      :title="t('Remove from this tier (moves to Unpinned)')"
      @click="emit('remove')"
    >
      ×
    </button>
    <button
      v-else
      class="btn tiny danger"
      type="button"
      :title="t('Delete this layer from the config entirely')"
      @click="emit('remove')"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.layer-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-1);
}
.layer-row.unclassified { border-color: rgba(239, 158, 68, 0.5); }
.color-pick {
  width: 24px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  flex: 0 0 auto;
}
.layer-key {
  font-family: var(--sw-mono-font, monospace);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  /* Fixed column so the metric fields line up across every row regardless
     of key length (GENERAL … BYTEDANCE_MINI_PROGRAM). */
  flex: 0 0 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.via-tag { font-size: 10px; color: var(--sw-fg-3); white-space: nowrap; flex: 0 0 auto; }
.via-tag[data-via='default'],
.via-tag[data-via='filtered'] { color: #f0a04b; }
.metric-mqe { flex: 0 1 200px; min-width: 110px; }
.metric-lbl { flex: 0 0 110px; }
.metric-unit { flex: 0 0 72px; }
.row-spacer { flex: 1 1 auto; min-width: 8px; }
.tier-select { flex: 0 0 130px; }

.inp {
  height: 24px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font-size: 11.5px;
  font-family: inherit;
}
.inp.mono { font-family: var(--sw-mono-font, ui-monospace, monospace); font-size: 11px; }
.inp:focus { outline: 1px solid var(--sw-accent); }

.btn {
  height: 26px;
  padding: 0 12px;
  font-size: 11.5px;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not([disabled]) { background: var(--sw-bg-3); color: var(--sw-fg-0); }
.btn[disabled]             { opacity: 0.45; cursor: default; }
.btn.tiny  { height: 20px; padding: 0 8px;  font-size: 10px; }
.btn.danger { border-color: rgba(239, 68, 68, 0.6); color: #f87171; }
.btn.danger:hover:not([disabled]) { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }
.btn.ghost {
  align-self: flex-start;
  background: transparent;
  border-style: dashed;
  color: var(--sw-fg-3);
}
.btn.ghost:hover:not([disabled]) { color: var(--sw-fg-1); border-color: var(--sw-accent); background: transparent; }
</style>
