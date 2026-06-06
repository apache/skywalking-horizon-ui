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
 * Global "OAP query port unreachable" strip.
 *
 * Mounts under the topbar on every shell route. Surfaces a verbose
 * warning the moment the `/api/oap/info` poll starts returning
 * `reachable: false`, with the last error reason inline. While the
 * banner is showing, a faster retry poll (operator-selectable
 * off/5/15/60s, persisted to localStorage) takes over from the
 * default 30s `useOapInfo` cadence — so recovery shows up in the UI
 * without an operator-triggered refresh.
 *
 * Two fundamental failures drive this strip, same red theme, only one
 * at a time (query takes precedence):
 *   1. Query port (`:12800`) unreachable — no telemetry at all.
 *   2. OAP UI-template store unreachable — the BFF then serves NO
 *      per-layer dashboards / overviews / topology (bundled is never a
 *      render-time fallback), so the entire dashboard surface is blocked,
 *      not silently empty. Signalled by `syncStatus.unreachable` on the
 *      config bundle.
 *
 * Admin-port write failures still render in-page via `AdminFeatureWarning`
 * inside each admin-host route — those are edit-surface warnings, distinct
 * from the read-surface block above.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';

const { t } = useI18n({ useScope: 'global' });
import { useOapInfo } from '@/shell/useOapInfo';
import { useConfigBundle, refreshConfigBundle } from '@/controls/configBundle';
import Icon from '@/components/icons/Icon.vue';

type RetryChoice = 'off' | '5' | '15' | '60';
interface RetryOption {
  value: RetryChoice;
  label: string;
}
const RETRY_OPTIONS: RetryOption[] = [
  { value: 'off', label: 'off' },
  { value: '5', label: '5s' },
  { value: '15', label: '15s' },
  { value: '60', label: '60s' },
];
const RETRY_KEY = 'horizon:banner:retry-poll:v1';

function loadRetry(): RetryChoice {
  try {
    const raw = localStorage.getItem(RETRY_KEY);
    if (raw && RETRY_OPTIONS.some((o) => o.value === raw)) return raw as RetryChoice;
  } catch {
    /* private-browsing / quota — ignore */
  }
  return '5';
}
const retryChoice = ref<RetryChoice>(loadRetry());
watch(retryChoice, (next) => {
  try {
    localStorage.setItem(RETRY_KEY, next);
  } catch {
    /* ignore */
  }
});

const { info, reachable, refetch } = useOapInfo();
const route = useRoute();

/** True only after the first response has arrived AND it was a
 *  failure. Suppresses the banner during boot / pre-auth so we don't
 *  flash it on routes that haven't finished loading. */
const unreachable = computed<boolean>(() => info.value !== null && !reachable.value);

/** Auth-gated routes only — `/login` etc. carry `meta.public` and
 *  don't have an OAP session yet. */
const isPublicRoute = computed<boolean>(() => route.meta.public === true);

/** ms since the first failed poll. Reset on every successful one.
 *  The strip shows "Xs ago" so the operator can tell stale failures
 *  from transient blips. */
const firstFailureAt = ref<number | null>(null);
const nowMs = ref(Date.now());
watch(unreachable, (down) => {
  if (down) {
    if (firstFailureAt.value === null) firstFailureAt.value = Date.now();
  } else {
    firstFailureAt.value = null;
  }
});
const tickerId = setInterval(() => {
  nowMs.value = Date.now();
}, 1_000);
onBeforeUnmount(() => clearInterval(tickerId));

