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
  Instance picker — a sticky list on the left when the Instance scope is
  active. Each row shows the instance name, a configured badge tag, and an
  expandable attributes property list. Auto-fires once a service is selected
  (the cascade composable owns the fetch / auto-pick); this component is
  presentational and emits `pick` / `toggle-lock` on a row click.
-->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import type { LayerInstance } from '@/render/layer-dashboard/useInstanceCascade';

defineProps<{
  slotLabel: string;
  serviceName: string | null;
  selectedId: string | null;
  instances: LayerInstance[];
  loading: boolean;
  selected: string | null;
  atCap: boolean;
  isLocked: (name: string) => boolean;
  rowHue: (name: string) => string;
  badge: (i: LayerInstance) => string | null;
}>();
const emit = defineEmits<{
  (e: 'pick', name: string): void;
  (e: 'toggle-lock', name: string): void;
}>();

const { t } = useI18n({ useScope: 'global' });
/** Track which row's attributes panel is open. Mutually exclusive —
 *  expanding one collapses the previous so the list stays compact. */
const expanded = ref<string | null>(null);
</script>

<template>
  <section class="instance-bar sw-card">
    <header class="ib-head">
      <span class="kicker">{{ slotLabel || 'Instance' }}</span>
      <!-- Header strictly tracks the resolved `serviceName` —
           never the raw `?service=` base64 id from the URL.
           While landing is still loading we show a loading hint
           instead, matching the cascade-clear-then-load
           principle (downstream waits for upstream). -->
      <span v-if="serviceName" class="for-svc">
        for <b>{{ serviceName }}</b>
        <span v-if="instances.length > 0" class="count">{{ instances.length }}</span>
      </span>
      <span v-else-if="selectedId" class="hint">resolving service…</span>
      <span v-if="loading" class="hint">loading instances…</span>
    </header>
    <div v-if="!selectedId" class="empty inline">
      Pick a service in the picker above to list its instances.
    </div>
    <div v-else-if="!serviceName" class="empty inline">
      Resolving service…
    </div>
    <div v-else-if="!loading && instances.length === 0" class="empty inline">
      No active instances reported for {{ serviceName }} in the last 15 minutes.
    </div>
    <ul v-else class="ib-list">
      <li
        v-for="i in instances"
        :key="i.id"
        class="ib-row has-lock"
        :class="{ on: selected === i.name }"
      >
        <button
          type="button"
          class="ib-lock"
          :class="{ locked: isLocked(i.name) }"
          :disabled="!isLocked(i.name) && atCap"
          :title="isLocked(i.name) ? t('Remove from comparison') : t('Add to comparison')"
          @click.stop="emit('toggle-lock', i.name)"
        >
          <span v-if="isLocked(i.name)" class="ib-lock-dot" :style="{ background: rowHue(i.name) }" />
          <Icon v-else name="pin" :size="11" />
        </button>
        <button
          type="button"
          class="ib-pick-btn"
          @click="emit('pick', i.name)"
        >
          <span class="ib-name">{{ i.name }}</span>
          <span v-if="badge(i)" class="ib-lang">{{ badge(i) }}</span>
        </button>
        <button
          v-if="i.attributes.length > 0"
          type="button"
          class="ib-expand"
          :title="expanded === i.id ? 'Collapse attributes' : 'Show attributes'"
          @click="expanded = expanded === i.id ? null : i.id"
        >
          <span class="caret" :class="{ open: expanded === i.id }">▸</span>
          {{ i.attributes.length }} attr
        </button>
        <dl v-if="expanded === i.id" class="ib-attrs">
          <template v-for="a in i.attributes" :key="a.name">
            <dt>{{ a.name }}</dt>
            <dd>{{ a.value || '—' }}</dd>
          </template>
        </dl>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.instance-bar {
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: 360px;
}
.ib-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.ib-head .kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}
.ib-head .for-svc {
  font-size: 11px;
  color: var(--sw-fg-3);
}
.ib-head .for-svc b {
  color: var(--sw-fg-1);
  font-weight: 500;
  font-family: var(--sw-mono);
}
.ib-head .count {
  font-family: var(--sw-mono);
  font-size: 10px;
  padding: 1px 6px;
  margin-left: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  border-radius: 3px;
}
.ib-head .hint {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.empty.inline {
  padding: 18px;
  font-size: 11px;
}
.ib-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.ib-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 8px;
  padding: 2px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.ib-row.has-lock {
  grid-template-columns: auto 1fr auto;
}
.ib-lock {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  align-self: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--sw-fg-3);
  cursor: pointer;
}
.ib-lock:hover:not(:disabled) {
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
}
.ib-lock:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.ib-lock-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.ib-row:last-child { border-bottom: none; }
.ib-row.on {
  background: var(--sw-accent-soft);
}
.ib-pick-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--sw-fg-1);
  font: inherit;
  font-family: var(--sw-mono);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.ib-pick-btn:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}
.ib-row.on .ib-pick-btn {
  color: var(--sw-accent-2);
  font-weight: 600;
  background: transparent;
}
.ib-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ib-lang {
  flex: 0 0 auto;
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--sw-bg-3);
  color: var(--sw-fg-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ib-row.on .ib-lang {
  background: var(--sw-accent-line);
  color: var(--sw-accent-2);
}
.ib-expand {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--sw-fg-3);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.ib-expand:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.ib-expand .caret {
  display: inline-block;
  width: 9px;
  transition: transform 0.12s;
  font-size: 9px;
}
.ib-expand .caret.open {
  transform: rotate(90deg);
}
.ib-attrs {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 4px 8px 6px 18px;
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border-radius: 4px;
  font-size: 10.5px;
}
.ib-attrs dt {
  color: var(--sw-fg-3);
  font-family: var(--sw-mono);
}
.ib-attrs dd {
  margin: 0;
  color: var(--sw-fg-1);
  font-family: var(--sw-mono);
  word-break: break-all;
}
</style>
