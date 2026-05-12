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

// Phase 2 will replace this static stub with real getMenuItems / listLayers
// data + per-layer overrides from the BFF dashboard-template bundle. The
// shape is what the sidebar and router will consume regardless.
//
// Aliases (`slots.*`) are a GLOBAL term presenter — the same alias is used
// in the sidebar, breadcrumbs, table headers, dashboard titles, drill-down
// labels, etc. "Endpoint" → "API" (General), "API → API" (the resulting
// endpoint-relation feature) → "API dependency".
//
// `caps` is a pickable feature set per layer. Setting `caps.services =
// false` hides the services slot entirely (e.g. a layer with only a single
// virtual service can disable `instances` and `endpoints` but keep
// `services`).
//
// Term aliases AND cap toggles are both editable from the Phase 7 admin UI
// (Layer config) and persisted in the BFF JSON store. The values below are
// the shipped defaults for each known layer.

export interface LayerSlots {
  /** Renamed service-equivalent (functions / workloads / clusters / apps / databases / virtual service / …). */
  services?: string;
  /** Renamed instance-equivalent (versions / pods / brokers / sessions / nodes / …). */
  instances?: string;
  /** Renamed endpoint-equivalent — e.g. "API" for General, "Topics" for MQ, "Pages" for Browser. */
  endpoints?: string;
  /** Label for the endpoint-to-endpoint dependency feature. Defaults to `${endpoints} dependency`. */
  endpointDependency?: string;
}

export interface LayerCaps {
  /** Per-layer landing page with KPIs / constellation / health. */
  overview?: boolean;
  /** Service map (service topology). */
  serviceMap?: boolean;
  /** Endpoint-to-endpoint dependency (a.k.a. "API dependency" when aliased). */
  endpointDependency?: boolean;
  /** Instance / pod / broker topology. */
  instanceTopology?: boolean;
  /** Process topology (eBPF / rover sourced). */
  processTopology?: boolean;
  /** Per-scope dashboards (Service / Instance / Endpoint / Glance). */
  dashboards?: boolean;
  /** Trace explorer (SkyWalking native or Zipkin sources). */
  traces?: boolean;
  /** Log explorer. */
  logs?: boolean;
  /** Any of the profiling subsystems (sampled / async-profiler / eBPF / pprof). */
  profiling?: boolean;
  /** Event timeline. */
  events?: boolean;
}

/** Convenience: `caps.serviceMap || caps.instanceTopology || caps.processTopology`. */
export function hasTopology(caps: LayerCaps): boolean {
  return Boolean(caps.serviceMap || caps.instanceTopology || caps.processTopology);
}

export interface LayerDef {
  key: string;
  name: string;
  /** CSS color (token var or hex). */
  color: string;
  /** Stub count — Phase 2 pulls the real number from listServices(layer). */
  serviceCount: number;
  slots: LayerSlots;
  caps: LayerCaps;
}

export const LAYERS: readonly LayerDef[] = [
  {
    key: 'general',
    name: 'General Service',
    color: 'var(--sw-accent)',
    serviceCount: 84,
    slots: { services: 'Services', instances: 'Instances', endpoints: 'API', endpointDependency: 'API dependency' },
    caps: {
      overview: true,
      serviceMap: true,
      endpointDependency: true,
      instanceTopology: true,
      processTopology: true,
      dashboards: true,
      traces: true,
      logs: true,
      profiling: true,
      events: true,
    },
  },
  {
    key: 'mesh',
    name: 'Service Mesh',
    color: 'var(--sw-info)',
    serviceCount: 22,
    slots: { services: 'Services', instances: 'Sidecars', endpoints: 'Endpoints' },
    caps: {
      overview: true,
      serviceMap: true,
      endpointDependency: true,
      instanceTopology: true,
      dashboards: true,
      traces: true,
      logs: true,
      events: true,
    },
  },
  {
    key: 'k8s',
    name: 'Kubernetes',
    color: 'var(--sw-purple)',
    serviceCount: 62,
    slots: { services: 'Workloads', instances: 'Pods' },
    caps: { overview: true, serviceMap: true, instanceTopology: true, dashboards: true, events: true },
  },
  {
    key: 'rum',
    name: 'Browser (RUM)',
    color: 'var(--sw-cyan)',
    serviceCount: 8,
    slots: { services: 'Applications', instances: 'Sessions', endpoints: 'Pages' },
    caps: { overview: true, dashboards: true, traces: true, logs: true },
  },
  {
    key: 'mq',
    name: 'Virtual MQ',
    color: 'var(--sw-ok)',
    serviceCount: 6,
    slots: { services: 'Clusters', instances: 'Brokers', endpoints: 'Topics' },
    caps: { overview: true, dashboards: true },
  },
  {
    key: 'db',
    name: 'Virtual Database',
    color: 'var(--sw-warn)',
    serviceCount: 6,
    slots: { services: 'Databases', instances: 'Nodes' },
    caps: { overview: true, dashboards: true },
  },
  {
    key: 'otel',
    name: 'OpenTelemetry',
    color: 'var(--sw-purple)',
    serviceCount: 18,
    slots: { services: 'Services', instances: 'Instances', endpoints: 'Endpoints' },
    caps: {
      overview: true,
      serviceMap: true,
      endpointDependency: true,
      dashboards: true,
      traces: true,
      logs: true,
    },
  },
  {
    key: 'faas',
    name: 'FaaS',
    color: 'var(--sw-err)',
    serviceCount: 3,
    slots: { services: 'Functions', instances: 'Versions', endpoints: 'Invocations' },
    caps: { overview: true, dashboards: true, traces: true },
  },
];

export function findLayer(key: string | undefined): LayerDef | undefined {
  if (!key) return undefined;
  return LAYERS.find((L) => L.key === key);
}
