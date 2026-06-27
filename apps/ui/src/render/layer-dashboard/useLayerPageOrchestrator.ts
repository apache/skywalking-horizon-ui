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
 * Page-init state machine for the layer dashboard view. Drives the
 * EventTicker with a strict ordered sequence — each phase only emits
 * once the prior phase has reported ready — instead of the noisy
 * "every vue-query fire emits an event" pattern that surfaced as a
 * scrambled timeline whenever queries raced.
 *
 * Phases (one event each, in this order):
 *   1. config       — dashboard widget set resolved (from preloaded
 *                     bundle or BFF fallback).
 *   2. services     — service list loaded (or service auto-picked
 *                     from the existing URL pick).
 *   3. service      — effective service is resolved + visible to the
 *                     widgets that need it.
 *   4. instances    — only fires when scope === 'instance'.
 *   5. instance     — effective instance is resolved.
 *   6. endpoints    — only fires when scope === 'endpoint'.
 *   7. endpoint     — effective endpoint is resolved.
 *   8. dashboard    — widget MQE batch returned, widgets rendered.
 *
 * The orchestrator doesn't replace the existing vue-query
 * composables — those still own the actual fetching. It watches
 * their reactive state and gates the next phase's event on the
 * prior phase being marked done, so the EventTicker always reads
 * top-to-bottom in dependency order regardless of which network
 * call physically returns first.
 *
 * Per-route reset: the orchestrator re-arms whenever the
 * (layerKey, scope) pair changes so a sidebar click produces a
 * fresh top-to-bottom sequence instead of accumulating phases from
 * a prior page.
 */

import { reactive, ref, watch, type Ref } from 'vue';
import { pushEvent } from '@/controls/eventLog';

export interface OrchestratorRefs {
  layerKey: Ref<string>;
  scope: Ref<string>;
  /** Dashboard widget config (preload bundle or network). */
  config: Ref<{ widgets?: unknown[] } | null>;
  /** Landing rows — the service list. */
  serviceList: Ref<ReadonlyArray<{ serviceId: string; serviceName: string }>>;
  /** Currently-effective service name (URL pick or auto-pick). */
  effectiveService: Ref<string | null>;
  /** Instance list for the current service. Only consulted when
   *  scope === 'instance'. */
  instanceList: Ref<ReadonlyArray<{ id: string; name: string }>>;
  /** Currently-effective instance pick (URL or auto). */
  effectiveInstance: Ref<string | null>;
  /** Endpoint list — only consulted when scope === 'endpoint'. */
  endpointList: Ref<ReadonlyArray<{ id: string; name: string }>>;
  effectiveEndpoint: Ref<string | null>;
  /** Dashboard response — widgets rendered. */
  dashboard: Ref<{
    widgets?: Array<{
      id: string;
      error?: string;
      value?: unknown;
      series?: unknown[];
      topList?: unknown[];
      topGroups?: unknown[];
    }>;
  } | null>;
}

type Phase =
  | 'config'
  | 'services'
  | 'service'
  | 'instances'
  | 'instance'
  | 'endpoints'
  | 'endpoint'
  | 'dashboard';

interface PhaseStamps {
  config: boolean;
  services: boolean;
  service: boolean;
  instances: boolean;
  instance: boolean;
  endpoints: boolean;
  endpoint: boolean;
  dashboard: boolean;
}
function freshStamps(): PhaseStamps {
  return {
    config: false,
    services: false,
    service: false,
    instances: false,
    instance: false,
    endpoints: false,
    endpoint: false,
    dashboard: false,
  };
}

/**
 * Returns a flag that mirrors whether the orchestrator has reached
 * the final 'dashboard' phase — view code can use it to gate optional
 * spinners or skip-skeleton paints if it wants to.
 */
