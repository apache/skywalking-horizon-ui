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
/**
 * Live debugger — three-tab shell over MAL / LAL / OAL views.
 * Each tab owns its own session via the per-widget clientId so an
 * operator can have all three running in parallel from the same
 * tab.
 *
 * The active tab is **URL-driven** (`/operate/live-debug/{mal|lal|oal}`)
 * so deep links from elsewhere (catalog rule cards, OAL file viewer's
 * gutter arrow) land on the right tab with their query params intact
 * for the per-DSL picker to read.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import DebugMal from './DebugMal.vue';
import DebugLal from './DebugLal.vue';
import DebugOal from './DebugOal.vue';
import AdminFeatureWarning from '@/shell/AdminFeatureWarning.vue';

type Tab = 'mal' | 'lal' | 'oal';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const tab = computed<Tab>(() => {
  const raw = route.params.tab;
  if (raw === 'mal' || raw === 'lal' || raw === 'oal') return raw;
  return 'mal';
});

const tabs = computed<{ id: Tab; label: string; hint: string }[]>(() => [
  { id: 'mal', label: 'MAL', hint: t('meter analyzer · OTEL + log-mal') },
  { id: 'lal', label: 'LAL', hint: t('log analyzer · per-block + statement') },
  { id: 'oal', label: 'OAL', hint: t('observability analysis · per-clause') },
]);

const activeHint = computed(() => tabs.value.find((tt) => tt.id === tab.value)?.hint ?? '');

function selectTab(t: Tab): void {
  // Tab clicks clear deep-link query params — they were specific to
  // the prior tab's picker and shouldn't leak across.
  void router.push({ path: `/operate/live-debug/${t}` });
}
</script>

<template>
  <div class="dbg">
    <AdminFeatureWarning module="dsl-debugging" :feature-label="t('Live debugger')" />
    <header class="dbg__header">
      <h1 class="dbg__h1">{{ t('Live debugger') }}</h1>
      <span class="dbg__hint">{{ activeHint }}</span>
    </header>

    <nav class="dbg__tabs">
      <button
        v-for="tt in tabs"
        :key="tt.id"
        type="button"
        class="dbg__tab"
        :class="{ 'dbg__tab--active': tab === tt.id }"
        @click="selectTab(tt.id)"
      >
        {{ tt.label }}
      </button>
    </nav>

    <KeepAlive>
      <component :is="tab === 'mal' ? DebugMal : tab === 'lal' ? DebugLal : DebugOal" />
    </KeepAlive>
  </div>
</template>

<style scoped>
.dbg {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 18px 24px;
  gap: 12px;
}

.dbg__header {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.dbg__h1 {
  font-size: var(--sw-fs-md);
  font-weight: var(--sw-fw-semibold);
  margin: 0;
  color: var(--rr-heading);
}

.dbg__hint {
  font-size: var(--sw-fs-base);
  color: var(--rr-dim);
}

.dbg__tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--rr-border);
}

.dbg__tab {
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 8px 14px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
  color: var(--rr-dim);
  cursor: pointer;
}

.dbg__tab:hover {
  color: var(--rr-ink);
}

.dbg__tab--active {
  color: var(--rr-heading);
  border-bottom-color: var(--rr-active);
}
</style>
