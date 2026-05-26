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
  Active-alarms rail for overview dashboards. Polls `/api/alarms` over
  the last 60 minutes and shows the top N rows + the total.

  Dual-mode (driven by `useOapInfo().capabilities.queryAlarms`):
   - **New API (`queryAlarms` available)** — narrows to the dashboard's
     layer via the new entities/layers filter. The widget shows alarms
     scoped to that layer.
   - **Legacy API (`getAlarm` only)** — no server-side layer filter
     exists. We fetch all-layers and surface a small "all layers"
     banner so the operator understands why the rail isn't matching
     the dashboard's layer.

  Read-only by design. Click "view all" to jump to /alarms for triage.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import Icon from '@/components/icons/Icon.vue';
import WidgetTip from '@/components/primitives/WidgetTip.vue';
import {
  bff,
  OVERVIEW_ALARMS_LIMIT_DEFAULT,
  type AlarmMessage,
  type AlarmsConfig,
} from '@/api/client';
import { useOapInfo } from '@/shell/useOapInfo';
import { formatAlarmEntity } from '@/utils/alarmEntity';
import { mergeIncidents, type AlarmIncident } from '@/utils/alarmIncidents';

const { t } = useI18n({ useScope: 'global' });

const props = withDefaults(
  defineProps<{
    title: string;
    tip?: string;
    /** Top-N cap; defaults to 10. The BFF still fetches up to 500 so
     *  the "total" count is meaningful even when only N rows render. */
    limit?: number;
    /** Overview's layer (`GENERAL`, `MESH`, …). Used only in
     *  new-API mode for server-side filtering; ignored in legacy. */
    layer?: string;
  }>(),
  { limit: 10 },
);

// Fallback window when the admin config hasn't loaded yet — matches
// the alert page-setup bundled default so the first paint reads the
// same window as the admin's saved value once it lands.
const FALLBACK_WINDOW_MS = 20 * 60_000;

const { capabilities } = useOapInfo();
const hasQueryAlarms = computed<boolean>(() => capabilities.value.queryAlarms);

/* Shares the queryKey `['alarms/config']` with the page + admin
 * view so the per-poll fetch cap (`overviewAlarmsLimit`) AND the
 * window (`defaultWindowMs`) stay in sync without a separate
 * roundtrip. Previously this widget hardcoded a 60-minute window,
 * which contradicted the alarms page + topbar badge using the
 * admin's `defaultWindowMs` (default 20m). Unified now: all three
 * surfaces query the same window per the operator-configured value
 * in `/admin/alert-page-setup`. */
const cfgQuery = useQuery({
  queryKey: ['alarms/config'],
  queryFn: (): Promise<AlarmsConfig> => bff.alarms.config(),
  staleTime: Infinity,
});
const fetchLimit = computed<number>(
  () => cfgQuery.data.value?.overviewAlarmsLimit ?? OVERVIEW_ALARMS_LIMIT_DEFAULT,
);
const windowMs = computed<number>(
  () => cfgQuery.data.value?.defaultWindowMs ?? FALLBACK_WINDOW_MS,
);

/** Compact human label for the resolved window — surfaced in the
 *  widget title so operators can tell "no alarms in the last 10m"
 *  apart from "no alarms in the last hour". Sub-minute / sub-hour
 *  numbers stay round (we never ship odd values like 13m). */
