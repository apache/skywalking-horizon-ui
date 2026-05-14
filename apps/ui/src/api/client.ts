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
  EndpointDependencyConfig,
  EndpointDependencyResponse,
  LandingConfig,
  LandingResponse,
  LogFacetsResponse,
  LogQueryRequest,
  LogsResponse,
  MenuResponse,
  OapInfo,
  SetupResponse,
  SetupSavePayload,
  TopologyConfig,
  TopologyResponse,
  TraceDetailResponse,
  TraceListResponse,
  TraceQueryOrder,
  TraceQueryState,
  TraceSource,
  TracesConfig,
} from '@skywalking-horizon-ui/api-client';

export type {
  MenuResponse,
  LayerDef,
  LayerCaps,
  LayerSlots,
  OapInfo,
  SetupResponse,
  SetupSavePayload,
  LayerConfig,
  LandingConfig,
  LandingColumn,
  LandingResponse,
  LandingServiceRow,
  DashboardConfig,
  DashboardResponse,
  DashboardWidget,
  DashboardWidgetResult,
  TopologyMetricDef,
  TopologyConfig,
  EndpointDependencyConfig,
  TopologyNode,
  TopologyCall,
  TopologyResponse,
  EndpointDependencyNode,
  EndpointDependencyCall,
  EndpointDependencyResponse,
  TraceSource,
  TracesConfig,
  TraceKeyValue,
  TraceLogEntry,
  TraceAttachedEvent,
  TraceRef,
  NativeSpan,
  NativeTraceListRow,
  NativeTraceListResponse,
  NativeTraceDetailResponse,
  TraceQueryOrder,
  TraceQueryState,
  ZipkinEndpoint,
  ZipkinAnnotation,
  ZipkinKind,
  ZipkinSpan,
  ZipkinTraceListRow,
  ZipkinTraceListResponse,
  ZipkinTraceDetailResponse,
  TraceListResponse,
  TraceDetailResponse,
  LogKeyValue,
  LogRow,
  LogTagFilter,
  LogQueryRequest,
  LogsResponse,
  LogFacetsResponse,
} from '@skywalking-horizon-ui/api-client';


export interface MeResponse {
  username: string;
  roles: string[];
  verbs: string[];
}

/** Wire shape returned by GET /api/admin/layer-templates. */
export interface AdminLayerTemplate {
  key: string;
  alias?: string;
  color?: string;
  documentLink?: string;
  slots: { services?: string; instances?: string; endpoints?: string; endpointDependency?: string };
  components: {
    service?: boolean;
    instances?: boolean;
    endpoints?: boolean;
    endpointDependency?: boolean;
    topology?: boolean;
    traces?: boolean;
    logs?: boolean;
    profiling?: boolean;
    traceProfiling?: boolean;
    ebpfProfiling?: boolean;
    asyncProfiling?: boolean;
  };
  metrics: {
    orderBy?: string;
    columns?: Array<{
      metric: string;
      label: string;
      unit?: string;
      mqe?: string;
      aggregation?: 'sum' | 'avg';
      scale?: number;
      precision?: number;
    }>;
  };
  overview?: {
    throughput?: string;
    spark?: string;
  };
  widgets: DashboardWidget[];
  /** Operator-editable service-map config — node + server + client
   *  metric definitions, with optional thresholds. */
  topology?: TopologyConfig;
  /** Operator-editable API-dependency config — node + server-side line
   *  metrics (OAP has no client family for endpoint relations). */
  endpointDependency?: EndpointDependencyConfig;
  /** Per-layer trace source default. */
  traces?: TracesConfig;
}

export class BffApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'BffApiError';
    this.status = status;
    this.body = body;
  }
}

type On401 = () => void;

export class BffClient {
  private on401: On401 | null = null;

  setOn401(fn: On401): void {
    this.on401 = fn;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(path, init);
    if (res.status === 401) {
      this.on401?.();
      throw new BffApiError(401, 'unauthenticated', null);
    }
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = await res.text();
      }
      throw new BffApiError(res.status, `${method} ${path} failed (${res.status})`, parsed);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  // ── auth ─────────────────────────────────────────────────────────────
  login(username: string, password: string): Promise<MeResponse> {
    return this.request<MeResponse>('POST', '/api/auth/login', { username, password });
  }

  logout(): Promise<{ status: 'ok' }> {
    return this.request<{ status: 'ok' }>('POST', '/api/auth/logout');
  }

  me(): Promise<MeResponse> {
    return this.request<MeResponse>('GET', '/api/auth/me');
  }

