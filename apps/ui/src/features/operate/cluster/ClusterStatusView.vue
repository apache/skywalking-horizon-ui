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
import { useQuery } from '@tanstack/vue-query';
import type { PreflightModule, TraceQLSourceStatus, TraceQLDatasource } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import { useOapInfo } from '@/shell/useOapInfo';
import { useAdminFeatures } from '@/shell/useAdminFeatures';

// Three-pane Cluster Status:
//   - Pane A (graphql / :12800): version, server clock, timezone,
//     health score. Drives the global topbar status chip and the
//     global "OAP unreachable" banner.
//   - Pane B (admin host / :17128): preflight of SWIP-13 selectors
//     (admin-server, receiver-runtime-rule, dsl-debugging, inspect).
//     Drives the per-page warning header on admin-host routes.
//   - Pane C (trace APIs): the Zipkin v2 endpoint and each TraceQL
//     datasource, which feed the per-layer trace rows other than the
//     native one.
// The panes are queried separately on purpose — a healthy :12800 with
// a broken admin port is a real, recoverable state (forgot to expose
// :17128 in the k8s service) and the page must show that clearly.

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

/**
 * Pane D · OAP's TraceQL (Tempo API) service, one datasource per store.
 *
 * Read through the façade rather than the Traces tab's own composable — a
 * feature does not reach into another's data — and answered by the same cached
 * probe the tab uses, so this page and the tab cannot disagree. It needs
 * `traces:read`; a role without it sees the pane as unknown rather than as an
 * outage, because a permission is not a failure.
 */
const traceqlQuery = useQuery({
  queryKey: ['traceql-sources'],
  queryFn: ({ signal }) => bffClient.traceql.sources(signal),
  staleTime: 60_000,
  retry: false,
});
const TRACEQL_ROWS = computed<ReadonlyArray<{ ds: TraceQLDatasource; label: string; path: string }>>(() => [
  { ds: 'native', label: t('SkyWalking-native spans'), path: '/skywalking' },
  { ds: 'zipkin', label: t('Zipkin spans'), path: '/zipkin' },
  { ds: 'otlp', label: t('Natively stored OTLP spans'), path: '/otlp' },
]);
const traceqlSources = computed<TraceQLSourceStatus[]>(() => traceqlQuery.data.value ?? []);
const traceqlDenied = computed(() => traceqlQuery.isError.value);
function traceqlOf(ds: TraceQLDatasource): TraceQLSourceStatus | null {
  return traceqlSources.value.find((x) => x.ds === ds) ?? null;
}
/** Configured sources only: an unconfigured datasource is a deployment that
 *  does not use it, which is not a state to report as broken. */
const traceqlConfigured = computed(() => traceqlSources.value.filter((x) => x.configured));
/** One row of the Trace APIs table: the API, the store it answers over, the
 *  endpoint, and its state in the admin table's own vocabulary. */
