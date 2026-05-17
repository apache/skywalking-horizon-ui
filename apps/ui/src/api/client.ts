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
 * BFF client façade. `BffClient` owns the fetch/error plumbing
 * (`request`, `BffApiError`, 401 hook) and exposes one sub-client per
 * API scope. Call sites use the dot-namespaced shape:
 *
 *   bff.session.login(...)
 *   bff.menu.get()
 *   bff.layer.dashboard(layerKey, body)
 *   bff.dsl.getRule({ catalog, name })
 *   bff.alarms.list(query)
 *
 * Sub-clients live in `./scopes/*` and share this instance via
 * constructor injection. Add a new scope by creating a class in
 * `scopes/`, instantiating it in the property block below, and
 * re-exporting its public types from here so callers don't need to
 * reach into `scopes/*` for type imports.
 */

import type {
  DashboardWidget,
  DslDebuggingStatus,
  EndpointDependencyConfig,
  LocalState,
  MetricRow,
  RuleStatus,
  TopologyConfig,
  TracesConfig,
  Catalog,
} from '@skywalking-horizon-ui/api-client';

import { SessionApi } from './scopes/session';
import { MenuApi } from './scopes/menu';
import { OverviewApi } from './scopes/overview';
import { SetupApi } from './scopes/setup';
import { LayerApi } from './scopes/layer';
import { TraceApi } from './scopes/trace';
import { ZipkinApi } from './scopes/zipkin';
import { LogApi } from './scopes/log';
import { ProfileApi } from './scopes/profile';
import { EbpfApi } from './scopes/ebpf';
import { NetworkProfileApi } from './scopes/network-profile';
import { AsyncProfileApi } from './scopes/async-profile';
import { PprofApi } from './scopes/pprof';
import { DslApi } from './scopes/dsl';
import { LiveDebugApi } from './scopes/live-debug';
import { InspectApi } from './scopes/inspect';
import { AlarmsApi } from './scopes/alarms';
import { LayerTemplatesApi } from './scopes/layer-template';
import { ConfigsApi } from './scopes/configs';

// ── Wire types re-exported from @skywalking-horizon-ui/api-client ────
// Re-exported so consumers can import everything from this module.
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
  ProfileTask,
  ProfileTaskLog,
  ProfileTaskListResponse,
  ProfileTaskLogsResponse,
  ProfileSpan,
  ProfileSpanRef,
  ProfileSpanTag,
  ProfileSpanLog,
  ProfileSpanLogData,
  ProfileSegment,
  ProfileSegmentsResponse,
  ProfileAnalyzationElement,
  ProfileAnalyzationTree,
  ProfileAnalyzationResponse,
  ProfileTimeRange,
  ProfileAnalyzeQuery,
  ProfileTaskCreationRequest,
  ProfileTaskCreationResponse,
  EBPFTargetType,
  EBPFTriggerType,
  EBPFAggregateType,
  EBPFTask,
  EBPFProcess,
  EBPFSchedule,
  EBPFStackElement,
  EBPFAnalysisTree,
  EBPFTaskCreationRequest,
  EBPFTaskCreationResult,
  EBPFTaskListResponse,
  EBPFSchedulesResponse,
  EBPFAnalyzeRequest,
  EBPFAnalyzeResponse,
  EBPFTaskCreationResponse,
  ProcessNode,
  ProcessCall,
  ProcessTopologyResponse,
  NetworkProfilingSampling,
  NetworkProfilingCreateRequest,
  NetworkProfilingCreateResponse,
  NetworkProfilingKeepAliveResponse,
  AsyncProfilingEvent,
  AsyncJFREventType,
  AsyncProfilingTask,
  AsyncProfilingProgressLog,
  AsyncProfilingProgress,
  AsyncProfilingStackElement,
  AsyncProfilingTree,
  AsyncProfilingTaskCreationRequest,
  AsyncProfilingTaskListResponse,
  AsyncProfilingProgressResponse,
  AsyncProfilingAnalyzeResponse,
  AsyncProfilingTaskCreationResponse,
  PprofTask,
  PprofProgress,
  PprofStackElement,
  PprofTree,
  PprofTaskCreationRequest,
  PprofTaskListResponse,
  PprofProgressResponse,
  PprofAnalyzeResponse,
  PprofTaskCreationResponse,
} from '@skywalking-horizon-ui/api-client';

