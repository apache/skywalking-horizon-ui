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

import type {
  DashboardConfig,
  DashboardResponse,
  DashboardWidget,
  EndpointDependencyResponse,
  InstanceTopologyResponse,
  LandingConfig,
  LandingResponse,
  ServiceHierarchyResponse,
  DeploymentResponse,
  TopologyResponse,
} from '@skywalking-horizon-ui/api-client';
import { pushEvent } from '@/controls/eventLog';
import { serviceRefFields, type ServiceRef } from '@/utils/serviceRef';
import type { BffClient } from '../client';

/** BFF cap on widgets per `/api/layer/:key/dashboard` body. Mirrors
 *  the zod `widgetSchema.max(40)` in `apps/bff/src/http/query/dashboard.ts`
 *  — kept here as a single source of truth for the chunking logic in
 *  `dashboard()` below. Bumping this requires bumping the BFF zod cap
 *  too. The cap exists to protect OAP's storage page-size cliffs, not
 *  to enforce a UI limit, so the UI splits oversized requests rather
 *  than refusing them. */
export const DASHBOARD_WIDGETS_PER_REQUEST = 40;

/** `bff.layer` — per-layer data: landing top-N, dashboard widgets,
 *  endpoint / instance pickers, topology, endpoint dependency. */
export class LayerApi {
  constructor(private readonly bff: BffClient) {}

