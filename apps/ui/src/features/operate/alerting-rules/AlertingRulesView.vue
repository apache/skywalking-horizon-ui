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
  Operate › Alerting Rules. Read-only catalog of every alarm rule
  loaded into the OAP cluster, with per-rule body + per-OAP-node
  load state.

  Layout:
   ┌── filter ─────────────────────────────────────────────────┐
   │ search: [_______________]                                  │
   ├── list ─────────────────┬── detail ──────────────────────┤
   │ service_resp_time_rule  │ rule body (period, silence,    │
   │   bundled · loaded 3/3  │   recovery, hooks, metrics)     │
   │ jvm_old_gen_rule        │ trigger expression              │
   │   bundled · loaded 3/3  │ running entities, each tagged   │
   │ …                       │   with the OAP node watching it │
   │                         │ per-OAP-node load state         │
   └─────────────────────────┴────────────────────────────────┘

  Read-only by design — alarm-rule edits go through the YAML file +
  OAP restart (or watcher reload). No buttons to add / change / delete
  rules here.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useQuery } from '@tanstack/vue-query';
import {
  bff,
  type AlertingRuleSummary,
  type AlarmRunningContext,
  type AlarmMqeSnapshotSeries,
} from '@/api/client';
import Modal from '@/features/operate/_shared/Modal.vue';
import Sparkline from '@/components/charts/Sparkline.vue';
import { useOapInfo } from '@/shell/useOapInfo';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
/* OAP timezone offset (minutes east of UTC) — used to re-anchor the
 * server-local window/bucket times to a real instant before display. */
const { timezone } = useOapInfo();

const listQuery = useQuery({
  queryKey: ['operate/alerting-rules'],
  queryFn: () => bff.alarms.adminRules(),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});

const search = ref<string>('');

/* Selected rule is URL-driven via `?id=…` so deep-links from the
 * detail panel (`view in catalog →`) land on a specific rule. */
const selectedId = computed<string>({
  get: () => (typeof route.query.id === 'string' ? route.query.id : ''),
  set: (v: string) => {
    router.replace({ query: { ...route.query, id: v || undefined } });
  },
});

const rules = computed<AlertingRuleSummary[]>(() => listQuery.data.value?.rules ?? []);
const filteredRules = computed<AlertingRuleSummary[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rules.value;
  return rules.value.filter((r) => {
    if (r.ruleId.toLowerCase().includes(q)) return true;
    const expr = r.detail?.expression ?? '';
    return expr.toLowerCase().includes(q);
  });
});

/* Auto-select the first rule on load when nothing is URL-pinned, so
 * the detail pane never sits empty after the list arrives. */
watch(
  () => filteredRules.value,
  (list) => {
    if (!selectedId.value && list.length > 0) {
      selectedId.value = list[0]!.ruleId;
    }
  },
);

const selectedSummary = computed<AlertingRuleSummary | null>(() => {
  if (!selectedId.value) return null;
  return rules.value.find((r) => r.ruleId === selectedId.value) ?? null;
});

const detailQuery = useQuery({
  queryKey: computed(() => ['operate/alerting-rule', selectedId.value]),
  queryFn: () => bff.alarms.adminRule(selectedId.value),
  enabled: computed(() => selectedId.value.length > 0),
  staleTime: 30_000,
});

const detail = computed(() => detailQuery.data.value?.detail ?? selectedSummary.value?.detail ?? null);
const detailNodes = computed(() => detailQuery.data.value?.nodes ?? []);

/* Each OAP instance evaluates the rule over the slice of entities it
 * holds, so the watched set is the UNION across nodes — and the node
 * is load-bearing, not noise (the same rule watches different entities
 * on different instances). Flatten the per-node detail into one list,
 * tagging each entity with the instance watching it. Until the per-node
 * fetch lands we fall back to the summary's best-node entities (no node
 * label yet) so the section doesn't blink empty. */