interface TraceApiRow {
  api: string;
  source: string;
  url: string;
  state: { cls: string; label: string };
  version?: string;
  ds?: TraceQLDatasource;
  /** What the endpoint said, and what to do about it — carried BY the row.
   *  These were two stacks of banners under the table, so the reader had to
   *  match a message back to the row it belonged to. */
  error?: string;
  hint?: string;
}
const traceApiRows = computed<TraceApiRow[]>(() => {
  const rows: TraceApiRow[] = [
    {
      api: 'Zipkin v2 REST',
      source: t('Zipkin spans'),
      url: info.value?.zipkinUrl ?? '—',
      state:
        zipkinReachable.value === undefined
          ? { cls: 'is-unknown', label: t('loading…') }
          : zipkinReachable.value
            ? { cls: 'is-ok', label: t('reachable') }
            : { cls: 'is-err', label: t('unreachable') },
      ...(zipkinReachable.value === false
        ? {
          ...(info.value?.zipkinError ? { error: info.value.zipkinError } : {}),
          hint: t("Tried {url}. Confirm OAP's Zipkin receiver / query is enabled and the oap.zipkinUrl in horizon's config points at the right host:port (shared GraphQL port → <queryUrl>/zipkin; standalone → :9412/zipkin). Only the Zipkin trace menu is affected.", { url: `${info.value?.zipkinUrl ?? ''}/api/v2/services` }),
        }
        : {}),
    },
  ];
  for (const r of TRACEQL_ROWS.value) {
    const st = traceqlOf(r.ds);
    rows.push({
      api: 'TraceQL',
      source: r.label,
      // A 404 and a dead port are ONE state: the datasource did not answer.
      // What differs is why, which the row's note below says — a status that
      // splits on the reason makes the reader decode two words for one fact.
      url: st?.url || t('no URL configured'),
      state: traceqlDenied.value || !st
        ? { cls: 'is-unknown', label: t('unknown') }
        : !st.configured
          ? { cls: 'is-unknown', label: t('not configured') }
          : st.reachable
            ? { cls: 'is-ok', label: t('reachable') }
            : { cls: 'is-err', label: t('unreachable') },
      ...(st?.version ? { version: st.version } : {}),
      // A 404 is OAP answering; it needs a sentence, not an error. Only a
      // real failure carries the endpoint's own words.
      ...(st?.configured && st.served === false
        ? { hint: t('This OAP does not enable the {name} datasource. Switch it on with SW_TRACEQL_ENABLE_DATASOURCE_* and it appears here; until then the rows fed by it stay empty.', { name: r.label }) }
        : {}),
      ...(st?.configured && st.served !== false && st.reachable === false
        ? {
          ...(st.error ? { error: st.error } : {}),
          hint: t("Tried {url}. Enable OAP's traceQL module (SW_TRACEQL=default with the datasource switched on) and confirm oap.traceql points at its host:port and context path — {path} by default on port 3200.", { url: `${st.url}/api/status/buildinfo`, path: r.path }),
        }
        : {}),
      ds: r.ds,
    });
  }
  return rows;
});

/**
 * The Trace APIs pane's verdict: the Zipkin endpoint and every CONFIGURED
 * TraceQL datasource, read together. An unconfigured datasource is a
 * deployment that does not use it — not a state to report as broken — and a
 * probe nobody could read (no `traces:read`) leaves the pane unknown rather
 * than claiming an outage.
 */
const traceApiBadgeState = computed<'ok' | 'err' | 'unknown'>(() => {
  const failing = zipkinReachable.value === false
    || (!traceqlDenied.value && traceqlConfigured.value.some((x) => !x.reachable));
  if (failing) return 'err';
  const known = zipkinReachable.value === true
    || (!traceqlDenied.value && traceqlConfigured.value.some((x) => x.reachable));
  return known ? 'ok' : 'unknown';
});
const traceApiBadgeLabel = computed<string>(() => {
  if (traceApiBadgeState.value === 'err') return t('degraded');
  if (traceApiBadgeState.value === 'ok') return t('reachable');
  return traceqlQuery.isLoading.value ? t('loading…') : t('not configured');
});


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

function refreshAll(): void {
  void refetchInfo();
  void refetchPreflight();
  // The TraceQL probe is cached for five minutes in the BFF, so a recovered
  // datasource would go on reading red until something else refetched it.
  void traceqlQuery.refetch();
}

/**
 * The template store's own state, as distinct from the `ui-management` module
 * row above. That row says whether the ENDPOINT answers; this says what came
 * back from it, when, and what the last failure said — three questions an
 * operator asks in that order, and which "unreachable" alone answers none of.
 */
