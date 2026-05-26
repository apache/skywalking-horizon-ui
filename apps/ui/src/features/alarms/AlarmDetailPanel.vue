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
  Right-side detail pane for a single alarm. Shows:
   - rule message + status pill
   - trigger expression (MQE) from snapshot.expression
   - snapshot.metrics rendered as a small TimeChart so operators see
     the actual values that crossed threshold at the firing moment
   - entity scope (service / instance / endpoint)
   - tags

  Alarms are read-only on the OAP side (auto-recover) — no acknowledge
  / silence buttons here, by design.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery } from '@tanstack/vue-query';
import { bff, type AlarmMessage, type AlertingRuleDetailResponse } from '@/api/client';
import AlarmSnapshotChart from './AlarmSnapshotChart.vue';
import { formatAlarmEntity } from '@/utils/alarmEntity';

const { t } = useI18n({ useScope: 'global' });
const props = defineProps<{ alarm: AlarmMessage | null }>();

const entityLabel = computed(() =>
  props.alarm ? formatAlarmEntity(props.alarm.scope, props.alarm.name) : null,
);

const firing = computed<boolean>(() => props.alarm?.recoveryTime === null);

/* OAP packs `<entityBase64>.<ruleNumber>` into the AlarmMessage.id.
 * The rule's actual name lives in the `message` text via the
 * formatter template — we don't have a clean way to extract it from
 * the wire shape alone. Best signal: scan the message for the rule
 * IDs that admin-server knows about and pick the first match.
 *
 * The query is intentionally minimal — fires only when there's an
 * alarm selected AND the admin-server `/status/alarm/rules` endpoint
 * is reachable. Failures are silent (no panic-banner): the rule
 * section just collapses to "rule definition unavailable".
 */
const rulesIndex = useQuery({
  queryKey: ['alarms/admin-rules-index'],
  queryFn: () => bff.alarms.adminRules(),
  enabled: computed(() => props.alarm !== null),
  staleTime: 60_000,
  retry: false,
});

/** Best-effort rule-id pick: longest-prefix match of any known rule
 *  ID in the alarm message. Longest wins because rule names share
 *  prefixes (`service_resp_time_rule` vs `service_resp_time_p99_rule`)
 *  and we want the more specific match. */
const matchedRuleId = computed<string | null>(() => {
  const a = props.alarm;
  const list = rulesIndex.data.value?.rules ?? [];
  if (!a || list.length === 0) return null;
  const msg = a.message;
  let best: string | null = null;
  for (const r of list) {
    if (msg.includes(r.ruleId)) {
      if (!best || r.ruleId.length > best.length) best = r.ruleId;
    }
  }
  return best;
});

const ruleDetailQuery = useQuery({
  queryKey: computed(() => ['alarms/admin-rule', matchedRuleId.value]),
  queryFn: (): Promise<AlertingRuleDetailResponse> =>
    bff.alarms.adminRule(matchedRuleId.value!),
  enabled: computed(() => matchedRuleId.value !== null),
  staleTime: 60_000,
  retry: false,
});

const ruleDetail = computed(() => ruleDetailQuery.data.value?.detail ?? null);

/** Inferred snapshot window — one value per MINUTE bucket. Read from
 *  the first metric's first result's value-array length. */
const snapshotBuckets = computed<number>(() => {
  const m = props.alarm?.snapshot.metrics[0];
  const r = m?.results[0];
  return r?.values.length ?? 0;
});

/** Bucket-range label: "HH:MM → HH:MM" computed the same way the
 *  snapshot chart anchors its x-axis (latest bucket = trigger minute,
 *  earlier buckets step back). Empty when no snapshot. */
const snapshotRangeLabel = computed<string>(() => {
  if (!props.alarm || snapshotBuckets.value === 0) return '';
  const MINUTE = 60_000;
  const T = Math.floor(props.alarm.startTime / MINUTE) * MINUTE;
  const start = T - (snapshotBuckets.value - 1) * MINUTE;
  return `${fmtMinute(start)} → ${fmtMinute(T)}`;
});