const watching = computed(() => {
  if (detailNodes.value.length > 0) {
    return detailNodes.value.flatMap((n) =>
      (n.detail?.runningEntities ?? []).map((re) => ({
        scope: re.scope,
        name: re.name,
        message: re.formattedMessage,
        node: n.address,
      })),
    );
  }
  return (detail.value?.runningEntities ?? []).map((re) => ({
    scope: re.scope,
    name: re.name,
    message: re.formattedMessage,
    node: '',
  }));
});

/* Row-click popup: the rule's live running window for ONE entity,
 * fetched on demand from /status/alarm/{ruleId}/{entityName}. The
 * endpoint answers per-node, but only the node evaluating the entity
 * returns a populated body; the rest are stubs we render compactly. */
const selectedEntity = ref<{ scope: string; name: string } | null>(null);
const contextQuery = useQuery({
  queryKey: computed(() => ['operate/alerting-rule-context', selectedId.value, selectedEntity.value?.name]),
  queryFn: () => bff.alarms.adminRuleContext(selectedId.value, selectedEntity.value!.name),
  enabled: computed(() => selectedId.value.length > 0 && selectedEntity.value !== null),
  staleTime: 10_000,
});
const contextNodes = computed(() => contextQuery.data.value?.nodes ?? []);
const contextTitle = computed(() =>
  selectedEntity.value ? `${selectedId.value} · ${selectedEntity.value.name}` : selectedId.value,
);
const contextError = computed(() => {
  const e = contextQuery.error.value;
  return e instanceof Error ? e.message : e ? String(e) : '';
});

function openEntity(scope: string, name: string): void {
  selectedEntity.value = { scope, name };
}

/* A node carries a populated body only while it's actually evaluating
 * the entity; OAP omits state/window on the other nodes. */
function isEvaluating(ctx: AlarmRunningContext | null): ctx is AlarmRunningContext {
  return !!ctx && (ctx.size > 0 || !!ctx.currentState || ctx.windowValues.length > 0);
}
function stateClass(state?: string): string {
  if (!state) return '';
  if (state.includes('FIRING')) return state.includes('SILENCED') ? 'is-warn' : 'is-fire';
  if (state.includes('RECOVERY')) return 'is-recov';
  return '';
}
function fmtLastAlarm(ts: number | string): string {
  const n = typeof ts === 'string' ? Number(ts) : ts;
  if (!n || Number.isNaN(n)) return '—';
  return new Date(n).toLocaleString();
}
/* OAP emits window/bucket times in the SERVER's local wall-clock, with
 * no zone marker — so they must be re-anchored to a real instant via the
 * server's UTC offset, then rendered in the BROWSER's local zone. That
 * keeps them on the same clock as the epoch-derived "last alarm" time and
 * the rest of the UI. Offset unknown (server unreachable) → fall back to
 * the raw server wall-clock rather than guessing. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function oapPartsToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  const tz = timezone.value;
  if (tz === undefined || tz === null) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s) - tz * 60_000;
}
/* Metric bucket ids are zero-padded YYYYMMDDHH(mm)(ss). The alarm window
 * is minute-granular, so render HH:mm in the browser zone. */
function fmtBucketTime(id: string): string {
  const y = +id.slice(0, 4);
  const mo = +id.slice(4, 6);
  const d = +id.slice(6, 8);
  const h = id.length >= 10 ? +id.slice(8, 10) : 0;
  const mi = id.length >= 12 ? +id.slice(10, 12) : 0;
  const s = id.length >= 14 ? +id.slice(12, 14) : 0;
  const e = oapPartsToEpoch(y, mo, d, h, mi, s);
  if (e === null) return id.length >= 12 ? `${pad2(h)}:${pad2(mi)}` : id;
  const dd = new Date(e);
  return `${pad2(dd.getHours())}:${pad2(dd.getMinutes())}`;
}
/* `endTime` is an OAP-server-local datetime string (`2026-06-01T06:42:00.000`,
 * no zone marker). Convert to browser-local; pass through unparseable input. */
