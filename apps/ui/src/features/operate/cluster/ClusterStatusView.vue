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
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PreflightModule } from '@skywalking-horizon-ui/api-client';
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
  recheck: refetchPreflight,
} = useAdminFeatures();

// "Checked Ns ago" advances against a slow ticker, anchored to the BFF's
// generatedAt (so it reflects the real probe time incl. cache age, not the
// render moment). 5s granularity is plenty for a 30s-cached / 60s-polled check.
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  nowTimer = setInterval(() => (now.value = Date.now()), 5_000);
});
onUnmounted(() => {
  if (nowTimer) clearInterval(nowTimer);
});

function agoLabel(ts: number | undefined): string {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((now.value - ts) / 1000));
  if (sec < 60) return t('{n}s ago', { n: sec });
  return t('{n}m ago', { n: Math.round(sec / 60) });
}

// Health = reachability of the feature's probed REST path, NOT config-presence.
// reachable === null = not probed (ui_template in readonly: bundled, never called).
function featureState(m: PreflightModule): { cls: string; label: string } {
  if (m.reachable === null) return { cls: 'is-warn', label: t('readonly · bundled') };
  return m.reachable
    ? { cls: 'is-ok', label: t('reachable') }
    : { cls: 'is-err', label: t('unreachable') };
}

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
  // Anything not fully live-reachable — a path that 404s, or a bundled /
  // not-probed feature (ui_template in readonly) — is a partial state.
  if (preflight.value.modules.some((m) => m.reachable !== true)) return 'warn';
  return 'ok';
});

const adminBadgeLabel = computed<string>(() => {
  if (!preflight.value) return t('loading…');
  if (!adminReachable.value) return t('unreachable');
  const mods = preflight.value.modules;
  const reachable = mods.filter((m) => m.reachable === true).length;
  if (reachable === mods.length) return t('all reachable');
  // X/Y — covers both an unreachable path and a bundled (readonly) feature;
  // the per-row chip says which.
  return t('{n}/{total} reachable', { n: reachable, total: mods.length });
});

const adminGeneratedAt = computed<string>(() => agoLabel(preflight.value?.generatedAt));

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
        <h2>{{ t('Query / GraphQL') }} <span class="port">:12800</span></h2>
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
        {{ t("Reachability of each admin feature — the BFF GETs the relative REST path the feature actually calls and reports whether it responds. Health is the live probe, not config-presence: a path that 404s (selector off, renamed, or absent in a fork) reads as unreachable. 'selector detected' below is only an upstream-release hint, not the verdict.") }}
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
            <th>{{ t('Feature') }}</th>
            <th>{{ t('State') }}</th>
            <th>{{ t('Probe path') }}</th>
            <th>{{ t('Gates') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in preflight.modules" :key="m.name" :class="{ off: m.reachable === false }">
            <td class="modname"><code>{{ m.name }}</code></td>
            <td>
              <span class="sw-badge" :class="featureState(m).cls">
                <span class="state-dot" />{{ featureState(m).label }}
              </span>
              <div class="state-foot">
                <span class="checked">{{ t('checked {at}', { at: agoLabel(preflight.generatedAt) }) }}</span>
                <span class="sel" :class="{ 'sel-off': !m.enabled }">{{
                  m.enabled ? t('selector detected') : t('selector not detected')
                }}</span>
              </div>
            </td>
            <td class="modpath"><code>{{ m.probePath }}</code></td>
            <td class="modaffects">
              {{ t(m.affects) }}
              <span class="env-ref">{{ t('Enable on OAP:') }} <code>{{ m.envVar }}=default</code></span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ── Pane C · Zipkin / OTLP trace endpoint ─────────────────── -->
    <section class="pane">
      <header class="pane-head">
        <h2>{{ t('Zipkin / OTLP traces') }} <span class="port">{{ t('v2 REST') }}</span></h2>
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
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: var(--sw-fs-2xl);
  font-weight: var(--sw-fw-semibold);
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
  line-height: var(--sw-lh-relaxed);
  margin: 0;
  max-width: 760px;
}
.lede code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-1);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--sw-fs-sm);
}
.refresh {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  font-size: var(--sw-fs-sm);
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
  font-size: var(--sw-fs-md);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
  margin: 0;
  letter-spacing: -0.01em;
}
.pane-head .port {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  margin-left: 6px;
  font-weight: var(--sw-fw-regular);
}
.pane-head .generated {
  margin-left: auto;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
}
.pane-lede {
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-2);
  margin: 0 0 12px;
  line-height: var(--sw-lh-relaxed);
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
  font-size: var(--sw-fs-2xl);
  font-weight: var(--sw-fw-semibold);
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.kpi-value.mono {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-lg);
  font-weight: var(--sw-fw-medium);
}
.kpi-label {
  margin-top: 4px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
}

.last-error {
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.last-error strong {
  color: var(--sw-err);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  font-size: var(--sw-fs-xs);
  letter-spacing: var(--sw-ls-caps);
}
.last-error code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
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
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  line-height: var(--sw-lh-relaxed);
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
  font-size: var(--sw-fs-base);
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 6px;
}

.state-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 4px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.state-foot .sel-off {
  color: var(--sw-fg-4);
  text-decoration: line-through;
}
.modpath code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
}
.mod-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
  font-size: var(--sw-fs-base);
}
.mod-table thead th {
  text-align: left;
  font-weight: var(--sw-fw-bold);
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
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
.mod-table tr.off .modname code {
  color: var(--sw-fg-2);
}
.modname code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
}
.env-ref {
  display: block;
  margin-top: 4px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.env-ref code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-2);
}
.modaffects {
  line-height: var(--sw-lh-relaxed);
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