  landing(
    layerKey: string,
    cfg: LandingConfig,
    range?: { step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number },
  ): Promise<LandingResponse> {
    const body: Record<string, unknown> = {
      topN: cfg.topN,
      orderBy: cfg.orderBy,
      columns: cfg.columns,
    };
    if (range) {
      body.step = range.step;
      body.startMs = range.startMs;
      body.endMs = range.endMs;
    }
    return this.bff.request<LandingResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/landing`,
      body,
    );
  }

  /** `page` selects one of the component's extension pages; omitted means
   *  its default grid. An id the layer doesn't declare comes back 404 — it
   *  is never quietly answered with the default. */
  dashboardConfig(layerKey: string, scope?: string, page?: string): Promise<DashboardConfig> {
    const params = new URLSearchParams();
    if (scope) params.set('scope', scope);
    if (page) params.set('page', page);
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    return this.bff.request<DashboardConfig>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/dashboard/config${qs}`,
    );
  }

  async dashboard(
    layerKey: string,
    body: {
      service?: string;
      /** Which page of `scope` the widgets came from. Absent on the
       *  component's default grid. */
      page?: string;
      /** Active instance — only honored when `scope === 'instance'`. */
      serviceInstance?: string;
      /** Active endpoint — only honored when `scope === 'endpoint'`. */
      endpoint?: string;
      widgets?: DashboardWidget[];
      scope?: string;
      step?: 'MINUTE' | 'HOUR' | 'DAY';
      /** Range start ms. Paired with `endMs` + `step`. */
      startMs?: number;
      /** Range end ms. */
      endMs?: number;
    } = {},
    /** Dev-mode `?mockTop=N` — pad every TopList result to N synthetic rows. */
    opts: { mockTop?: number } = {},
  ): Promise<DashboardResponse> {
    const qs = opts.mockTop && opts.mockTop > 0 ? `?mockTop=${opts.mockTop}` : '';
    const path = `/api/layer/${encodeURIComponent(layerKey)}/dashboard${qs}`;
    const widgets = body.widgets ?? [];

    // Fast path: a single request is enough.
    if (widgets.length <= DASHBOARD_WIDGETS_PER_REQUEST) {
      return this.bff.request<DashboardResponse>('POST', path, body);
    }

    // Slow path: oversize widget set. The BFF rejects bodies with more
    // than `DASHBOARD_WIDGETS_PER_REQUEST` widgets (protects OAP's
    // storage page-size cliffs); the UI chunks instead of refusing.
    // We fire chunks in parallel because each chunk hits a different
    // subset of OAP metrics — there's no in-OAP locking that benefits
    // from serial dispatch.
    const chunks: DashboardWidget[][] = [];
    for (let i = 0; i < widgets.length; i += DASHBOARD_WIDGETS_PER_REQUEST) {
      chunks.push(widgets.slice(i, i + DASHBOARD_WIDGETS_PER_REQUEST));
    }
    pushEvent(
      'api',
      'info',
      `${path} · ${widgets.length} widgets → ${chunks.length} chunks of ≤${DASHBOARD_WIDGETS_PER_REQUEST}`,
    );

    const responses = await Promise.all(
      chunks.map((chunk) =>
        this.bff.request<DashboardResponse>('POST', path, { ...body, widgets: chunk }),
      ),
    );

    // Merge: concatenate `widgets` in original order, AND-fold
    // `reachable`, surface the first non-empty `error`. All other
    // top-level fields are deterministic for the same body shape so
    // we pick the first response's values.
    const first = responses[0]!;
    return {
      ...first,
      widgets: responses.flatMap((r) => r.widgets),
      reachable: responses.every((r) => r.reachable),
      error: responses.find((r) => r.error)?.error,
    };
  }

  /** Endpoint search for one service, scoped by the {@link ServiceRef} pair the
   *  caller picked. */
  endpoints(
    layerKey: string,
    service: ServiceRef,
    query: string,
    limit = 20,
  ): Promise<{
    layer: string;
    service: string;
    query: string;
    limit: number;
    generatedAt: number;
    endpoints: Array<{ id: string; name: string }>;
    /** More endpoints matched than the top-N returned. `findEndpoint` reports
     *  no count — this only says there ARE more. */
    hasMore: boolean;
    reachable: boolean;
    error?: string;
  }> {
    const qs = new URLSearchParams({
      ...serviceRefFields(service),
      q: query,
      limit: String(limit),
    });
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/endpoints?${qs.toString()}`,
    );
  }

  /** Instance list for one service. Same {@link ServiceRef} contract as
   *  {@link LayerApi.endpoints}. */
  instances(
    layerKey: string,
    service: ServiceRef,
  ): Promise<{
    layer: string;
    service: string;
    generatedAt: number;
    instances: Array<{
      id: string;
      name: string;
      language: string | null;
      attributes: Array<{ name: string; value: string }>;
    }>;
    reachable: boolean;
    error?: string;
  }> {
    const qs = new URLSearchParams(serviceRefFields(service));
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/instances?${qs.toString()}`,
    );
  }

  /** Service map. `services` are the roster rows to seed the BFS from — ids
   *  and names travel together; empty / omitted seeds the whole layer. */
  topology(
    layerKey: string,
    services?: ServiceRef[],
    depth = 1,
    range?: { step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number },
    /** Admin preview: the operator's draft `topology` block (JSON string).
     *  Renders the draft against live OAP instead of the remote template. */
    previewConfig?: string,
    /** Cancels the request when the refresh round it belongs to is capped. */
    signal?: AbortSignal,
  ): Promise<TopologyResponse> {
    const qs = new URLSearchParams();
    if (services && services.length > 0) {
      qs.set('serviceId', services.map((s) => s.id).join(','));
      qs.set('service', services.map((s) => s.name).join(','));
    }
    qs.set('depth', String(depth));
    if (range) {
      qs.set('step', range.step);
      qs.set('startMs', String(range.startMs));
      qs.set('endMs', String(range.endMs));
    }
    if (previewConfig) qs.set('previewConfig', previewConfig);
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/topology?${qs.toString()}`,
      undefined,
      undefined,
      signal,
    );
  }

  /** Instance-to-instance topology between two services, opened from a
   *  service-map edge. `client` = the edge source service, `server` =
   *  the edge target service (matches OAP's getServiceInstanceTopology
   *  clientServiceId / serverServiceId). Only the layers whose topology
   *  config carries an `instanceTopology` block answer this (404 else). */
  instanceTopology(
    layerKey: string,
    clientServiceId: string,
    serverServiceId: string,
    range?: { step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number },
    /** Admin preview: the operator's draft `topology` block (JSON string);
     *  the BFF reads its nested `instanceTopology`. */
    previewConfig?: string,
    signal?: AbortSignal,
  ): Promise<InstanceTopologyResponse> {
    const qs = new URLSearchParams({ client: clientServiceId, server: serverServiceId });
    if (range) {
      qs.set('step', range.step);
      qs.set('startMs', String(range.startMs));
      qs.set('endMs', String(range.endMs));
    }
    if (previewConfig) qs.set('previewConfig', previewConfig);
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/instance-topology?${qs.toString()}`,
      undefined,
      undefined,
      signal,
    );
  }

  /** Deployment — instance-to-instance call graph WITHIN
   *  one service (OAP's getServiceInstanceTopology with the same id on both
   *  sides). Only layers carrying a `deployment` config block
   *  answer this (404 otherwise). */
  deployment(
    layerKey: string,
    service: ServiceRef,
    range?: { step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number },
    /** Admin preview: the operator's draft `deployment` block. */
    previewConfig?: string,
    signal?: AbortSignal,
  ): Promise<DeploymentResponse> {
    const qs = new URLSearchParams(serviceRefFields(service));
    if (range) {
      qs.set('step', range.step);
      qs.set('startMs', String(range.startMs));
      qs.set('endMs', String(range.endMs));
    }
    if (previewConfig) qs.set('previewConfig', previewConfig);
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/deployment?${qs.toString()}`,
      undefined,
      undefined,
      signal,
    );
  }

  endpointDependency(
    layerKey: string,
    service: ServiceRef,
    endpoint: string,
    range?: { step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number },
    /** Admin preview: the operator's draft `endpointDependency` block. */
    previewConfig?: string,
    signal?: AbortSignal,
  ): Promise<EndpointDependencyResponse> {
    const qs = new URLSearchParams({ ...serviceRefFields(service), endpoint });
    if (range) {
      qs.set('step', range.step);
      qs.set('startMs', String(range.startMs));
      qs.set('endMs', String(range.endMs));
    }
    if (previewConfig) qs.set('previewConfig', previewConfig);
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/endpoint-dependency?${qs.toString()}`,
      undefined,
      undefined,
      signal,
    );
  }

  /** Probe a service's cross-layer hierarchy peers. Called lazily by
   *  the service-map view on node-select to decide whether to render
   *  the Smartscape expand chip, then re-used to populate the focus +
   *  context + suggestions overlay when the operator opens it. */
  serviceHierarchy(
    layerKey: string,
    service: ServiceRef,
  ): Promise<ServiceHierarchyResponse> {
    const qs = new URLSearchParams(serviceRefFields(service));
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/service-hierarchy?${qs.toString()}`,
    );
  }

  /** Full service roster for a layer (id + name + normal-flag), read
   *  from the BFF's cached `listServices` snapshot. The layer shell
   *  uses this to validate a URL-pinned `?service=<id>` against the
   *  layer's real catalog — independent of landing's top-N rollup
   *  which can miss low-traffic services. */
  services(
    layerKey: string,
    /** Cancels the request when the refresh round it belongs to is capped. */
    signal?: AbortSignal,
  ): Promise<{
    reachable: boolean;
    layer: string;
    services: Array<{ id: string; name: string; normal: boolean | null; group: string }>;
    error?: string;
  }> {
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/services`,
      undefined,
      undefined,
      signal,
    );
  }

}