const store = computed(() => preflight.value?.templateStore ?? null);
const storeBadgeState = computed<'ok' | 'warn' | 'err' | 'unknown'>(() => {
  const s = store.value;
  if (!s) return 'unknown';
  // Readonly is yellow, as the module table's `readonly · bundled` row is: the
  // store is not being read at all, which is a deliberate state rather than a
  // healthy one, and the two places that say it must not disagree.
  if (s.mode === 'readonly') return 'warn';
  // Unreachable but still rendering is a warning; unreachable with nothing to
  // render is an outage. Collapsing the two is what made a blip look fatal.
  if (s.servingRetained) return 'warn';
  if (s.unreachable) return 'err';
  return 'ok';
});
const storeBadgeLabel = computed<string>(() => {
  const s = store.value;
  if (!s) return t('unknown');
  if (s.mode === 'readonly') return t('readonly · bundled');
  if (s.servingRetained) return t('stale · store unreachable');
  if (s.unreachable) return t('unreachable');
  return t('loaded');
});
/** The clock time of the last read — `07:43:33`, not the full date. The date
 *  is only ever today's on a page an operator is watching. */
const storeLastSyncClock = computed<string>(() => {
  const at = store.value?.lastSuccessfulSyncAt ?? null;
  return at === null ? '' : new Date(at).toLocaleTimeString();
});
/** "4m ago" — the figure an operator scans for; the exact time sits underneath
 *  it as the card's label. */
/** The figures, as one list — so the card reads as a single answer rather than
 *  as several unrelated ones. Zero is worth showing; a kind nobody publishes
 *  is not, so translations only appear when there are some. */