function fmtEndTime(s?: string): string {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return s;
  const e = oapPartsToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0));
  return e === null ? s : new Date(e).toLocaleString();
}
function parseSnapshot(json: string): AlarmMqeSnapshotSeries[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as AlarmMqeSnapshotSeries[]) : [];
  } catch {
    return [];
  }
}
function sparkValues(series: AlarmMqeSnapshotSeries): Array<number | null> {
  return series.values.map((v) => (v.isEmptyValue ? null : v.doubleValue));
}
</script>

<template>
  <div class="ar">
    <header class="ar__head">
      <div>
        <div class="ar__kicker">{{ t('Operate · Alerting') }}</div>
        <h1>{{ t('Alerting rules') }}</h1>
        <p class="ar__lede">
          <i18n-t keypath="Read-only catalog of every alarm rule loaded by OAP, with its body and per-node load state. Rules edit through OAP's {file} + watcher reload — there's no mutation surface here by design.">
            <template #file><code>alarm-settings.yml</code></template>
          </i18n-t>
        </p>
      </div>
      <div class="ar__head-actions">
        <button
          type="button"
          class="ar__refresh"
          :disabled="listQuery.isFetching.value"
          @click="listQuery.refetch()"
        >{{ listQuery.isFetching.value ? t('refreshing…') : t('refresh') }}</button>
      </div>
    </header>

    <div v-if="listQuery.isPending.value" class="ar__empty">{{ t('loading…') }}</div>

    <div v-else-if="listQuery.data.value && !listQuery.data.value.reachable" class="ar__empty ar__empty--err">
      <i18n-t keypath="Admin server unreachable — {err}. Check the {sel} selector and the BFF's {url}.">
        <template #err><code>{{ listQuery.data.value.error ?? t('no response') }}</code></template>
        <template #sel><code>SW_ADMIN_SERVER</code></template>
        <template #url><code>oap.adminUrl</code></template>
      </i18n-t>
    </div>

    <template v-else>
      <div class="ar__filter">
        <input
          v-model="search"
          type="text"
          :placeholder="t('search rule id or expression…')"
          class="ar__search"
        />
        <span class="ar__count">{{ filteredRules.length === 1 ? t('{n} rule', { n: filteredRules.length }) : t('{n} rules', { n: filteredRules.length }) }}</span>
      </div>

      <div class="ar__split">
        <ul class="ar__list">
          <li
            v-for="r in filteredRules"
            :key="r.ruleId"
            class="ar__list-item"
            :class="{ active: r.ruleId === selectedId }"
            @click="selectedId = r.ruleId"
          >
            <div class="ar__list-name">
              <code>{{ r.ruleId }}</code>
            </div>
            <div class="ar__list-meta">
              <span class="ar__load" :class="{ partial: r.loadedOn < r.totalNodes }">
                {{ t('loaded {a}/{b}', { a: r.loadedOn, b: r.totalNodes }) }}
              </span>
              <span v-if="r.detail?.period" class="ar__period">
                {{ t('{n}m window', { n: r.detail.period }) }}
              </span>
            </div>
          </li>
          <li v-if="filteredRules.length === 0" class="ar__list-empty">
            {{ t('No rules match.') }}
          </li>
        </ul>

        <aside class="ar__detail">
          <div v-if="!selectedSummary && !detail" class="ar__placeholder">
            {{ t('Select a rule to see its body.') }}
          </div>
          <template v-else>
            <header class="ar__detail-head">
              <h2><code>{{ selectedId }}</code></h2>
            </header>

            <div v-if="detailQuery.isPending.value && !detail" class="ar__placeholder">{{ t('loading…') }}</div>
            <div v-else-if="!detail" class="ar__placeholder">
              {{ t('Rule body unavailable on every node.') }}
            </div>
            <template v-else>
              <section class="ar__sec">
                <div class="ar__kicker-s">{{ t('Expression') }}</div>
                <pre class="ar__expr">{{ detail.expression }}</pre>
              </section>

              <section class="ar__sec">
                <div class="ar__kicker-s">{{ t('Window') }}</div>
                <div class="ar__meta-grid">
                  <div><span class="ar__lbl">{{ t('period') }}</span><span>{{ t('{n}m', { n: detail.period }) }}</span></div>
                  <div><span class="ar__lbl">{{ t('silence') }}</span><span>{{ t('{n}m', { n: detail.silencePeriod }) }}</span></div>
                  <div><span class="ar__lbl">{{ t('recovery-obs') }}</span><span>{{ t('{n}m', { n: detail.recoveryObservationPeriod }) }}</span></div>
                  <div v-if="detail.additionalPeriod > 0">
                    <span class="ar__lbl">{{ t('additional') }}</span><span>{{ t('{n}m', { n: detail.additionalPeriod }) }}</span>
                  </div>
                </div>
              </section>

              <section v-if="detail.includeMetrics.length > 0" class="ar__sec">
                <div class="ar__kicker-s">{{ t('Metrics referenced') }}</div>
                <div class="ar__chips">
                  <code v-for="m in detail.includeMetrics" :key="m">{{ m }}</code>
                </div>
              </section>

              <section v-if="detail.hooks.length > 0" class="ar__sec">
                <div class="ar__kicker-s">{{ t('Hooks') }}</div>
                <div class="ar__chips">
                  <span v-for="h in detail.hooks" :key="h" class="ar__tag">{{ h }}</span>
                </div>
              </section>

              <section v-if="detail.tags.length > 0" class="ar__sec">
                <div class="ar__kicker-s">{{ t('Tags') }}</div>
                <div class="ar__chips">
                  <span v-for="tg in detail.tags" :key="`${tg.key}=${tg.value}`" class="ar__tag">
                    {{ tg.key }}={{ tg.value }}
                  </span>
                </div>
              </section>

              <section
                v-if="detail.includeEntityNames.length > 0 || detail.includeEntityNamesRegex"
                class="ar__sec"
              >
                <div class="ar__kicker-s">{{ t('Include entities') }}</div>
                <div v-if="detail.includeEntityNamesRegex" class="ar__regex">
                  {{ t('regex:') }} <code>{{ detail.includeEntityNamesRegex }}</code>
                </div>
                <div v-if="detail.includeEntityNames.length > 0" class="ar__chips">
                  <code v-for="n in detail.includeEntityNames" :key="n">{{ n }}</code>
                </div>
              </section>

              <section
                v-if="detail.excludeEntityNames.length > 0 || detail.excludeEntityNamesRegex"
                class="ar__sec"
              >
                <div class="ar__kicker-s">{{ t('Exclude entities') }}</div>
                <div v-if="detail.excludeEntityNamesRegex" class="ar__regex">
                  {{ t('regex:') }} <code>{{ detail.excludeEntityNamesRegex }}</code>
                </div>
                <div v-if="detail.excludeEntityNames.length > 0" class="ar__chips">
                  <code v-for="n in detail.excludeEntityNames" :key="n">{{ n }}</code>
                </div>
              </section>

              <section v-if="watching.length > 0" class="ar__sec">
                <div class="ar__kicker-s">
                  {{ t('Currently watching ({n})', { n: watching.length }) }}
                </div>
                <ul class="ar__entity-list">
                  <li
                    v-for="re in watching"
                    :key="`${re.node}/${re.scope}/${re.name}`"
                    class="ar__entity-row"
                    role="button"
                    tabindex="0"
                    :title="t('Show running context for {name}', { name: re.name })"
                    @click="openEntity(re.scope, re.name)"
                    @keydown.enter.prevent="openEntity(re.scope, re.name)"
                    @keydown.space.prevent="openEntity(re.scope, re.name)"
                  >
                    <span class="ar__tag">{{ re.scope }}</span>
                    <code>{{ re.name }}</code>
                    <span v-if="re.node" class="ar__entity-node">
                      <span class="ar__entity-node-lbl">{{ t('node') }}</span>
                      <code>{{ re.node }}</code>
                    </span>
                  </li>
                </ul>
              </section>

              <section v-if="detailNodes.length > 1" class="ar__sec">
                <div class="ar__kicker-s">{{ t('Per-node state') }}</div>
                <table class="ar__node-table">
                  <thead>
                    <tr>
                      <th>{{ t('node') }}</th>
                      <th>{{ t('ok') }}</th>
                      <th>{{ t('note') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="n in detailNodes" :key="n.address">
                      <td><code>{{ n.address }}</code></td>
                      <td>
                        <span class="ar__dot" :class="n.ok ? 'is-ok' : 'is-err'" />
                        {{ n.ok ? t('ok') : t('err') }}
                      </td>
                      <td class="ar__node-note">{{ n.error ?? (n.detail ? '—' : t('no body returned')) }}</td>
                    </tr>
                  </tbody>
                </table>
              </section>
            </template>
          </template>
        </aside>
      </div>
    </template>

    <Modal
      :open="selectedEntity !== null"
      :title="contextTitle"
      width="660px"
      @close="selectedEntity = null"
    >
      <div class="arc">
        <pre v-if="detail" class="ar__expr arc__expr">{{ detail.expression }}</pre>

        <div v-if="contextQuery.isPending.value" class="arc__msg">{{ t('Reading running context…') }}</div>
        <div v-else-if="contextQuery.isError.value" class="arc__msg arc__msg--err">
          {{ t('Running context unavailable.') }} <code>{{ contextError }}</code>
        </div>
        <div v-else-if="contextNodes.length === 0" class="arc__msg">
          {{ t('No running context returned for this entity.') }}
        </div>
        <template v-else>
          <div v-for="n in contextNodes" :key="n.address" class="arc__node">
            <div class="arc__node-head">
              <span class="ar__dot" :class="n.ok ? 'is-ok' : 'is-err'" />
              <code class="ar__inst-addr">{{ n.address }}</code>
              <span
                v-if="n.context?.currentState"
                class="arc__state"
                :class="stateClass(n.context.currentState)"
              >{{ n.context.currentState }}</span>
            </div>

            <div v-if="n.error" class="arc__msg arc__msg--err">{{ n.error }}</div>
            <div v-else-if="!isEvaluating(n.context)" class="arc__msg">
              {{ t('Not evaluated on this instance.') }}
            </div>
            <template v-else>
              <div class="ar__meta-grid arc__grid">
                <div><span class="ar__lbl">{{ t('window') }}</span><span>{{ t('{n}m', { n: n.context?.size }) }}</span></div>
                <div><span class="ar__lbl">{{ t('silence left') }}</span><span>{{ n.context?.silenceCountdown }}</span></div>
                <div><span class="ar__lbl">{{ t('recovery left') }}</span><span>{{ n.context?.recoveryObservationCountdown }}</span></div>
                <div v-if="n.context?.endTime"><span class="ar__lbl">{{ t('window end') }}</span><span>{{ fmtEndTime(n.context.endTime) }}</span></div>
              </div>
              <div class="arc__last">
                <span class="ar__lbl">{{ t('last alarm') }}</span>
                <span class="arc__last-t">{{ fmtLastAlarm(n.context?.lastAlarmTime ?? 0) }}</span>
                <span v-if="n.context?.lastAlarmMessage" class="arc__last-msg">{{ n.context.lastAlarmMessage }}</span>
              </div>

              <div
                v-for="(json, metric) in (n.context?.mqeMetricsSnapshot ?? {})"
                :key="metric"
                class="arc__metric"
              >
                <div class="arc__metric-head"><code>{{ metric }}</code></div>
                <div v-for="(series, si) in parseSnapshot(json)" :key="si" class="arc__series">
                  <Sparkline :values="sparkValues(series)" :width="280" :height="38" fluid :stroke="1.5" class="arc__spark" />
                  <div class="arc__axis">
                    <div
                      v-for="(v, vi) in series.values"
                      :key="v.id"
                      class="arc__tick"
                      :class="{ 'is-empty': v.isEmptyValue }"
                      :style="{ left: series.values.length > 1 ? (vi / (series.values.length - 1)) * 100 + '%' : '50%' }"
                    >
                      <span class="arc__tick-v">{{ v.isEmptyValue ? '—' : v.doubleValue }}</span>
                      <span class="arc__tick-t">{{ fmtBucketTime(v.id) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </template>

        <details class="arc__raw">
          <summary>{{ t('raw context') }}</summary>
          <pre>{{ JSON.stringify(contextQuery.data.value ?? {}, null, 2) }}</pre>
        </details>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.ar {
  padding: 20px 20px 60px;
  max-width: 1500px;
  margin: 0 auto;
}
.ar__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.ar__head > div:first-child { flex: 1; }
.ar__kicker {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.ar h1 {
  font-size: var(--sw-fs-2xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.ar__lede {
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 820px;
}
.ar__lede code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.ar__refresh {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-sm);
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}
.ar__refresh:not(:disabled):hover { background: var(--sw-bg-2); border-color: var(--sw-accent); }
.ar__refresh:disabled { opacity: 0.55; cursor: not-allowed; }

.ar__empty {
  padding: 32px;
  text-align: center;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-3);
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line);
  border-radius: 8px;
}
.ar__empty--err {
  color: var(--sw-err);
  border-color: rgba(239,68,68,0.4);
}
.ar__empty code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}

.ar__filter {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 8px 10px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
}
.ar__search {
  flex: 1;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-base);
  padding: 5px 8px;
  border-radius: 5px;
  outline: none;
}
.ar__search:focus { border-color: var(--sw-accent); }
.ar__count {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
}

.ar__split {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 16px;
  align-items: start;
}
.ar__list {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
  max-height: calc(100vh - 220px);
  overflow-y: auto;
}
.ar__list-item {
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
}
.ar__list-item:last-child { border-bottom: none; }
.ar__list-item:hover { background: var(--sw-bg-2); }
.ar__list-item.active {
  background: var(--sw-bg-3);
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.ar__list-name code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-0);
  background: transparent;
  padding: 0;
}
.ar__list-meta {
  margin-top: 4px;
  display: flex;
  gap: 10px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.ar__load.partial { color: var(--sw-warn); }
.ar__period { font-variant-numeric: tabular-nums; }
.ar__list-empty {
  padding: 24px;
  text-align: center;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-3);
}

.ar__detail {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: calc(100vh - 220px);
  overflow-y: auto;
}
.ar__placeholder {
  padding: 32px;
  text-align: center;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-3);
}
.ar__detail-head h2 {
  margin: 0;
  font-size: var(--sw-fs-md);
  font-weight: 600;
}
.ar__detail-head h2 code {
  font-family: var(--sw-mono);
  color: var(--sw-fg-0);
  background: transparent;
  font-size: var(--sw-fs-md);
}
.ar__sec { border-top: 1px solid var(--sw-line); padding-top: 12px; }
.ar__sec:first-of-type { border-top: 0; padding-top: 0; }
.ar__kicker-s {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  margin-bottom: 6px;
}
.ar__expr {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  padding: 10px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}
.ar__meta-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.ar__meta-grid > div {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  font-size: var(--sw-fs-sm);
  font-variant-numeric: tabular-nums;
}
.ar__lbl {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.ar__chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ar__chips code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--sw-line);
}
.ar__tag {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--sw-line);
}
.ar__regex { font-size: var(--sw-fs-sm); color: var(--sw-fg-2); margin-bottom: 6px; }
.ar__regex code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.ar__entity-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ar__entity-list li {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ar__entity-row {
  cursor: pointer;
  padding: 2px 4px;
  margin: 0 -4px;
  border-radius: 4px;
  outline: none;
}
.ar__entity-row:hover { background: var(--sw-bg-2); }
.ar__entity-row:focus-visible { box-shadow: inset 0 0 0 1px var(--sw-accent); }
.ar__entity-list code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
/* Per-entity node tag — which OAP instance is evaluating this entity.
 * Right-aligned so the scope + entity name read as the primary column
 * and the node reads as a trailing annotation. */
.ar__entity-node {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.ar__entity-node-lbl {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.ar__entity-node code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  padding: 1px 5px;
  border-radius: 3px;
}
.ar__node-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--sw-fs-sm);
}
.ar__node-table th, .ar__node-table td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid var(--sw-line);
}
.ar__node-table th {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.ar__node-table code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
}
.ar__node-note { color: var(--sw-fg-3); font-style: italic; max-width: 320px; overflow-wrap: anywhere; }
.ar__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}
.ar__dot.is-ok { background: var(--sw-ok); }
.ar__dot.is-err { background: var(--sw-err); }

