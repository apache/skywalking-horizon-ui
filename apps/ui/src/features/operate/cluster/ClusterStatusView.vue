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
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOapInfo } from '@/shell/useOapInfo';
import { useAdminFeatures } from '@/shell/useAdminFeatures';

// Two-pane Cluster Status:
//   - Pane A (graphql / :12800): version, server clock, timezone,
//     health score. Drives the global topbar status chip and the
//     global "OAP unreachable" banner.
//   - Pane B (admin host / :17128): preflight of SWIP-13 selectors
//     (admin-server, receiver-runtime-rule, dsl-debugging, inspect).
//     Drives the per-page warning header on admin-host routes.
// The two halves are queried separately on purpose — a healthy
// :12800 with a broken admin port is a real, recoverable state
// (forgot to expose :17128 in the k8s service) and the page must
// show that clearly.

const { t } = useI18n({ useScope: 'global' });
const {
  info,
  reachable,
  version,
  tzOffsetLabel,
  healthState,
  healthScore,
  refetch: refetchInfo,
} = useOapInfo();

const {
  result: preflight,
  adminUrl,
  adminReachable,
  adminError,
  refetch: refetchPreflight,
} = useAdminFeatures();

const serverClockLocal = computed<string>(() => {
  const ts = info.value?.currentTimestamp;
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
});

const localTzLabel = computed<string>(() => {
  const offMin = -new Date().getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
});

const healthLabel = computed<string>(() => {
  if (!reachable.value) return t('unreachable');
  if (healthScore.value === undefined) return t('unknown');
  if (healthScore.value < 0) return t('not started');
  if (healthScore.value > 0) return t('degraded (score {n})', { n: healthScore.value });
  return t('healthy');
});

const adminBadgeState = computed<'ok' | 'warn' | 'err' | 'unknown'>(() => {
  if (!preflight.value) return 'unknown';
  if (!adminReachable.value) return 'err';
  // Admin port replied but some required selectors are off.
  if (preflight.value.modules.some((m) => m.required && !m.enabled)) return 'warn';
  return 'ok';
});

const adminBadgeLabel = computed<string>(() => {
  if (!preflight.value) return t('loading…');
  if (!adminReachable.value) return t('unreachable');
  const off = preflight.value.modules.filter((m) => m.required && !m.enabled);
  if (off.length === 0) return t('all selectors on');
  return t('{n} selectors off', { n: off.length });
});

const adminGeneratedAt = computed<string>(() => {
  const ts = preflight.value?.generatedAt;
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
});

// Zipkin / OTLP trace endpoint. Probed on the same poll as Pane A but
// independently — it only feeds the Zipkin/OTLP trace menu, so a red
// dot here is NOT a cluster-wide outage. Reachability is undefined
// until the first /api/oap/info lands.
const zipkinReachable = computed<boolean | undefined>(() => info.value?.zipkinReachable);
const zipkinBadgeState = computed<'ok' | 'err' | 'unknown'>(() => {
  if (zipkinReachable.value === undefined) return 'unknown';
  return zipkinReachable.value ? 'ok' : 'err';
});
const zipkinBadgeLabel = computed<string>(() => {
  if (zipkinReachable.value === undefined) return t('loading…');
  return zipkinReachable.value ? t('reachable') : t('unreachable');
});

function refreshAll(): void {
  void refetchInfo();
  void refetchPreflight();
}
</script>