/** Query shape for `/api/zipkin/traces`. Mirrors the Zipkin v2 REST
 *  params; all optional, `endTs` defaults to now and `lookback` to 30
 *  min (ms) server-side. */
export interface ZipkinTraceQuery {
  serviceName?: string;
  remoteServiceName?: string;
  spanName?: string;
  annotationQuery?: string;
  /** microseconds */
  minDuration?: number;
  /** microseconds */
  maxDuration?: number;
  /** ms since epoch */
  endTs?: number;
  /** ms */
  lookback?: number;
  limit?: number;
}

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
  /** `public` (default) surfaces in the Layers section; `operate`
   *  surfaces in the Self-Observability block under Manage. */
  visibility?: 'public' | 'operate';
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
  topology?: TopologyConfig;
  endpointDependency?: EndpointDependencyConfig;
  traces?: TracesConfig;
  naming?: {
    pattern: string;
    flags?: string;
    displayGroup?: string;
    valueGroup?: string;
    alias: string;
  };
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

/** Reduce an unknown thrown value to a short user-facing string. Knows
 *  both the {@link BffApiError} envelope AND the upstream
 *  `{ status: 'error', code, message }` shape that surfaces through it. */
export function describeApiError(err: unknown): string {
  if (
    err instanceof BffApiError ||
    (typeof err === 'object' && err !== null && 'status' in err && 'body' in err)
  ) {
    const e = err as { status: number; body: unknown };
    if (typeof e.body === 'object' && e.body !== null) {
      const o = e.body as Record<string, unknown>;
      if (typeof o.code === 'string' && typeof o.message === 'string') {
        return `${e.status} (${o.code}): ${o.message}`;
      }
      if (typeof o.message === 'string') {
        return `${e.status}: ${o.message}`;
      }
      if (typeof o.applyStatus === 'string') {
        return `${e.status} (${o.applyStatus})`;
      }
    }
    if (typeof e.body === 'string' && e.body.length > 0) {
      return `${e.status}: ${e.body}`;
    }
    return `HTTP ${e.status}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── BFF-only response shapes ──────────────────────────────────────────
// Kept here (not in @skywalking-horizon-ui/api-client) because they're
// BFF-computed (rule attribution, per-node fan-out matrices, server-time
// fallbacks), not raw OAP wire types.

/** Per-cluster fan-out of `/dsl-debugging/status`. */
export interface ClusterDebugStatus {
  generatedAt: number;
  nodes: { url: string; ok: boolean; status?: DslDebuggingStatus; error?: string }[];
}

/** Per-rule × per-node convergence cell. */
export interface ClusterRulePerNode {
  status: RuleStatus | null;
  localState: LocalState | null;
  contentHash: string | null;
  lastApplyError: string;
}

export interface ClusterRule {
  catalog: Catalog;
  name: string;
  converged: boolean;
  perNode: Record<string, ClusterRulePerNode>;
}

export interface ClusterStateResponse {
  generatedAt: number;
  nodes: { url: string; ok: boolean; error?: string }[];
  rules: ClusterRule[];
}

/** OAP server-time discovery — `getTimeInfo`, falling back to the
 *  BFF's local clock when OAP is unreachable. */
export interface InspectServerTimeResponse {
  offsetMinutes: number;
  currentTimestampMillis: number;
  source: 'oap' | 'fallback';
  mqeBaseUrl?: string;
  error?: string;
}

/** Inspect catalog row joined with the rule-file each metric was
 *  declared in. */
export interface InspectCatalogEntry extends MetricRow {
  attribution: {
    source: 'OAL' | 'MAL·OTEL' | 'MAL·Telegraf' | 'LAL→MAL' | 'unknown';
    file: string | null;
    candidates?: string[];
  };
}

export interface InspectCatalogResponse {
  metrics: InspectCatalogEntry[];
  summary: Record<string, number>;
  attributionFingerprint: string;
}

/** Discovered (or operator-overridden) MQE base URL. */
export interface InspectMqeTargetResponse {
  baseUrl: string;
  via: string;
  configured: { host?: string; port?: number };
}

// ── Alarms wire types (BFF-only) ──────────────────────────────────────
// Kept inline because every shape is BFF-shaped — getAlarm gets layer-
// tagged per row, traffic is BFF-aggregated, the config is a BFF file.

export type AlarmScope =
  | 'All'
  | 'Service'
  | 'ServiceInstance'
  | 'Endpoint'
  | 'Process'
  | 'ServiceRelation'
  | 'ServiceInstanceRelation'
  | 'EndpointRelation'
  | 'ProcessRelation'
  | null;

export interface AlarmMqeKeyValue { key: string; value: string }
export interface AlarmMqeValueRow {
  id?: string | null;
  value: string | null;
  traceID?: string | null;
}
export interface AlarmMqeValuesGroup {
  metric?: { labels?: AlarmMqeKeyValue[] } | null;
  values: AlarmMqeValueRow[];
}
export interface AlarmMqeMetric {
  name: string;
  results: AlarmMqeValuesGroup[];
}
export interface AlarmSnapshot {
  expression: string;
  metrics: AlarmMqeMetric[];
}
export interface AlarmMessage {
  id: string;
  startTime: number;
  recoveryTime: number | null;
  scope: AlarmScope;
  name: string;
  message: string;
  tags: AlarmMqeKeyValue[];
  /** Omitted from the list query because some OAP storage backends
   *  throw `fail to query stream` when streaming events alongside an
   *  alarm page. Available on dedicated per-alarm fetches if those
   *  land later. */
  events?: Array<Record<string, unknown>>;
  snapshot: AlarmSnapshot;
  /** Null when the entity name isn't a known service. */
  layerKey: string | null;
}
export interface AlarmsResponse {
  total: number;
  pageNum: number;
  pageSize: number;
  generatedAt: number;
  msgs: AlarmMessage[];
}
export interface AlarmsQuery {
  startTime: number;
  endTime: number;
  scope?: string;
  keyword?: string;
  pageNum?: number;
  pageSize?: number;
  service?: string;
  instance?: string;
  endpoint?: string;
}
export interface AlarmTrafficPoint { ts: number; value: number | null }
export interface AlarmTrafficSeries {
  layerKey: string;
  label: string;
  present: boolean;
  points: AlarmTrafficPoint[];
  error?: string;
}
export interface AlarmTrafficResponse {
  generatedAt: number;
  startTime: number;
  endTime: number;
  step: 'MINUTE';
  series: AlarmTrafficSeries[];
}
export interface AlarmTrafficLayerConfig {
  layerKey: string;
  mqe: string;
  label?: string;
}
export interface AlarmsConfig {
  trafficLayers: AlarmTrafficLayerConfig[];
}

type On401 = () => void;

export class BffClient {
  private on401: On401 | null = null;

  setOn401(fn: On401): void {
    this.on401 = fn;
  }

  /** Invoked by sub-clients (`scopes/dsl.ts`, `scopes/live-debug.ts`)
   *  that bypass `request()` to read response headers directly. */
  handleUnauthorized(): void {
    this.on401?.();
  }

  /** Internal — used by sub-clients in `./scopes/*` to dispatch a JSON
   *  request and unwrap the typed body. 401 hits the {@link setOn401}
   *  hook before rejecting with {@link BffApiError}; other non-2xx
   *  responses also throw. 204s resolve to `undefined`. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
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

  // ── Sub-clients (one per scope) ───────────────────────────────────
  readonly session = new SessionApi(this);
  readonly menu = new MenuApi(this);
  readonly overview = new OverviewApi(this);
  readonly setup = new SetupApi(this);
  readonly layer = new LayerApi(this);
  readonly trace = new TraceApi(this);
  readonly zipkin = new ZipkinApi(this);
  readonly log = new LogApi(this);
  readonly profile = new ProfileApi(this);
  readonly ebpf = new EbpfApi(this);
  readonly networkProfile = new NetworkProfileApi(this);
  readonly asyncProfile = new AsyncProfileApi(this);
  readonly pprof = new PprofApi(this);
  readonly dsl = new DslApi(this);
  readonly liveDebug = new LiveDebugApi(this);
  readonly inspect = new InspectApi(this);
  readonly alarms = new AlarmsApi(this);
  readonly layerTemplates = new LayerTemplatesApi(this);
  readonly configs = new ConfigsApi(this);
}

export const bffClient = new BffClient();

/** Vantage-compatible alias — imported as `bff` by ported views. */
export const bff = bffClient;