const storeCounts = computed<Array<{ value: number; label: string }>>(() => {
  const s = store.value;
  if (!s) return [];
  // Pluralised the way the rest of the app does it — "1 alert pages" is the
  // kind of thing that makes a status page look unfinished.
  const label = (key: string, n: number): string => t(key, n, { named: { n } });
  const out = [
    { value: s.counts.layer ?? 0, label: label('layer template | layer templates', s.counts.layer ?? 0) },
    { value: s.counts.overview ?? 0, label: label('overview | overviews', s.counts.overview ?? 0) },
    { value: s.counts.alert ?? 0, label: label('alert page | alert pages', s.counts.alert ?? 0) },
  ];
  if (s.translations > 0) {
    out.push({
      value: s.translations,
      label: label('translation overlay | translation overlays', s.translations),
    });
  }
  return out;
});
const storeLastSyncShort = computed<string>(() => {
  const at = store.value?.lastSuccessfulSyncAt ?? null;
  if (at === null) return t('never');
  // Off the page's own ticker, so it ages on screen rather than freezing at
  // whatever it said when the pane rendered.
  const sec = Math.max(1, Math.floor((now.value - at) / 1000));
  if (sec < 60) return t('{n}s ago', { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('{n}m ago', { n: min });
  return t('{n}h ago', { n: Math.floor(min / 60) });
});
</script>

<template>
  <div class="cluster">
    <header class="page-head">
      <div>
        <div class="kicker">{{ t('Operate') }} · {{ t('Cluster status') }}</div>
        <h1>{{ t('OAP cluster') }}</h1>
        <p class="lede">
          {{ t('Every port of the OAP backend Horizon is connected to. Query / GraphQL (:12800) drives every observability page; the admin host (:17128) gates DSL management, Live debugger, Metrics inspect, and Dump; the trace APIs — Zipkin and each TraceQL datasource — feed only the trace rows they serve. Each is polled independently: if one shows red the others can still be green.') }}
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


    <!-- ── Pane B2 · Dashboard templates ─────────────────────────── -->
    <section v-if="store" class="pane">
      <header class="pane-head">
        <h2>{{ t('Dashboard templates') }}</h2>
        <span class="sw-badge" :class="`is-${storeBadgeState}`">
          <span class="state-dot" />{{ storeBadgeLabel }}
        </span>
      </header>

      <p class="pane-lede">
        {{ t('What Horizon has loaded from OAP\'s template store, and when. The module row above says whether the endpoint answers; this says what came back from it.') }}
      </p>

      <!-- ONE card, figures inline. Four cards each carrying a single number
           gave a count the same weight as a whole pane, and read as four
           unrelated facts rather than one answer to "what is loaded". -->
      <div class="sw-card ts-card">
        <div class="ts-counts">
          <div v-for="c in storeCounts" :key="c.label" class="ts-count">
            <span class="ts-num mono">{{ c.value }}</span>
            <span class="ts-label">{{ c.label }}</span>
          </div>
        </div>
        <!-- Relative figure plus the clock time it happened at. No countdown
             to the next read: that is the browser's own timer, and rendering
             it live would mean re-rendering this page every second to age a
             label nobody is waiting on. -->
        <div class="ts-read">
          {{ t('Loaded') }} <strong>{{ storeLastSyncShort }}</strong>
          <span v-if="storeLastSyncClock" class="mono">· {{ storeLastSyncClock }}</span>
        </div>
      </div>

      <div v-if="store.servingRetained" class="last-error">
        <strong>{{ t('Serving an earlier read') }}</strong>
        <span>{{ t('The store cannot be read right now, so these are the templates that loaded last. They are yours, not the bundled defaults — only out of date.') }}</span>
      </div>
      <div v-else-if="store.unreachable" class="last-error">
        <strong>{{ t('Nothing loaded') }}</strong>
        <span>{{ t('The store has never been read successfully, so dashboards, overviews and maps stay empty until it answers.') }}</span>
      </div>
      <div v-if="store.lastError" class="last-error">
        <strong>{{ t('Last error') }}</strong>
        <code>{{ store.lastError.message }}</code>
      </div>
    </section>

    <!-- ── Pane C · Trace APIs ───────────────────────────────────
         The endpoints behind the trace rows. The NATIVE trace query is not
         here: it rides the GraphQL port, so Pane A already answers for it. -->
    <section class="pane">
      <header class="pane-head">
        <h2>{{ t('Trace APIs') }}</h2>
        <span class="sw-badge" :class="`is-${traceApiBadgeState}`">
          <span class="state-dot" />{{ traceApiBadgeLabel }}
        </span>
      </header>

      <p class="pane-lede">
        {{ t("The endpoints behind a layer's trace rows, each probed on its own. Native traces are not here — they are answered by the GraphQL port above. A red dot in this pane is not a cluster-wide outage: only the trace rows fed by that endpoint are affected, and every other page keeps working.") }}
      </p>

      <table class="mod-table">
        <thead>
          <tr>
            <th>{{ t('API') }}</th>
            <th>{{ t('Source') }}</th>
            <th>{{ t('State') }}</th>
            <th>{{ t('Endpoint') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in traceApiRows" :key="`${r.api}-${r.source}`">
          <tr :class="{ off: r.state.cls === 'is-err' }">
            <td class="modname"><code>{{ r.api }}</code></td>
            <td class="modname">{{ r.source }}</td>
            <td>
              <span class="sw-badge" :class="r.state.cls">
                <span class="state-dot" />{{ r.state.label }}
              </span>
              <div v-if="r.version" class="state-foot">
                <span class="sel">{{ t('Tempo API {version}', { version: r.version }) }}</span>
              </div>
            </td>
            <td class="modpath"><code>{{ r.url }}</code></td>
          </tr>
          <tr v-if="r.error || r.hint" class="row-note">
            <td colspan="4">
              <code v-if="r.error">{{ r.error }}</code>
              <p v-if="r.hint" class="hint">{{ r.hint }}</p>
            </td>
          </tr>
          </template>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.row-note td {
  padding: 2px 10px 10px;
  border-top: none;
}
.row-note code {
  display: block;
  font-size: 10.5px;
  color: var(--sw-err);
  margin-bottom: 4px;
  word-break: break-all;
}
.row-note .hint {
  margin: 0;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  line-height: 1.5;
}
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

.ts-card {
  padding: 12px 14px;
}
.ts-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 26px;
  align-items: baseline;
}
.ts-count {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.ts-num {
  font-size: var(--sw-fs-lg);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-1);
  font-variant-numeric: tabular-nums;
}
.ts-label {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
}
.ts-read {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--sw-line);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.ts-read strong {
  color: var(--sw-fg-1);
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
  color: var(--sw-fg-3);
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