  // ── menu / layers ────────────────────────────────────────────────────
  menu(): Promise<MenuResponse> {
    return this.request<MenuResponse>('GET', '/api/menu');
  }

  oapInfo(): Promise<OapInfo> {
    return this.request<OapInfo>('GET', '/api/oap/info');
  }

  // ── setup (per-layer overrides) ──────────────────────────────────────
  loadSetup(): Promise<SetupResponse> {
    return this.request<SetupResponse>('GET', '/api/setup');
  }

  saveSetup(payload: SetupSavePayload): Promise<SetupResponse> {
    return this.request<SetupResponse>('POST', '/api/setup', payload);
  }

  // ── landing (per-layer top-N) ────────────────────────────────────────
  layerLanding(layerKey: string, cfg: LandingConfig): Promise<LandingResponse> {
    // The wire payload mirrors LandingConfig minus the priority/style
    // bits the BFF doesn't care about.
    const body = {
      topN: cfg.topN,
      orderBy: cfg.orderBy,
      columns: cfg.columns,
      ...(cfg.spark ? { spark: cfg.spark } : {}),
      ...(cfg.throughput ? { throughput: cfg.throughput } : {}),
    };
    return this.request<LandingResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/landing`,
      body,
    );
  }

  // ── dashboards (per-layer widget data) ───────────────────────────────
  dashboardConfig(layerKey: string, scope?: string): Promise<DashboardConfig> {
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    return this.request<DashboardConfig>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/dashboard/config${qs}`,
    );
  }
  dashboard(
    layerKey: string,
    body: {
      service?: string;
      /** Active instance name. When set with `scope === 'instance'`,
       *  the BFF flips each widget's MQE entity to ServiceInstance. */
      serviceInstance?: string;
      /** Active endpoint name. When set with `scope === 'endpoint'`,
       *  the BFF flips each widget's MQE entity to Endpoint. */
      endpoint?: string;
      widgets?: DashboardWidget[];
      scope?: string;
    } = {},
    /** Dev-mode mock: pad every TopList result to N entries with
     *  synthetic rows so operators can verify widget sizing without
     *  waiting for live data. Forwarded as `?mockTop=N`. */
    opts: { mockTop?: number } = {},
  ): Promise<DashboardResponse> {
    const qs = opts.mockTop && opts.mockTop > 0 ? `?mockTop=${opts.mockTop}` : '';
    return this.request<DashboardResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/dashboard${qs}`,
      body,
    );
  }
  /** Top-N endpoint search for a service. The per-layer Endpoint
   *  dashboard's picker calls this with the operator's search term;
   *  endpoints are unbounded by nature so we don't page through them.
   *  `limit` is clamped 20…50 by the BFF. */
  layerEndpoints(
    layerKey: string,
    service: string,
    query: string,
    limit = 20,
  ): Promise<{
    layer: string;
    service: string;
    query: string;
    limit: number;
    generatedAt: number;
    endpoints: Array<{ id: string; name: string }>;
    reachable: boolean;
    error?: string;
  }> {
    const qs = new URLSearchParams({
      service,
      q: query,
      limit: String(limit),
    });
    return this.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/endpoints?${qs.toString()}`,
    );
  }

  /** Service-map feed for the per-layer Topology tab. Returns the
   *  service neighbourhood centred on `service` (or the whole layer
   *  if omitted), each real node decorated with cpm / resp_time / sla.
   *  Depth controls BFS expansion (1…3); the operator can ratchet
   *  this up to inspect indirect callers. */
  layerTopology(layerKey: string, service?: string, depth = 1): Promise<TopologyResponse> {
    const qs = new URLSearchParams();
    if (service) qs.set('service', service);
    qs.set('depth', String(depth));
    return this.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/topology?${qs.toString()}`,
    );
  }

  /** API-dependency feed. Resolves `endpoint` (name or id) to an
   *  endpoint id via findEndpoint, then walks
   *  `getEndpointDependencies` to surface upstream callers and
   *  downstream callees with per-node MQE. */
  layerEndpointDependency(
    layerKey: string,
    service: string,
    endpoint: string,
  ): Promise<EndpointDependencyResponse> {
    const qs = new URLSearchParams({ service, endpoint });
    return this.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/endpoint-dependency?${qs.toString()}`,
    );
  }

  /** List traces — fans out to SW-native and / or Zipkin based on
   *  the layer's config and the operator's override. */
  layerTraces(
    layerKey: string,
    body: {
      source?: TraceSource;
      service?: string;
      serviceId?: string;
      instanceId?: string;
      endpointId?: string;
      traceId?: string;
      traceState?: TraceQueryState;
      queryOrder?: TraceQueryOrder;
      minTraceDuration?: number;
      maxTraceDuration?: number;
      pageNum?: number;
      pageSize?: number;
      tags?: Array<{ key: string; value: string }>;
      windowMinutes?: number;
      start?: string;
      end?: string;
    } = {},
  ): Promise<TraceListResponse> {
    return this.request<TraceListResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/traces`,
      body,
    );
  }

  /** Trace detail by id. `source=zipkin` swaps to the Zipkin REST
   *  path; default is native (v2/v3 picked automatically). */
  traceDetail(traceId: string, source: 'native' | 'zipkin' = 'native'): Promise<TraceDetailResponse> {
    const qs = new URLSearchParams({ source });
    return this.request<TraceDetailResponse>(
      'GET',
      `/api/trace/${encodeURIComponent(traceId)}?${qs.toString()}`,
    );
  }

  /** Log query — body shape mirrors OAP's `LogQueryCondition`. */
  layerLogs(layerKey: string, body: LogQueryRequest & { service?: string } = {}): Promise<LogsResponse> {
    return this.request<LogsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/logs`,
      body,
    );
  }

  /** Tag autocomplete — list known tag keys for the duration window. */
  traceTagKeys(windowMinutes: number = 30): Promise<{ keys: string[]; generatedAt: number; error?: string }> {
    return this.request('GET', `/api/trace-tags/keys?windowMinutes=${windowMinutes}`);
  }
  /** Tag autocomplete — list values for a specific key. */
  traceTagValues(
    key: string,
    windowMinutes: number = 30,
  ): Promise<{ key: string; values: string[]; generatedAt: number; error?: string }> {
    return this.request(
      'GET',
      `/api/trace-tags/values?key=${encodeURIComponent(key)}&windowMinutes=${windowMinutes}`,
    );
  }

  /** Log facets — same body as `layerLogs`, but returns aggregated
   *  level + service counts across a larger window-scoped sample. */
  layerLogFacets(
    layerKey: string,
    body: LogQueryRequest & { service?: string; sampleSize?: number } = {},
  ): Promise<LogFacetsResponse> {
    return this.request<LogFacetsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/logs/facets`,
      body,
    );
  }

  /** Log tag autocomplete — list known tag keys for a recent log
   *  window. Wraps OAP's `queryLogTagAutocompleteKeys`. */
  logTagKeys(
    windowMinutes: number = 30,
  ): Promise<{ keys: string[]; generatedAt: number; error?: string }> {
    return this.request('GET', `/api/log-tags/keys?windowMinutes=${windowMinutes}`);
  }
  /** Log tag autocomplete — list values for a specific key. Wraps
   *  OAP's `queryLogTagAutocompleteValues`. */
  logTagValues(
    key: string,
    windowMinutes: number = 30,
  ): Promise<{ key: string; values: string[]; generatedAt: number; error?: string }> {
    return this.request(
      'GET',
      `/api/log-tags/values?key=${encodeURIComponent(key)}&windowMinutes=${windowMinutes}`,
    );
  }

  /** List active instances for a service. The per-layer Instance
   *  dashboard surfaces a second selector below the service picker;
   *  this feeds it. Accepts the service id or name. */
  layerInstances(
    layerKey: string,
    service: string,
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
    const qs = `?service=${encodeURIComponent(service)}`;
    return this.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/instances${qs}`,
    );
  }

  saveLayerTemplate(template: AdminLayerTemplate): Promise<{ template: AdminLayerTemplate }> {
    return this.request<{ template: AdminLayerTemplate }>(
      'POST',
      `/api/admin/layer-templates/${encodeURIComponent(template.key)}`,
      template,
    );
  }

  /** Admin: list every loaded layer template (alias / components / widgets). */
  adminLayerTemplates(): Promise<{ templates: AdminLayerTemplate[] }> {
    return this.request<{ templates: AdminLayerTemplate[] }>(
      'GET',
      '/api/admin/layer-templates',
    );
  }

  // ── cluster / preflight ──────────────────────────────────────────────
  preflight(): Promise<unknown> {
    return this.request('GET', '/api/preflight');
  }

  clusterState(): Promise<unknown> {
    return this.request('GET', '/api/cluster/state');
  }
}

export const bffClient = new BffClient();
