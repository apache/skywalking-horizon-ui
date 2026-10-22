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
  Global notice for a trace link no popout can open: `?traceId=` with no
  `?traceType=`, or with one that names no trace source. It asks which source
  to query rather than guessing one — a guess reads the id from a store it may
  not be in, and shows an empty trace as though the trace were missing.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { TRACE_STORES, type TraceStore } from '@skywalking-horizon-ui/api-client';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import { TRACE_POPOUT_QUERY, TRACE_POPOUT_TYPE, clearTraceAddress, traceStoreOf } from './tracePopoutQuery';

const { t } = useI18n({ useScope: 'global' });
const route = useRoute();
const router = useRouter();

const invalid = computed<{ traceId: string; traceType: string | null } | null>(() => {
  const id = route.query[TRACE_POPOUT_QUERY];
  if (typeof id !== 'string' || !id || traceStoreOf(route.query)) return null;
  const type = route.query[TRACE_POPOUT_TYPE];
  if (!Array.isArray(type)) return { traceId: id, traceType: typeof type === 'string' && type ? type : null };
  // A repeated key: every occurrence, an empty one shown as such.
  return { traceId: id, traceType: type.map((v) => (v ? v : '""')).join(', ') };
});

function close(): void {
  if (!invalid.value) return;
  void router.replace({ path: route.path, query: clearTraceAddress(route.query) });
}

/** Names the source on the same link, so that source's popout takes it. */
function queryFrom(source: TraceStore): void {
  void router.replace({ path: route.path, query: { ...route.query, [TRACE_POPOUT_TYPE]: source } });
}
useEscapeToClose(() => invalid.value !== null, close);
</script>

<template>
  <div v-if="invalid" class="tln-backdrop" @click.self="close">
    <article class="tln-card sw-card" role="alertdialog" aria-labelledby="tln-title">
      <header class="tln-head">
        <span id="tln-title" class="tln-title">{{ t('Trace link not valid') }}</span>
        <button class="sw-btn small ghost" type="button" :title="t('Close')" @click="close">×</button>
      </header>
      <dl class="tln-fields">
        <dt>{{ t('Trace') }}</dt>
        <dd class="mono">{{ invalid.traceId }}</dd>
        <dt class="mono">traceType</dt>
        <dd v-if="invalid.traceType" class="mono tln-bad">{{ invalid.traceType }}</dd>
        <dd v-else class="tln-bad">{{ t('not set') }}</dd>
      </dl>
      <p class="tln-text">{{ t('Query it from one of these trace sources:') }}</p>
      <div class="tln-sources">
        <button v-for="s in TRACE_STORES" :key="s" class="sw-btn small mono" type="button" @click="queryFrom(s)">{{ s }}</button>
      </div>
      <p class="tln-hint">{{ t("A record list's trace icon leads here when its widget names no trace store. Set one under Record trace in the layer dashboard editor.") }}</p>
    </article>
  </div>
</template>

<style scoped>
.tln-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.66);
  /* With the trace popouts, above the AI drawer (420). */
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.tln-card {
  width: min(560px, 100%);
  padding: 0 0 14px;
}
.tln-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.tln-title { font-size: 13px; font-weight: 600; color: var(--sw-warn); }
.tln-fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 14px;
  margin: 12px 14px 0;
  font-size: 12px;
}
.tln-fields dt { color: var(--sw-fg-3); }
.tln-fields dd { margin: 0; color: var(--sw-fg-1); overflow-wrap: anywhere; }
.tln-bad { color: var(--sw-warn); }
.tln-text, .tln-hint { margin: 12px 14px 0; font-size: 12px; color: var(--sw-fg-2); }
.tln-hint { color: var(--sw-fg-3); }
.tln-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 14px 0;
}
.mono { font-family: var(--sw-mono); }
</style>