const windowLabel = computed<string>(() => {
  const ms = windowMs.value;
  const min = Math.round(ms / 60_000);
  if (min < 60) return t('last {n}m', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('last {n}h', { n: h });
  return t('last {n}d', { n: Math.round(h / 24) });
});

const alarmsQuery = useQuery({
  /* Layer is keyed only in new-API mode — legacy mode ignores it
   * and re-uses a single all-layers cache across every overview.
   * `fetchLimit` is in the key so a config change re-fetches with
   * the new cap on the next render tick. */
  queryKey: computed(() => [
    'overview-alarms',
    hasQueryAlarms.value,
    hasQueryAlarms.value ? props.layer ?? '' : 'all',
    fetchLimit.value,
    windowMs.value,
  ]),
  queryFn: () => {
    const end = Date.now();
    const start = end - windowMs.value;
    return bff.alarms.list({
      startTime: start,
      endTime: end,
      layer: hasQueryAlarms.value && props.layer ? props.layer : undefined,
      pageSize: fetchLimit.value,
    });
  },
  staleTime: 30_000,
  refetchInterval: 60_000,
  refetchOnWindowFocus: false,
});

const alarms = computed<AlarmMessage[]>(() => alarmsQuery.data.value?.msgs ?? []);
const truncated = computed<boolean>(() => alarmsQuery.data.value?.truncated ?? false);

/* In legacy mode the BFF can't server-side-filter by layer, but every
 * row already carries `layerKey` (resolved against the server-global
 * service-layer catalog). Filter client-side so the widget shows only
 * the layer the dashboard is scoped to — same observable behavior as
 * the new-API path. Rows whose `layerKey` couldn't be resolved
 * (unknown service prefix, instance/endpoint scopes) drop out
 * silently; an unresolved row can't be confidently attributed to
 * any layer, so showing it on a per-layer dashboard would mislead. */
const layerScoped = computed<AlarmMessage[]>(() => {
  if (hasQueryAlarms.value || !props.layer) return alarms.value;
  const wanted = props.layer.toUpperCase();
  return alarms.value.filter((a) => (a.layerKey ?? '').toUpperCase() === wanted);
});

/* Counts use `mergeIncidents` (group by (entity, rule); active iff
 * any latest-event is firing) so the header reads the same metric
 * as the topbar badge + page totals — one count per noisy rule, not
 * one per re-fire. */
const incidents = computed<AlarmIncident[]>(() => mergeIncidents(layerScoped.value));
const activeIncidents = computed<number>(
  () => incidents.value.filter((i) => i.state === 'firing').length,
);

/* Rail rows = active incidents only, one per (entity, rule), top
 * `limit` by recency. The page list expands each firing into its
 * own row for triage; the rail intentionally stays compact — a
 * noisy rule that fired 4× shows as one row with a `· 4×` chip, not
 * four. Recovered-only incidents don't appear here at all (they
 * don't count and they push down active ones). The full triage view
 * is one click away via "View all". */
const rows = computed<AlarmIncident[]>(() =>
  incidents.value.filter((i) => i.state === 'firing').slice(0, props.limit),
);

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 0) return new Date(ts).toLocaleString();
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 > 0 ? ` ${m % 60}m` : ''}`;
}

function entityShort(a: AlarmMessage): string {
  const l = formatAlarmEntity(a.scope, a.name);
  /* Drop group prefixes (e.g. `mesh-svr::`) from the rail since the
   * rail is tight. The detail panel keeps them. */
  return l.segments
    .map((s) => (s.kind === 'group' ? s.base : s.text))
    .join('');
}

function incidentEntity(i: AlarmIncident): string {
  return entityShort(i.latest);
}
</script>

<template>
  <section class="sw-card alarms-widget">
    <header>
      <!-- Two rows. Row 1 carries the identity (title + tip) and the
           View-all link. Row 2 carries the secondary metadata — window
           + active count — so the title isn't crushed by it on narrow
           widgets. An empty rail isn't mistaken for "no alarms"
           overall because the operator still sees the window slice on
           row 2. -->
      <div class="aw-row-top">
        <h4>{{ title }}</h4>
        <WidgetTip :tip="tip" />
        <RouterLink class="all-link" to="/alarms">
          <span>{{ t('View all') }}</span>
          <Icon name="chev" :size="10" />
        </RouterLink>
      </div>
      <div class="aw-row-meta">
        <span class="window-tag">· {{ windowLabel }}</span>
        <span class="total mono" :class="{ active: activeIncidents > 0 }">
          {{ activeIncidents }}{{ truncated ? '+' : '' }} {{ t('active') }}
        </span>
      </div>
    </header>

    <div class="body">
      <div v-if="alarmsQuery.isPending.value" class="empty">{{ t('loading…') }}</div>
      <div v-else-if="rows.length === 0" class="empty">
        {{ layer ? t('No alarms in the {window} for {layer}.', { window: windowLabel, layer }) : t('No alarms in the {window}.', { window: windowLabel }) }}
      </div>
      <div v-else class="rows">
        <div
          v-for="inc in rows"
          :key="inc.id"
          class="alarm-row"
          :class="{ resolved: inc.state === 'recovered' }"
        >
          <span class="sev-dot" :class="inc.state === 'firing' ? 'is-err' : 'is-ok'" />
          <div class="alarm-text">
            <div class="rule">{{ inc.latest.message }}</div>
            <div class="scope">{{ incidentEntity(inc) }}</div>
          </div>
          <span class="since mono">{{ formatRelative(inc.latest.startTime) }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.alarms-widget { display: flex; flex-direction: column; min-height: 0; height: 100%; }
header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--sw-line);
  min-width: 0;
}
.aw-row-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.aw-row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--sw-fg-3);
}
h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
/* Smaller, muted window suffix so the title still reads as the
 * widget name (matches the dense topbar/picker vocabulary). */
.window-tag { font-size: 11px; font-weight: 400; color: var(--sw-fg-3); white-space: nowrap; flex: 0 0 auto; }
.total {
  font-size: 11px;
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
}
.total.active { color: var(--sw-err); font-weight: 600; }
.all-link {
  margin-left: auto; font-size: 11px; color: var(--sw-fg-2);
  text-decoration: none; display: inline-flex; align-items: center; gap: 4px;
}
.all-link:hover { color: var(--sw-accent-2); }
.body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; flex: 1; overflow: hidden; }
.empty {
  padding: 16px;
  text-align: center;
  font-size: 11px;
  color: var(--sw-fg-3);
}
.rows { display: flex; flex-direction: column; gap: 4px; overflow: auto; }
.alarm-row {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 0;
  border-top: 1px solid var(--sw-line); font-size: 11px;
}
.alarm-row.resolved { opacity: 0.6; }
.alarm-row:first-child { border-top: none; }
.sev-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
}
.sev-dot.is-err { background: var(--sw-err); }
.sev-dot.is-ok { background: var(--sw-ok); }
.alarm-text { flex: 1; min-width: 0; }
.alarm-text .rule {
  color: var(--sw-fg-1); font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.alarm-text .scope {
  font-family: var(--sw-mono); color: var(--sw-fg-3); font-size: 10px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.since { color: var(--sw-fg-3); font-size: 10px; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
</style>
