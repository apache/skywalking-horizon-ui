/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Multi-entity compare engine for the layer dashboard: palette/hue
 * assignment (the banner entity keeps the reserved accent; pins draw from
 * the 6-hue palette), entity labels, the cohort-bar chips/header, and the
 * per-type compare builders (card / line / top-record / table) memoized per
 * widget id. Owns the palette → cohort sync watch (auto-torn-down with the
 * host component). The view stays a thin shell that renders these.
 */

import { computed, watch, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';
import { findWidgetById } from '@skywalking-horizon-ui/api-client';
import { fmtMetricAs, type MetricFormat } from '@/utils/formatters';
import { useEntityPalette } from '@/utils/useEntityPalette';
import { serviceBaseName, isBlankServiceName, BLANK_SERVICE_NAME } from '@/utils/serviceName';
import {
  type CompareScope,
  useLayerSelectionStore,
  compoundKey,
  splitCompound,
} from '@/state/layerSelection';
import type { useLayerDashboard } from '@/render/layer-dashboard/useLayerDashboard';

type DashboardApi = ReturnType<typeof useLayerDashboard>;

interface CardWidget {
  id: string;
  format?: MetricFormat;
  valueMap?: Record<string, string>;
}
export interface CohortChip {
  key: string;
  label: string;
  hue: string;
  primary: boolean;
  /** Per-entity fetch state — surfaces the isolated fan-out error/loading
   *  on the chip so a failed entity is visible (not silently blank). */
  state: 'loading' | 'ready' | 'error';
}
export interface CompareSeries {
  label: string;
  data: Array<number | null>;
  yAxisIndex?: number;
  unit?: string;
  color: string;
}
interface TopItem {
  name: string;
  value: number | null;
}
interface TopGroup {
  label: string;
  expression: string;
  items: TopItem[];
}

export function useCompareEngine(opts: {
  compareScope: ComputedRef<CompareScope | null>;
  compareEntities: DashboardApi['compareEntities'];
  scopePrimaryKey: ComputedRef<string | null>;
  selectedId: ComputedRef<string | null>;
  landingRows: ComputedRef<Array<{ serviceId: string; serviceName: string }>>;
  serviceRoster: ComputedRef<Array<{ id: string; name: string }>>;
  resultByEntity: DashboardApi['resultByEntity'];
  entityState: DashboardApi['entityState'];
  compareMode: ComputedRef<boolean>;
  compareLoading: ComputedRef<boolean>;
  activeSet: ComputedRef<string[]>;
  widgetsForQuery: ComputedRef<DashboardWidget[]>;
  widgets: ComputedRef<DashboardWidget[]>;
}) {
  const {
    compareScope,
    compareEntities,
    scopePrimaryKey,
    selectedId,
    landingRows,
    serviceRoster,
    resultByEntity,
    entityState,
    compareMode,
    activeSet,
    widgetsForQuery,
    widgets,
  } = opts;

  const { t } = useI18n({ useScope: 'global' });
  const selectionStore = useLayerSelectionStore();

  const palette = useEntityPalette();
  // The banner (primary) entity always renders in the reserved accent; only the
  // PINS draw from the 6-hue palette — so the palette never needs a 7th slot and
  // the "current" entity stays visually tied to the orange header KPIs.
  watch(
    compareEntities,
    (ids) => palette.syncToIds(ids.filter((id) => id !== scopePrimaryKey.value)),
    { immediate: true },
  );
  function compareHue(key: string): string {
    return key === scopePrimaryKey.value ? 'var(--sw-accent)' : palette.hueFor(key);
  }
  // Hue for an instance/endpoint ROW (raw name) under the current service —
  // the palette is keyed by the cross-service compound key.
  function rowHue(name: string): string {
    return compareHue(compoundKey(selectedId.value ?? '', name));
  }
  // Display label for an entity key, scope-aware: service ids resolve to a
  // base name from the roster; instance/endpoint names render as-is.
  function serviceLabelFor(id: string): string {
    // landing sample first (has metrics), then the FULL roster so a locked
    // low-traffic service beyond the top-N sample still resolves to a name.
    const name =
      landingRows.value.find((s) => s.serviceId === id)?.serviceName ??
      serviceRoster.value.find((s) => s.id === id)?.name ??
      id;
    return isBlankServiceName(name) ? BLANK_SERVICE_NAME : serviceBaseName(name);
  }
  function entityLabel(key: string): string {
    if (compareScope.value === 'service') return serviceLabelFor(key);
    // instance/endpoint: cross-service compound key → "<serviceBase> · <name>".
    const { service: svc, name } = splitCompound(key);
    return svc ? `${serviceLabelFor(svc)} · ${name}` : name;
  }
  function resultFor(widgetId: string, entityKey: string) {
    return resultByEntity.value.get(entityKey)?.get(widgetId);
  }
  // Table widgets compare per-entity: gather each entity's rows tagged
  // with its key (Option B puts no entityKey on the wire) for TableWidget.
  const compareTableEntities = computed(() =>
    compareEntities.value.map((e) => ({ key: e, name: entityLabel(e), hue: compareHue(e) })),
  );
  function buildTableRows(widgetId: string) {
    return compareEntities.value.flatMap((e) =>
      (resultFor(widgetId, e)?.table ?? []).map((r) => ({ ...r, entityKey: e })),
    );
  }
  const compareTableByWidget = computed(() => {
    const m = new Map<string, ReturnType<typeof buildTableRows>>();
    if (compareMode.value) {
      for (const w of widgetsForQuery.value) if (w.type === 'table') m.set(w.id, buildTableRows(w.id));
    }
    return m;
  });
  function compareTableRows(widgetId: string): ReturnType<typeof buildTableRows> {
    return compareTableByWidget.value.get(widgetId) ?? [];
  }

  // --- Unified compare cohort bar (scope-aware) ---------------------------
  // The persistent working-set surface, decoupled from the (service-
  // dependent, paginated) selection list. Shows the comparison set = the
  // locked set; the list pins are the ADD affordance. All three scopes
  // differ in key/label/primary/unlock, handled below. (`scopePrimaryKey`
  // is defined above the dashboard call so the fan-out can dedupe with it.)
  const cohortChips = computed<CohortChip[]>(() =>
    compareEntities.value.map((key) => ({
      key,
      label: entityLabel(key),
      hue: compareHue(key),
      primary: key === scopePrimaryKey.value,
      state: entityState(key),
    })),
  );
  // Distinct services represented in the locked instance/endpoint cohort.
  // A cross-service cohort (size > 1) can't be summarised as "of {service}".
  const cohortServices = computed<string[]>(() => {
    const set = new Set<string>();
    for (const key of compareEntities.value) set.add(splitCompound(key).service);
    return [...set];
  });
  // Show the cohort bar from the FIRST lock (so a single lock is visible
  // regardless of list churn); the grid itself still needs >=2.
  const cohortVisible = computed(() => activeSet.value.length >= 1);
  const cohortHeader = computed<string>(() => {
    const n = compareEntities.value.length;
    if (n < 2) return t('{n} locked · lock 1 more to compare', { n });
    if (compareScope.value === 'service') return t('Comparing {n} services', { n });
    // instance/endpoint: name the service only when the whole cohort shares
    // one; a mixed-service cohort says "across services" (chips carry the
    // per-entity service prefix).
    const svcs = cohortServices.value;
    const single = svcs.length === 1 ? serviceLabelFor(svcs[0]) : null;
    if (compareScope.value === 'instance') {
      return single
        ? t('Comparing {n} instances of {service}', { n, service: single })
        : t('Comparing {n} instances across services', { n });
    }
    return single
      ? t('Comparing {n} endpoints of {service}', { n, service: single })
      : t('Comparing {n} endpoints across services', { n });
  });
  // Cohort chips are display-only: a pin is a comparison member, NOT a
  // banner control. Clicking a chip must NOT refocus the banner (that would
  // re-query the primary + reload the instance/endpoint list — the disruptive
  // "refresh" we explicitly avoid). The banner changes only through the top
  // selector / list rows; chips offer just the × (unpin), and the CURRENT chip
  // (the banner entity) isn't removable.
  function unlockChip(key: string): void {
    // Remove the EXACT key (compound for instance/endpoint) — it may
    // belong to a service other than the current primary.
    if (compareScope.value) selectionStore.removeKey(compareScope.value, key);
  }
  // Exit compare: drop every lock for the scope (incl. the non-removable CURRENT
  // chip) → the bar hides and the page returns to the single-entity view.
  function clearCohort(): void {
    if (compareScope.value) selectionStore.clearLocks(compareScope.value);
  }

  // --- Multi-entity INLINE rendering -------------------------------------
  // In compare mode every widget keeps its normal tile and renders all N
  // entities inside it: card -> one row per entity, line -> N overlaid
  // (entity-hued) lines, top/record -> per-entity tabs + a merged "All".
  function cardValueFor(wid: string, e: string): number | null {
    return resultFor(wid, e)?.value ?? null;
  }
  function cardTextFor(w: CardWidget, e: string): string {
    const v = cardValueFor(w.id, e);
    if (v != null && w.format === 'enum' && w.valueMap) {
      const lbl = w.valueMap[String(Math.round(v))];
      if (lbl != null) return lbl;
    }
    return fmtMetricAs(v, w.format);
  }
  function buildLineSeries(wid: string): CompareSeries[] {
    const out: CompareSeries[] = [];
    for (const e of compareEntities.value) {
      const series = resultFor(wid, e)?.series ?? [];
      const multi = series.length > 1;
      for (const s of series) {
        out.push({
          // Label FIRST, then entity: the per-series tag must survive truncation;
          // a long entity name can ellipsize.
          label: multi ? `${s.label} · ${entityLabel(e)}` : entityLabel(e),
          data: s.data,
          ...(s.yAxisIndex !== undefined ? { yAxisIndex: s.yAxisIndex } : {}),
          ...(s.unit ? { unit: s.unit } : {}),
          color: compareHue(e),
        });
      }
    }
    return out;
  }
  // Memoize the compare render data per widget: the template calls these in both
  // the v-if and the bind, and a fresh array each render makes TimeChart's deep
  // series watch re-push to ECharts every tick. Recomputes only on data changes.
  const compareLineByWidget = computed<Map<string, CompareSeries[]>>(() => {
    const m = new Map<string, CompareSeries[]>();
    if (compareMode.value) {
      for (const w of widgetsForQuery.value) if (w.type === 'line') m.set(w.id, buildLineSeries(w.id));
    }
    return m;
  });
  function multiLineSeries(wid: string): CompareSeries[] {
    return compareLineByWidget.value.get(wid) ?? [];
  }
  function lineLen(wid: string): number {
    return multiLineSeries(wid)[0]?.data.length ?? 0;
  }
  function topItemsFor(wid: string, e: string): TopItem[] {
    const r = resultFor(wid, e);
    if (!r) return [];
    if (r.topList) return r.topList;
    if (r.topGroups && r.topGroups[0]) return r.topGroups[0].items;
    if (r.records) return r.records.map((x) => ({ name: x.name, value: x.value ?? null }));
    return [];
  }
  // "All" merges every entity's rows and re-sorts in the widget's OWN MQE
  // direction (`topNOrder`, resolved BFF-side — inferring asc/des from one probe
  // entity flips when its values are flat); per-entity groups keep native order.
  function buildTopGroups(wid: string): TopGroup[] {
    const ents = compareEntities.value;
    // Whole-tree lookup — a top/record widget (carrying topNOrder) can live in a tab.
    const desc = findWidgetById(widgets.value, wid)?.topNOrder !== 'asc';
    const all: TopItem[] = ents.flatMap((e) =>
      topItemsFor(wid, e).map((it) => ({ name: `${entityLabel(e)} · ${it.name}`, value: it.value })),
    );
    all.sort((a, b) => {
      const av = a.value ?? (desc ? -Infinity : Infinity);
      const bv = b.value ?? (desc ? -Infinity : Infinity);
      return desc ? bv - av : av - bv;
    });
    const groups: TopGroup[] = [{ label: t('All'), expression: '', items: all }];
    for (const e of ents) groups.push({ label: entityLabel(e), expression: '', items: topItemsFor(wid, e) });
    return groups;
  }
  const compareTopByWidget = computed<Map<string, TopGroup[]>>(() => {
    const m = new Map<string, TopGroup[]>();
    if (compareMode.value) {
      for (const w of widgetsForQuery.value) {
        if (w.type === 'top' || w.type === 'record') m.set(w.id, buildTopGroups(w.id));
      }
    }
    return m;
  });
  function multiTopGroups(wid: string): TopGroup[] {
    return compareTopByWidget.value.get(wid) ?? [];
  }
  function hasMultiTopData(wid: string): boolean {
    return (multiTopGroups(wid)[0]?.items.length ?? 0) > 0;
  }

  return {
    compareHue,
    rowHue,
    serviceLabelFor,
    entityLabel,
    compareTableEntities,
    compareTableRows,
    cohortChips,
    cohortVisible,
    cohortHeader,
    unlockChip,
    clearCohort,
    cardValueFor,
    cardTextFor,
    multiLineSeries,
    lineLen,
    multiTopGroups,
    hasMultiTopData,
  };
}