export function useLayerPageOrchestrator(refs: OrchestratorRefs): {
  done: Ref<boolean>;
} {
  const stamps = reactive(freshStamps());
  const done = ref(false);
  // The cascade. Each step emits exactly once per (layerKey, scope)
  // arming, only after the prior step is `true`.

  function report(phase: Phase, text: string): void {
    pushEvent(`init/${phase}`, 'ok', text);
  }

  // 1. config
  watch(
    () => refs.config.value,
    (c) => {
      if (!c || stamps.config) return;
      const n = c.widgets?.length ?? 0;
      report('config', `Step 1 · config ready · ${n} widget${n === 1 ? '' : 's'}`);
      stamps.config = true;
    },
    { immediate: true },
  );

  // 2. services (after config)
  watch(
    [() => stamps.config, () => refs.serviceList.value.length],
    ([configDone, count]) => {
      if (!configDone || stamps.services) return;
      if (count === 0) return;
      report('services', `Step 2 · services ready · ${count} service${count === 1 ? '' : 's'}`);
      stamps.services = true;
    },
    { immediate: true },
  );

  // 3. service resolved (after services)
  watch(
    [() => stamps.services, () => refs.effectiveService.value],
    ([servicesDone, svc]) => {
      if (!servicesDone || stamps.service) return;
      if (!svc) return;
      report('service', `Step 3 · service: ${svc}`);
      stamps.service = true;
    },
    { immediate: true },
  );

  // 4a. instances (after service, scope=instance only)
  watch(
    [
      () => stamps.service,
      () => refs.scope.value,
      () => refs.instanceList.value.length,
    ],
    ([serviceDone, scope, count]) => {
      if (scope !== 'instance') return;
      if (!serviceDone || stamps.instances) return;
      if (count === 0) return;
      report('instances', `Step 4 · instances ready · ${count} instance${count === 1 ? '' : 's'}`);
      stamps.instances = true;
    },
    { immediate: true },
  );

  // 5a. instance resolved (after instances)
  watch(
    [() => stamps.instances, () => refs.effectiveInstance.value, () => refs.scope.value],
    ([instancesDone, inst, scope]) => {
      if (scope !== 'instance') return;
      if (!instancesDone || stamps.instance) return;
      if (!inst) return;
      report('instance', `Step 5 · instance: ${inst}`);
      stamps.instance = true;
    },
    { immediate: true },
  );

  // 4b. endpoints (after service, scope=endpoint only)
  watch(
    [
      () => stamps.service,
      () => refs.scope.value,
      () => refs.endpointList.value.length,
    ],
    ([serviceDone, scope, count]) => {
      if (scope !== 'endpoint') return;
      if (!serviceDone || stamps.endpoints) return;
      if (count === 0) return;
      report('endpoints', `Step 4 · endpoints ready · ${count} endpoint${count === 1 ? '' : 's'}`);
      stamps.endpoints = true;
    },
    { immediate: true },
  );

  // 5b. endpoint resolved
  watch(
    [() => stamps.endpoints, () => refs.effectiveEndpoint.value, () => refs.scope.value],
    ([endpointsDone, ep, scope]) => {
      if (scope !== 'endpoint') return;
      if (!endpointsDone || stamps.endpoint) return;
      if (!ep) return;
      report('endpoint', `Step 5 · endpoint: ${ep}`);
      stamps.endpoint = true;
    },
    { immediate: true },
  );

  // 6. dashboard (after the deepest prereq for the scope)
  watch(
    [() => refs.scope.value, () => refs.dashboard.value, () => ({ ...stamps })],
    ([scope, d, st]) => {
      if (!d || stamps.dashboard) return;
      // Gate by the deepest required stamp for the active scope.
      if (scope === 'instance' && !st.instance) return;
      if (scope === 'endpoint' && !st.endpoint) return;
      if (scope === 'service' && !st.service) return;
      const widgets = d.widgets ?? [];
      const total = widgets.length;
      const withData = widgets.filter(
        (w) =>
          !w.error &&
          (w.value != null ||
            (Array.isArray(w.series) && w.series.length > 0) ||
            (Array.isArray(w.topList) && w.topList.length > 0) ||
            (Array.isArray(w.topGroups) && w.topGroups.length > 0)),
      ).length;
      report('dashboard', `Step 6 · widgets rendered · ${withData}/${total} with data`);
      stamps.dashboard = true;
      done.value = true;

      // After the batch dashboard returns, emit a per-widget event
      // for every result so the EventTicker shows which widget got
      // data, which came back empty, and which errored. The dashboard
      // query is batched server-side (one GraphQL trip for all MQEs)
      // so these are post-hoc info events, not separate fetches —
      // they let the operator pinpoint a specific widget's status
      // without staring at the rendered grid.
      const cfgWidgets = (refs.config.value?.widgets ?? []) as Array<{ id?: string; title?: string }>;
      const titleById = new Map<string, string>();
      for (const cw of cfgWidgets) {
        if (cw?.id) titleById.set(cw.id, cw.title ?? cw.id);
      }
      for (const r of widgets) {
        const label = titleById.get(r.id) ?? r.id;
        let kind: 'ok' | 'err' | 'info' = 'info';
        let detail = 'no data';
        // The BFF uses `error: "no data"` as a non-fatal sentinel
        // when a widget's MQE returned nothing (metric not reporting
        // for this entity right now). Treat that as `info`, not
        // `err`, so the ticker doesn't light up red for ordinary
        // empty cells. Real backend errors keep the ✕ kind.
        if (r.error && r.error !== 'no data') {
          kind = 'err';
          detail = `error: ${r.error}`;
        } else if (r.value != null) {
          kind = 'ok';
          detail = `value ${r.value}`;
        } else if (Array.isArray(r.series) && r.series.length > 0) {
          kind = 'ok';
          detail = `${r.series.length} series`;
        } else if (Array.isArray(r.topList) && r.topList.length > 0) {
          kind = 'ok';
          detail = `top ${r.topList.length}`;
        } else if (Array.isArray(r.topGroups) && r.topGroups.length > 0) {
          kind = 'ok';
          detail = `${r.topGroups.length} group${r.topGroups.length === 1 ? '' : 's'}`;
        }
        pushEvent(`widget/${r.id}`, kind, `Widget ${label} · ${detail}`);
      }
    },
    { immediate: true },
  );

  // Re-arm scoped to what actually changed. Layer/scope = whole
  // chain. Service change = step 3 onwards (config + services list
  // stay valid). Instance/endpoint pick = step 5 + dashboard. This
  // keeps the EventTicker showing the cascade for each new
  // selection without spamming a fresh "config / services" pair
  // for every picker click.
  watch(
    [() => refs.layerKey.value, () => refs.scope.value],
    (_now, before) => {
      if (before === undefined) return;
      Object.assign(stamps, freshStamps());
      done.value = false;
    },
  );
  watch(
    () => refs.effectiveService.value,
    (_now, before) => {
      if (before === undefined) return;
      stamps.service = false;
      stamps.instances = false;
      stamps.instance = false;
      stamps.endpoints = false;
      stamps.endpoint = false;
      stamps.dashboard = false;
      done.value = false;
    },
  );
  watch(
    () => refs.effectiveInstance.value,
    (_now, before) => {
      if (before === undefined) return;
      stamps.instance = false;
      stamps.dashboard = false;
      done.value = false;
    },
  );
  watch(
    () => refs.effectiveEndpoint.value,
    (_now, before) => {
      if (before === undefined) return;
      stamps.endpoint = false;
      stamps.dashboard = false;
      done.value = false;
    },
  );

  return { done };
}