<template>
  <div class="cluster">
    <header class="page-head">
      <div>
        <div class="kicker">{{ t('Operate') }} · {{ t('Cluster status') }}</div>
        <h1>{{ t('OAP cluster') }}</h1>
        <p class="lede">
          {{ t('Two-port view of the OAP backend horizon is connected to. Query / GraphQL (:12800) drives every observability page; the admin host (:17128) gates DSL management, Live debugger, Metrics inspect, and Dump; the Zipkin / OTLP endpoint feeds only the Zipkin trace menu. All three are polled independently — if one shows red the others can still be green.') }}
        </p>
      </div>
      <button type="button" class="refresh" @click="refreshAll">{{ t('refresh both') }}</button>
    </header>

    <!-- ── Pane A · Query / GraphQL port (:12800) ────────────────── -->
    <section class="pane">
      <header class="pane-head">
        <h2>Query / GraphQL <span class="port">:12800</span></h2>
        <span class="sw-badge" :class="`is-${healthState}`">
          <span class="state-dot" />{{ healthLabel }}
        </span>
      </header>

      <div class="grid">
        <div class="sw-card kpi">
          <div class="sw-card-head"><h4>{{ t('Version') }}</h4></div>
          <div class="kpi-body">
            <div class="kpi-value">{{ version ?? '—' }}</div>
            <div class="kpi-label">{{ reachable ? info?.queryUrl : t('OAP unreachable') }}</div>
          </div>
        </div>

        <div class="sw-card kpi">
          <div class="sw-card-head"><h4>{{ t('Server timezone') }}</h4></div>
          <div class="kpi-body">
            <div class="kpi-value">{{ tzOffsetLabel || '—' }}</div>
            <div class="kpi-label">{{ t('Browser local: {tz}', { tz: localTzLabel }) }}</div>
          </div>
        </div>

        <div class="sw-card kpi">
          <div class="sw-card-head"><h4>{{ t('Server clock') }}</h4></div>
          <div class="kpi-body">
            <div class="kpi-value mono">{{ serverClockLocal }}</div>
            <div class="kpi-label">{{ t('As seen in your browser timezone') }}</div>
          </div>
        </div>

        <div class="sw-card kpi">
          <div class="sw-card-head"><h4>{{ t('Health score') }}</h4></div>
          <div class="kpi-body">
            <div class="kpi-value">{{ healthScore ?? '—' }}</div>
            <div class="kpi-label">{{ info?.healthDetails ?? t('0 ok · >0 degraded · <0 not started') }}</div>
          </div>
        </div>
      </div>

      <div v-if="!reachable && info?.error" class="last-error">
        <strong>{{ t('Last error') }}</strong>
        <code>{{ info.error }}</code>
      </div>
    </section>

    <!-- ── Pane B · Admin host (:17128) ──────────────────────────── -->
    <section class="pane">
      <header class="pane-head">
        <h2>{{ t('Admin host') }} <span class="port">:17128</span></h2>
        <span class="sw-badge" :class="`is-${adminBadgeState}`">
          <span class="state-dot" />{{ adminBadgeLabel }}
        </span>
        <span class="generated">{{ t('checked {at}', { at: adminGeneratedAt }) }}</span>
      </header>

      <p class="pane-lede">
        {{ t("Per-module enablement on the admin port. Each row gates a slice of horizon's UI — flip the corresponding env var on OAP and restart to enable, or remove the corresponding page from your operator menu if you don't need it.") }}
      </p>

      <div v-if="!preflight" class="empty">{{ t('loading preflight…') }}</div>

      <div v-else-if="!adminReachable" class="last-error block">
        <strong>{{ t('Admin host unreachable') }}</strong>
        <code v-if="adminError">{{ adminError }}</code>
        <p class="hint">
          {{ t('Tried {url}. Confirm the OAP admin-server module is on (SW_ADMIN_SERVER=default) and the port is exposed on the network / k8s Service / ingress.', { url: `${adminUrl}/debugging/config/dump` }) }}
        </p>
      </div>

      <table v-else class="mod-table">
        <thead>
          <tr>
            <th>{{ t('Module') }}</th>
            <th>{{ t('State') }}</th>
            <th>{{ t('Env var') }}</th>
            <th>{{ t('Gates') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in preflight.modules" :key="m.name" :class="{ off: !m.enabled }">
            <td class="modname"><code>{{ m.name }}</code></td>
            <td>
              <span class="sw-badge" :class="m.enabled ? 'is-ok' : 'is-err'">
                <span class="state-dot" />{{ m.enabled ? t('enabled') : t('missing') }}
              </span>
            </td>
            <td class="modenv"><code>{{ m.envVar }}</code></td>
            <td class="modaffects">{{ t(m.affects) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ── Pane C · Zipkin / OTLP trace endpoint ─────────────────── -->
    <section class="pane">
      <header class="pane-head">
        <h2>Zipkin / OTLP traces <span class="port">v2 REST</span></h2>
        <span class="sw-badge" :class="`is-${zipkinBadgeState}`">
          <span class="state-dot" />{{ zipkinBadgeLabel }}
        </span>
      </header>

      <p class="pane-lede">
        {{ t("OAP's Zipkin v2 endpoint, source for the OpenTelemetry & Zipkin trace menu (shown when a layer's trace source is zipkin or both). This is the only page affected — if it's unreachable, native traces and every other observability page keep working.") }}
      </p>

      <div class="grid">
        <div class="sw-card kpi">
          <div class="sw-card-head"><h4>{{ t('Endpoint') }}</h4></div>
          <div class="kpi-body">
            <div class="kpi-value mono">{{ zipkinBadgeLabel }}</div>
            <div class="kpi-label">{{ info?.zipkinUrl ?? '—' }}</div>
          </div>
        </div>
      </div>

      <div v-if="zipkinReachable === false" class="last-error block">
        <strong>{{ t('Zipkin endpoint unreachable') }}</strong>
        <code v-if="info?.zipkinError">{{ info.zipkinError }}</code>
        <p class="hint">
          {{ t("Tried {url}. Confirm OAP's Zipkin receiver / query is enabled and the oap.zipkinUrl in horizon's config points at the right host:port (shared GraphQL port → <queryUrl>/zipkin; standalone → :9412/zipkin). Only the Zipkin trace menu is affected.", { url: `${info?.zipkinUrl ?? ''}/api/v2/services` }) }}
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cluster {
  padding: 20px 20px 60px;
  max-width: 1440px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 22px;
}
.page-head > div {
  flex: 1;
}
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 760px;
}
.lede code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-1);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
}
.refresh {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.refresh:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}

.pane {
  margin-bottom: 26px;
}
.pane-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.pane-head h2 {
  font-size: 13px;
  font-weight: 600;
  color: var(--sw-fg-0);
  margin: 0;
  letter-spacing: -0.01em;
}
.pane-head .port {
  font-family: var(--sw-mono);
  font-size: 11px;
  color: var(--sw-fg-3);
  margin-left: 6px;
  font-weight: 400;
}
.pane-head .generated {
  margin-left: auto;
  font-size: 11px;
  color: var(--sw-fg-3);
}
.pane-lede {
  font-size: 12px;
  color: var(--sw-fg-2);
  margin: 0 0 12px;
  line-height: 1.5;
  max-width: 720px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.kpi .sw-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.kpi .sw-card-head h4 {
  flex: 1;
}
.kpi-body {
  padding: 14px 12px;
}
.kpi-value {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.kpi-value.mono {
  font-family: var(--sw-mono);
  font-size: 14px;
  font-weight: 500;
}
.kpi-label {
  margin-top: 4px;
  font-size: 11px;
  color: var(--sw-fg-2);
}

.last-error {
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.last-error strong {
  color: var(--sw-err);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.08em;
}
.last-error code {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-0);
  word-break: break-all;
}
.last-error.block {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.last-error .hint {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
}
.last-error .hint code {
  font-family: var(--sw-mono);
  background: rgba(0, 0, 0, 0.25);
  padding: 1px 4px;
  border-radius: 3px;
}

.empty {
  padding: 14px;
  color: var(--sw-fg-3);
  font-size: 12px;
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 6px;
}

.mod-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
  font-size: 12px;
}
.mod-table thead th {
  text-align: left;
  font-weight: 600;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  padding: 8px 12px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.mod-table tbody td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--sw-line);
  vertical-align: top;
  color: var(--sw-fg-1);
}
.mod-table tbody tr:last-child td {
  border-bottom: none;
}
.mod-table tr.off .modname code,
.mod-table tr.off .modenv code {
  color: var(--sw-fg-2);
}
.modname code,
.modenv code {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-0);
}
.modaffects {
  line-height: 1.5;
  color: var(--sw-fg-2);
  max-width: 540px;
}

.sw-badge .state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 4px;
  display: inline-block;
  vertical-align: middle;
}
.sw-badge.is-ok {
  color: var(--sw-ok);
  background: var(--sw-ok-soft);
  border-color: rgba(34, 197, 94, 0.3);
}
.sw-badge.is-warn {
  color: var(--sw-warn);
  background: var(--sw-warn-soft);
  border-color: rgba(234, 179, 8, 0.3);
}
.sw-badge.is-err {
  color: var(--sw-err);
  background: var(--sw-err-soft);
  border-color: rgba(239, 68, 68, 0.3);
}
.sw-badge.is-unknown {
  color: var(--sw-fg-3);
}

</style>
