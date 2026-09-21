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
  What this store can be asked, and how.

  The fields this store answers for: its intrinsics, its resource attributes,
  and the span tags it reported for the window being queried. Clicking one
  inserts it into the query. It describes the SCHEMA and nothing about what the
  backend does with a query — that is the backend's own business.

  It opens OVER the page rather than in the flow: the conditions card is as tall
  as the duration distribution beside it, and a reference the operator opens
  while writing a query must not resize the chart they are reading. It closes
  the moment attention moves back to the query — a click anywhere outside it, or
  Escape — because it is something consulted, not a panel to be dismissed.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import { useI18n } from 'vue-i18n';
import type { TraceQLDatasource } from '@skywalking-horizon-ui/api-client';
import {
  TRACEQL_INTRINSICS,
  TRACEQL_RESOURCE_ATTRS,
  operatorsFor,
} from '@/monaco/traceql-grammar';

const props = defineProps<{ ds: TraceQLDatasource; tagKeys: string[]; open: boolean }>();
const emit = defineEmits<{ insert: [text: string]; 'update:open': [value: boolean] }>();

const root = ref<HTMLElement | null>(null);

function closeOnOutside(e: Event): void {
  if (!root.value?.contains(e.target as Node)) emit('update:open', false);
}
// Escape goes through the shared helper, so this panel takes its turn in the
// one-Escape-one-box order rather than closing alongside whatever else is open.
useEscapeToClose(
  () => props.open,
  () => emit('update:open', false),
);
watch(
  () => props.open,
  (open) => {
    if (open) document.addEventListener('pointerdown', closeOnOutside);
    else document.removeEventListener('pointerdown', closeOnOutside);
  },
);
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOnOutside));

const { t } = useI18n({ useScope: 'global' });
// The panel is the store's schema, so it lists what THIS store can filter.
const resourceAttrs = computed(() => TRACEQL_RESOURCE_ATTRS.filter((a) => !a.ds || a.ds.includes(props.ds)));
const intrinsics = computed(() => TRACEQL_INTRINSICS.filter((i) => !i.ds || i.ds.includes(props.ds)));
</script>

<template>
  <div ref="root" class="tqs">
    <button type="button" class="tqs-toggle" @click="emit('update:open', !open)">
      {{ open ? '▾' : '▸' }} {{ t('Schema reference') }}
      <span class="dim">{{ t('{n} tags', { n: tagKeys.length }) }}</span>
    </button>

    <div v-if="open" class="tqs-body">
      <section>
        <h5>{{ t('Intrinsics') }}</h5>
        <ul>
          <li v-for="i in intrinsics" :key="i.name">
            <button type="button" class="tqs-chip mono" @click="emit('insert', i.name)">{{ i.name }}</button>
            <span class="ops mono">{{ operatorsFor(i.name).join(' ') }}</span>
            <span class="dim">{{ t(i.detail) }}</span>
          </li>
        </ul>
      </section>

      <section>
        <h5>{{ t('Resource') }}</h5>
        <ul>
          <li v-for="a in resourceAttrs" :key="a.name">
            <button type="button" class="tqs-chip mono" @click="emit('insert', a.name)">{{ a.name }}</button>
            <span class="ops mono">{{ operatorsFor(a.name).join(' ') }}</span>
            <span class="dim">{{ t(a.detail) }}</span>
          </li>
        </ul>
      </section>

      <section class="tqs-tags">
        <h5>{{ t('Span tags') }}</h5>
        <p v-if="!tagKeys.length" class="dim">{{ t('This store reported no tags for the selected window.') }}</p>
        <div v-else class="tqs-taglist">
          <button
            v-for="k in tagKeys"
            :key="k"
            type="button"
            class="tqs-chip mono"
            @click="emit('insert', `span.${k}`)"
          >
            {{ k }}
          </button>
        </div>
      </section>

      <p class="tqs-note">
        {{ t('Span tags are those this store reported for the window being queried, so the list follows the time range.') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.tqs { display: flex; flex-direction: column; gap: 6px; position: relative; }
.tqs-toggle {
  align-self: flex-start;
  background: none;
  border: none;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  gap: 6px;
  align-items: baseline;
}
.tqs-body {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 20;
  max-height: 340px;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px 16px;
  padding: 8px 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
}
h5 { margin: 0 0 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--sw-fg-3); }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
li { display: flex; align-items: baseline; gap: 6px; font-size: 10.5px; flex-wrap: wrap; }
.ops { color: var(--sw-accent); font-size: 10px; }
.dim { color: var(--sw-fg-3); font-size: 10px; }
.tqs-tags { grid-column: 1 / -1; }
.tqs-taglist { display: flex; flex-wrap: wrap; gap: 4px; }
.tqs-chip {
  background: var(--sw-bg-3);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  color: var(--sw-fg-1);
  font-size: 10.5px;
  padding: 1px 6px;
  cursor: pointer;
}
.tqs-chip:hover { border-color: var(--sw-accent); color: var(--sw-accent); }
.tqs-note { grid-column: 1 / -1; margin: 0; font-size: 10px; color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
</style>