function fmtMinute(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

const startedRelative = computed<string>(() => {
  if (!props.alarm) return '';
  return formatRelative(props.alarm.startTime);
});
const recoveredRelative = computed<string>(() => {
  if (!props.alarm?.recoveryTime) return '';
  return formatRelative(props.alarm.recoveryTime);
});

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 0) return new Date(ts).toLocaleString();
  const s = Math.floor(delta / 1000);
  if (s < 60) return t('{n}s ago', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('{n}m ago', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('{h}h {m}m ago', { h, m: m % 60 });
  const d = Math.floor(h / 24);
  return t('{d}d {h}h ago', { d, h: h % 24 });
}

/** Metrics with at least one series of values, in wire order.
 *  Drives the one-snapshot-chart-per-metric render below. */
const snapshotMetrics = computed(() => {
  if (!props.alarm) return [];
  return props.alarm.snapshot.metrics.filter((m) => m.results.length > 0);
});

/** Rule's `period` (MINUTE buckets) when admin-server reported it,
 *  for the snapshot chart's window-band overlay. Null when admin is
 *  unreachable or the rule isn't matched. */
const rulePeriod = computed<number | null>(() => ruleDetail.value?.period ?? null);
</script>

<template>
  <aside class="ad" v-if="alarm">
    <!-- Headline: entity (scope prefix + OAP's pre-formatted name).
         OAP's `NotifyHandler` already joins relations + instance-
         of-service into the `name` field, so we just decorate with
         the scope-as-noun prefix. Status pill sits to the right. -->
    <header class="ad__head">
      <div class="ad__head-main">
        <div v-if="entityLabel?.prefix" class="ad__entity-kind">{{ entityLabel.prefix }}</div>
        <h2 class="ad__entity-name">
          <template v-for="(s, i) in entityLabel?.segments ?? []" :key="i">
            <template v-if="s.kind === 'group'">
              <span class="ad__entity-group">{{ s.group }}</span><span class="ad__entity-base">{{ s.base }}</span>
            </template>
            <span v-else>{{ s.text }}</span>
          </template>
        </h2>
      </div>
      <span class="sw-badge" :class="firing ? 'is-err' : 'is-ok'">
        <span class="state-dot" />{{ firing ? t('firing') : t('recovered') }}
      </span>
    </header>
    <div class="ad__sub">
      <span>{{ t('started {when}', { when: startedRelative }) }}</span>
      <template v-if="!firing"> · {{ t('recovered {when}', { when: recoveredRelative }) }}</template>
      <template v-if="alarm.layerKey"> · {{ alarm.layerKey }}</template>
    </div>

    <!-- 1. Message -->
    <section class="ad__sec">
      <div class="ad__kicker">{{ t('Message') }}</div>
      <p class="ad__rule">{{ alarm.message }}</p>
    </section>

    <!-- 2. Tags -->
    <section v-if="alarm.tags.length > 0" class="ad__sec">
      <div class="ad__kicker">{{ t('Tags') }}</div>
      <div class="ad__tags">
        <span v-for="tag in alarm.tags" :key="`${tag.key}=${tag.value}`" class="ad__tag">
          {{ tag.key }}={{ tag.value }}
        </span>
      </div>
    </section>

    <!-- 3. Expression -->
    <section class="ad__sec">
      <div class="ad__kicker">{{ t('Trigger expression') }}</div>
      <pre class="ad__expr">{{ alarm.snapshot.expression || t('— no MQE recorded —') }}</pre>
      <div v-if="snapshotBuckets > 0" class="ad__hint">
        {{ t('snapshot covers {n} × 1m buckets', { n: snapshotBuckets }) }}
        · {{ snapshotRangeLabel }}
      </div>
    </section>

    <!-- Rule body — lazy fetch via admin-server. Sits between the
         expression and the snapshot charts so the metadata
         (period / silence / hooks) contextualises the bucket count
         shown above and the per-metric chart shown below. Hidden when
         admin is unreachable or the message doesn't match a known
         rule. -->
    <section v-if="matchedRuleId" class="ad__sec">
      <div class="ad__kicker ad__kicker--with-link">
        <span>{{ t('Rule') }}</span>
        <RouterLink
          :to="{ path: '/operate/alerting-rules', query: { id: matchedRuleId } }"
          class="ad__rule-link"
        >{{ t('view in catalog →') }}</RouterLink>
      </div>
      <div v-if="ruleDetailQuery.isPending.value" class="ad__rule-loading">
        {{ t('loading rule…') }}
      </div>
      <div v-else-if="ruleDetailQuery.isError.value || !ruleDetail" class="ad__rule-loading">
        {{ t('rule definition unavailable') }}
      </div>
      <div v-else class="ad__rule-grid">
        <div class="ad__rule-cell"><span class="ad__rule-label">{{ t('id') }}</span><code>{{ ruleDetail.ruleId }}</code></div>
        <div class="ad__rule-cell"><span class="ad__rule-label">{{ t('period') }}</span>{{ ruleDetail.period }}m</div>
        <div class="ad__rule-cell"><span class="ad__rule-label">{{ t('silence') }}</span>{{ ruleDetail.silencePeriod }}m</div>
        <div class="ad__rule-cell">
          <span class="ad__rule-label">{{ t('recovery-obs') }}</span>{{ ruleDetail.recoveryObservationPeriod }}m
        </div>
        <div v-if="ruleDetail.hooks.length > 0" class="ad__rule-cell ad__rule-cell--wide">
          <span class="ad__rule-label">{{ t('Hooks') }}</span>
          <span v-for="h in ruleDetail.hooks" :key="h" class="ad__tag">{{ h }}</span>
        </div>
        <div v-if="ruleDetail.includeMetrics.length > 0" class="ad__rule-cell ad__rule-cell--wide">
          <span class="ad__rule-label">{{ t('Metrics') }}</span>
          <code v-for="m in ruleDetail.includeMetrics" :key="m">{{ m }}</code>
        </div>
      </div>
    </section>

    <!-- 4. Snapshots — per-metric chart of values captured at firing.
         X-axis is real time (reconstructed from the trigger minute
         + bucket count). Trigger time is marked with a vertical
         orange line; the rule's evaluation window is shaded when
         admin-server gave us the rule's `period`. -->
    <section v-for="m in snapshotMetrics" :key="m.name" class="ad__sec">
      <div class="ad__kicker">{{ m.name }}</div>
      <AlarmSnapshotChart
        :metric="m"
        :trigger-time="alarm.startTime"
        :recovery-time="alarm.recoveryTime"
        :rule-period="rulePeriod"
        :height="120"
      />
    </section>

    <section v-if="snapshotMetrics.length === 0" class="ad__sec ad__empty">
      {{ t('No MQE snapshot was recorded with this alarm. Upgrade OAP or enable the snapshot capture in the alarm rule to see the trigger values here.') }}
    </section>
  </aside>

  <aside v-else class="ad ad--empty">
    <div class="ad__placeholder">
      <div class="ad__placeholder-kicker">{{ t('No alarm selected') }}</div>
      <p>{{ t('Click a marker on the timeline or a row in the list to see its trigger details.') }}</p>
    </div>
  </aside>
</template>

<style scoped>
.ad {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  max-height: calc(100vh - 140px);
}
.ad--empty {
  align-items: center;
  justify-content: center;
}
.ad__placeholder {
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.ad__placeholder-kicker {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-2);
  margin-bottom: 6px;
}
.ad__placeholder p {
  max-width: 240px;
  margin: 0;
  line-height: 1.5;
}
.ad__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ad__head-main {
  flex: 1;
  min-width: 0;
}
.ad__entity-kind {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-accent);
  font-weight: 600;
  margin-bottom: 4px;
}
.ad__entity-name {
  font-family: var(--sw-mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--sw-fg-0);
  margin: 0;
  line-height: 1.4;
  word-break: break-all;
}
/* Probe-source classifier (`agent`, `mesh-svr`, `mesh-dp`, `mesh-cp`).
 * Just operational metadata — muted, not accent. Render as a quiet
 * grey tag adjacent to the service base name. */
.ad__entity-group {
  display: inline-block;
  font-family: var(--sw-mono);
  font-size: 10px;
  font-weight: 500;
  text-transform: lowercase;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  padding: 0 5px;
  border-radius: 3px;
  margin-right: 5px;
  vertical-align: 2px;
}
.ad__entity-base { /* default — inherits parent mono font */ }
.ad__rule {
  font-size: 13px;
  color: var(--sw-fg-0);
  margin: 0;
  line-height: 1.5;
}
.ad__sub {
  font-size: 11px;
  color: var(--sw-fg-3);
}
.ad__sec {
  border-top: 1px solid var(--sw-line);
  padding-top: 12px;
}
.ad__kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  margin-bottom: 6px;
}
.ad__expr {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  padding: 8px 10px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}
.ad__hint {
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.ad__kicker--with-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ad__rule-link {
  font-size: 10.5px;
  color: var(--sw-accent);
  text-decoration: none;
  text-transform: none;
  letter-spacing: 0;
}
.ad__rule-link:hover { text-decoration: underline; }
.ad__rule-loading {
  font-size: 11px;
  color: var(--sw-fg-3);
  font-style: italic;
}
.ad__rule-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.ad__rule-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--sw-fg-0);
  padding: 4px 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
}
.ad__rule-cell--wide { grid-column: 1 / -1; }
.ad__rule-label {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.ad__rule-cell code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-1);
  padding: 1px 5px;
  border-radius: 3px;
}
.ad__tag {
  font-size: 10.5px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--sw-line);
}
.ad__tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ad__empty {
  color: var(--sw-fg-3);
  font-size: 11.5px;
  line-height: 1.5;
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
.sw-badge.is-err {
  color: var(--sw-err);
  background: var(--sw-err-soft);
  border-color: rgba(239, 68, 68, 0.3);
}
</style>