const downForLabel = computed<string>(() => {
  if (firstFailureAt.value === null) return '';
  const sec = Math.max(1, Math.floor((nowMs.value - firstFailureAt.value) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
});

/** Retry-while-down poller. Separate from `useOapInfo`'s 30s loop so
 *  flipping the dropdown to `off` keeps the standard 30s cadence
 *  running underneath. Cleared whenever the connection recovers, the
 *  cadence changes, or the banner unmounts. */
let retryId: ReturnType<typeof setInterval> | null = null;
function clearRetry(): void {
  if (retryId) {
    clearInterval(retryId);
    retryId = null;
  }
}
function startRetry(): void {
  clearRetry();
  if (!unreachable.value) return;
  if (retryChoice.value === 'off') return;
  const ms = Number(retryChoice.value) * 1000;
  retryId = setInterval(() => {
    void refetch();
  }, ms);
}
watch([unreachable, retryChoice], () => startRetry(), { immediate: true });
onBeforeUnmount(() => clearRetry());

const errorText = computed<string>(() => info.value?.error ?? 'no response');
// The "View cluster status" shortcut is pointless once the operator is
// already on the cluster page — hide it there.
const onClusterPage = computed<boolean>(() => route.path.startsWith('/operate/cluster'));
const queryUrl = computed<string | undefined>(() => info.value?.queryUrl);

// --- Template store (OAP UI-template overlay) unreachable -------------
// Second fundamental failure. `syncStatus.unreachable` rides on the
// config bundle the shell already preloads. When set, every dashboard /
// overview / topology route returns nothing (no bundled fallback at
// render time), so the operator must see the surface is BLOCKED. The
// query-port strip wins when both are down — they share one OAP, so a
// full outage shows the more fundamental message only.
const { bundle } = useConfigBundle();
const templateStoreDown = computed<boolean>(
  () => !unreachable.value && bundle.value?.syncStatus?.unreachable === true,
);
const lastSyncLabel = computed<string>(() => {
  const at = bundle.value?.syncStatus?.lastSuccessfulSyncAt;
  if (!at) return t('never');
  const sec = Math.max(1, Math.floor((nowMs.value - at) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
});
const retryingTemplates = ref(false);
async function retryTemplates(): Promise<void> {
  if (retryingTemplates.value) return;
  retryingTemplates.value = true;
  try {
    await refreshConfigBundle({ force: true });
  } finally {
    retryingTemplates.value = false;
  }
}
</script>

<template>
  <div v-if="unreachable && !isPublicRoute" class="banner" role="alert">
    <span class="icon">
      <Icon name="alert" :size="14" />
    </span>
    <div class="msg">
      <strong>{{ t('OAP query port unreachable') }}</strong>
      <span class="detail">
        {{ t('Last seen') }} <span class="when">{{ downForLabel }}</span>
        <span v-if="queryUrl">
          · <code>{{ queryUrl }}</code>
        </span>
        · <span class="err">{{ errorText }}</span>
      </span>
    </div>

    <label class="retry" :title="t('Auto-retry cadence while OAP is unreachable')">
      <span class="retry-label">{{ t('retry') }}</span>
      <select v-model="retryChoice">
        <option v-for="o in RETRY_OPTIONS" :key="o.value" :value="o.value">
          {{ o.label }}
        </option>
      </select>
    </label>

    <button type="button" class="now" @click="() => refetch()">{{ t('retry now') }}</button>
    <RouterLink v-if="!onClusterPage" to="/operate/cluster" class="link">{{ t('View cluster status →') }}</RouterLink>
  </div>

  <div v-else-if="templateStoreDown && !isPublicRoute" class="banner" role="alert">
    <span class="icon">
      <Icon name="alert" :size="14" />
    </span>
    <div class="msg">
      <strong>{{ t('Dashboard template store unreachable') }}</strong>
      <span class="detail">
        {{ t('Layer dashboards, overviews and topology are blocked until OAP’s UI-template store is reachable.') }}
        · {{ t('Last sync') }} <span class="when">{{ lastSyncLabel }}</span>
      </span>
    </div>

    <button type="button" class="now" :disabled="retryingTemplates" @click="retryTemplates">
      {{ t('retry now') }}
    </button>
    <RouterLink v-if="!onClusterPage" to="/operate/cluster" class="link">{{ t('View cluster status →') }}</RouterLink>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: linear-gradient(90deg, rgba(239, 68, 68, 0.18), rgba(239, 68, 68, 0.10));
  border-bottom: 1px solid rgba(239, 68, 68, 0.45);
  color: var(--sw-fg-0);
  font-size: 12px;
  position: sticky;
  top: 0;
  z-index: 50;
}
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.25);
  color: var(--sw-err);
  flex-shrink: 0;
}
.msg {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.msg strong {
  color: var(--sw-err);
  font-weight: 600;
  white-space: nowrap;
}
.detail {
  color: var(--sw-fg-1);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.when {
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.detail code {
  font-family: var(--sw-mono);
  background: rgba(0, 0, 0, 0.25);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--sw-fg-1);
}
.detail .err {
  color: var(--sw-fg-2);
  font-style: italic;
}

.retry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.retry-label {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-2);
}
.retry select {
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.now {
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: var(--sw-fg-0);
  padding: 4px 10px;
  font: inherit;
  font-size: 11.5px;
  border-radius: 4px;
  cursor: pointer;
}
.now:hover {
  background: rgba(0, 0, 0, 0.4);
}
.link {
  color: var(--sw-err);
  font-size: 11.5px;
  text-decoration: none;
  white-space: nowrap;
  flex-shrink: 0;
}
.link:hover {
  color: var(--sw-fg-0);
  text-decoration: underline;
}
</style>