.arc { display: flex; flex-direction: column; gap: 14px; }
.arc__expr { margin: 0; }
.arc__msg {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
  font-style: italic;
}
.arc__msg--err { color: var(--sw-err); font-style: normal; }
.arc__msg code {
  font-family: var(--sw-mono);
  font-style: normal;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.arc__node {
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 10px 12px;
  background: var(--sw-bg-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.arc__node-head { display: flex; align-items: center; gap: 8px; }
.arc__state {
  margin-left: auto;
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
  padding: 1px 7px;
  border-radius: 3px;
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-2);
}
.arc__state.is-fire { color: var(--sw-err); border-color: var(--sw-err); }
.arc__state.is-warn { color: var(--sw-warn); border-color: var(--sw-warn); }
.arc__state.is-recov { color: var(--sw-accent); border-color: var(--sw-accent); }
.arc__grid { grid-template-columns: repeat(2, 1fr); }
.arc__last {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--sw-fs-sm);
}
.arc__last-t { font-variant-numeric: tabular-nums; color: var(--sw-fg-0); }
.arc__last-msg { color: var(--sw-fg-2); font-style: italic; }
.arc__metric { display: flex; flex-direction: column; gap: 6px; }
.arc__metric-head code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  background: var(--sw-bg-1);
  padding: 1px 5px;
  border-radius: 3px;
}
/* Sparkline + value/time axis share one padded content box so the
 * axis ticks (positioned at i/(n-1) of the box width, centered) sit
 * directly under the line's points. The inline padding leaves room for
 * the half-width overhang of the first/last centered ticks. */
.arc__series { position: relative; padding: 0 24px; }
.arc__spark { display: block; width: 100%; }
.arc__axis { position: relative; height: 32px; margin-top: 3px; }
.arc__tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  white-space: nowrap;
}
.arc__tick.is-empty { opacity: 0.45; }
.arc__tick-v { font-size: var(--sw-fs-sm); color: var(--sw-fg-0); font-variant-numeric: tabular-nums; }
.arc__tick-t { font-size: var(--sw-fs-xs); color: var(--sw-fg-3); font-variant-numeric: tabular-nums; }
.arc__raw { font-size: var(--sw-fs-xs); }
.arc__raw summary {
  cursor: pointer;
  color: var(--sw-fg-3);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  font-weight: var(--sw-fw-bold);
}
.arc__raw pre {
  margin: 8px 0 0;
  max-height: 240px;
  overflow: auto;
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  padding: 8px 10px;
}
</style>
