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
  LayerOverviewConfig,
  LocalState,
  MetricRow,
  ProcessTopologyConfig,
  RuleStatus,
  DeploymentConfig,
  TopologyConfig,
  TracesConfig,
  Catalog,
} from '@skywalking-horizon-ui/api-client';

import { pushEvent } from '@/controls/eventLog';
import { COLD_STAGE_HEADER, readColdStageHeader } from '@/controls/coldStage';
import { currentLocale } from '@/i18n';
import { SessionApi } from './scopes/session';

/** Header the BFF reads to localize template responses. UI sends this
 *  on every request; the BFF falls back to Accept-Language only when
 *  it's absent (pre-bootstrap / non-SPA callers). */
const LOCALE_HEADER = 'X-Horizon-Locale';

/** Deploy-base prefix for every API call. Pulled from Vite's
 *  `BASE_URL` so the same build artifact works whether served at
 *  `/` (default), `/horizon/` (behind a gateway), or any other
 *  sub-path. Mirrors the router's `createWebHistory(BASE_URL)`
 *  behavior — both must use the same prefix or the SPA navigates
 *  to working URLs but its data calls 404. */
const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
/** Prepend the deploy base to a path that starts with `/`. Exported
 *  so the direct-fetch paths (configs.bundle's 304 detection, dsl's
 *  text/plain responses) can apply the same prefix as the central
 *  `BffClient.request` path. */
export function withBase(path: string): string {
  return API_BASE + path;
}
import { MenuApi } from './scopes/menu';
import { OverviewApi } from './scopes/overview';
import { SetupApi } from './scopes/setup';
import { LayerApi } from './scopes/layer';
import { TraceApi } from './scopes/trace';
import { ZipkinApi } from './scopes/zipkin';
import { LogApi } from './scopes/log';
import { BrowserErrorsApi } from './scopes/browser-errors';
import { ProfileApi } from './scopes/profile';
import { EbpfApi } from './scopes/ebpf';
import { NetworkProfileApi } from './scopes/network-profile';
import { AsyncProfileApi } from './scopes/async-profile';
import { PprofApi } from './scopes/pprof';
import { DslApi } from './scopes/dsl';
import { LiveDebugApi } from './scopes/live-debug';
import { InspectApi } from './scopes/inspect';
import { OapOpsApi } from './scopes/oap-ops';
import { AlarmsApi } from './scopes/alarms';
import { Infra3dApi } from './scopes/infra-3d';
import { LayerTemplatesApi } from './scopes/layer-template';
import { ConfigsApi } from './scopes/configs';
import { AdminAuthApi } from './scopes/admin-auth';
import { AdminUsersApi } from './scopes/admin-users';
import { TemplateSyncApi } from './scopes/template-sync';

// ── Wire types re-exported from @skywalking-horizon-ui/api-client ────
// Re-exported so consumers can import everything from this module.
export type {
  MenuResponse,
  LayerDef,
  InstanceListConfig,
  LayerCaps,
  LayerSlots,
  OapInfo,
  RecordsTTL,
  MetricsTTL,
  OapTtlResponse,
  OapConfigEntry,
  OapConfigResponse,
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
  InstanceTopologyConfig,
  EndpointDependencyConfig,
  TopologyNode,
  TopologyCall,
  TopologyResponse,
  InstanceTopologyNode,
  InstanceTopologyCall,
  InstanceTopologyResponse,
  DeploymentMetricDef,
  ClusterByRule,
  NodeRoleConfig,
  RolePairMetrics,
  DeploymentConfig,
  DeploymentNode,
  DeploymentCall,
  DeploymentResponse,
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
  BrowserErrorCategory,
  BrowserErrorRow,
  BrowserErrorsQueryRequest,
  BrowserErrorsResponse,
  SourceMapDescriptor,
  SourceMapUsage,
  SourceMapListResponse,
  SourceMapUploadResponse,
  ResolveRequest,
  ResolvedFrame,
  ResolveResponse,
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
  ProcessRelationEndpointRef,
  ProcessRelationMetric,
  ProcessRelationMetricsResponse,
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
  /** Server-suggested landing route based on the user's role. The
   *  router uses this on fresh login when no `?redirect=` is set. */
  landingRoute?: string;
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
  slots: { services?: string; instances?: string; endpoints?: string; endpointDependency?: string; topology?: string; instanceTopology?: string; deployment?: string };
  components: {
    service?: boolean;
    instances?: boolean;
    endpoints?: boolean;
    endpointDependency?: boolean;
    topology?: boolean;
    deployment?: boolean;
    traces?: boolean;
    logs?: boolean;
    browserErrors?: boolean;
    podLogs?: boolean;
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
  /** Overview-tile config (group list). Edited on the Overview-templates
   *  admin, not here — surfaced for the translation preview + so a
   *  round-trip save preserves it. */
  overview?: LayerOverviewConfig;
  widgets: DashboardWidget[];
  topology?: TopologyConfig;
  deployment?: DeploymentConfig;
  endpointDependency?: EndpointDependencyConfig;
  processTopology?: ProcessTopologyConfig;
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
  /** True iff `total === pageSize`. The page should warn the operator
   *  that there may be more alarms than shown. */
  truncated: boolean;
  generatedAt: number;
  msgs: AlarmMessage[];
}
export interface AlarmsQuery {
  startTime: number;
  endTime: number;
  /** Legacy mode only — Service / Endpoint / etc. Ignored in new-API
   *  mode in favor of the `layer` + entity-cascade fields. */
  scope?: string;
  keyword?: string;
  pageNum?: number;
  pageSize?: number;
  /** New-API mode only — narrows to alarms in this OAP layer. */
  layer?: string;
  service?: string;
  instance?: string;
  endpoint?: string;
}
export interface AlarmsCountResponse {
  /** Total individual events returned (capped). */
  total: number;
  /** Events where `recoveryTime === null`. */
  firing: number;
  /** Distinct (entity, rule) incidents. */
  incidents: number;
  /** Incidents whose latest event is firing. Topbar badge reads
   *  this — fully-recovered incidents count as "no alarm". */
  activeIncidents: number;
  truncated: boolean;
  startTime: number;
  endTime: number;
  generatedAt: number;
}
/** Mirror of `AlarmRuleDetail` on the BFF (which mirrors OAP's
 *  `AlarmRuleDetail` Java type). Used by the alarms detail panel +
 *  the Operate › Alerting Rules page. */
export interface AlarmRuleDetail {
  ruleId: string;
  expression: string;
  period: number;
  silencePeriod: number;
  recoveryObservationPeriod: number;
  additionalPeriod: number;
  includeEntityNames: string[];
  excludeEntityNames: string[];
  includeEntityNamesRegex?: string;
  excludeEntityNamesRegex?: string;
  runningEntities: Array<{ scope: string; name: string; formattedMessage: string }>;
  tags: Array<{ key: string; value: string }>;
  hooks: string[];
  includeMetrics: string[];
}
export interface AlertingRuleNode {
  address: string;
  ok: boolean;
  error?: string;
  loaded: boolean;
}
export interface AlertingRuleSummary {
  ruleId: string;
  detail: AlarmRuleDetail | null;
  nodes: AlertingRuleNode[];
  loadedOn: number;
  totalNodes: number;
}
export interface AlertingRulesListResponse {
  generatedAt: number;
  reachable: boolean;
  error?: string;
  rules: AlertingRuleSummary[];
  nodes: Array<{ address: string; ok: boolean; error?: string }>;
}
export interface AlertingRuleDetailResponse {
  ruleId: string;
  generatedAt: number;
  reachable: boolean;
  error?: string;
  detail: AlarmRuleDetail | null;
  nodes: Array<{ address: string; ok: boolean; error?: string; detail: AlarmRuleDetail | null }>;
}
/** Per-entity running window from `/status/alarm/{ruleId}/{entityName}`.
 *  Only the node evaluating the entity returns a populated body; other
 *  nodes return a stub and omit the evaluation-only fields. Mirrors the
 *  BFF's `AlarmRunningContext`. */
export interface AlarmRunningContext {
  ruleId: string;
  expression: string;
  endTime?: string;
  additionalPeriod: number;
  size: number;
  silencePeriod?: number;
  recoveryObservationPeriod?: number;
  silenceCountdown: number;
  recoveryObservationCountdown: number;
  currentState?: string;
  entityName?: string;
  windowValues: Array<{ index: number; metrics: Array<{ name: string; timeBucket: number; value: string }> }>;
  /** Metric name → JSON-encoded MQE series array. */
  mqeMetricsSnapshot?: Record<string, string>;
  lastAlarmTime: number | string;
  lastAlarmMessage?: string;
  lastAlarmMqeMetricsSnapshot?: Record<string, string>;
}
/** One series inside a parsed `mqeMetricsSnapshot` value. */
export interface AlarmMqeSnapshotSeries {
  metric: { labels: Array<{ key: string; value: string }> };
  values: Array<{ id: string; doubleValue: number; isEmptyValue: boolean }>;
}
export interface AlertingRuleContextResponse {
  ruleId: string;
  entityName: string;
  generatedAt: number;
  reachable: boolean;
  error?: string;
  nodes: Array<{ address: string; ok: boolean; error?: string; context: AlarmRunningContext | null }>;
}
/** Allowed values for `AlarmsConfig.defaultWindowMs`, in ms. Matches
 *  the alarms page's preset list so the admin's choice always
 *  corresponds to a real tab. */
export const ALARMS_WINDOW_OPTIONS = [
  20 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
] as const;
export type AlarmsWindowMs = (typeof ALARMS_WINDOW_OPTIONS)[number];

export const OVERVIEW_ALARMS_LIMIT_MIN = 10;
export const OVERVIEW_ALARMS_LIMIT_MAX = 500;
export const OVERVIEW_ALARMS_LIMIT_DEFAULT = 200;

export interface AlarmsConfig {
  /** OAP layer keys (canonical `GENERAL`, `MESH`, …) that get a
   *  dedicated tile on the alarms page header. Render order matches
   *  the array order. */
  pinnedLayers: string[];
  /** Default time window in milliseconds for the topbar alarm badge
   *  AND the alarms page's initial picker selection. */
  defaultWindowMs: number;
  /** Fetch cap for the overview "Active alarms" widget. Default 200,
   *  range [10, 500]. Bigger = more incident variety; smaller =
   *  cheaper poll. */
  overviewAlarmsLimit: number;
}

// ── 3D Infrastructure Map admin config ───────────────────────────────
// Mirrors `apps/bff/src/logic/infra-3d/types.ts`. Kept structurally
// identical (no API smoothing) so the Monaco YAML editor renders the
// exact shape persisted on disk — easier to debug field-by-field.

/** MQE entry — used for topology server/client pairs AND for the
 *  single load metric on non-topology layers. */
export interface InfraMqe {
  mqe: string;
  label: string;
  unit: string;
}

export interface InfraLayerSpec {
  color: string;
  /** Single traffic metric for the cube ring — canonical shape. */
  metric?: InfraMqe;
  /** @deprecated folded into `metric`; accepted for back-compat. */
  topology?: { server?: InfraMqe; client?: InfraMqe };
  /** @deprecated folded into `metric`; accepted for back-compat. */
  load?: InfraMqe;
}

export interface InfraLevelSpec {
  id: string;
  order: number;
  label: string;
  layers: string[];
}

export interface InfraGroupSpec {
  id: string;
  label: string;
  level: string;
  color: string;
  icon: string;
  layers: string[];
}

export interface InfraEdgeStyle {
  color: string;
  style: 'solid' | 'dashed';
  arrow: boolean;
}

export interface InfraPipelineLimits {
  metricChunkSize: number;
  topologyConcurrency: number;
  templateConcurrency: number;
}

export interface Infra3dConfig {
  filter: { layer: string };
  edges: {
    hierarchy: InfraEdgeStyle;
    crossLevelCall: InfraEdgeStyle;
    intraCall: InfraEdgeStyle;
  };
  pipeline: InfraPipelineLimits;
  unknownLayer: { level: string; badge: string };
  levels: InfraLevelSpec[];
  groups?: InfraGroupSpec[];
  layers: Record<string, InfraLayerSpec>;
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
   *  responses also throw. 204s resolve to `undefined`.
   *
   *  Every failure path (network throw, 401, other non-2xx) emits a
   *  `pushEvent('api', 'err', …)` into the debug event log so the
   *  ticker / DebugEventPanel surfaces backend trouble without each
   *  caller having to wire its own logging. Successful responses are
   *  intentionally NOT logged — the volume would drown the ticker. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    // Cold-stage flag is per-request not per-call-site, so the
    // interceptor reads the persisted toggle here rather than every
    // sub-client having to forward it. OAP ignores it for non-BanyanDB.
    const init: RequestInit = {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(readColdStageHeader() ? { [COLD_STAGE_HEADER]: '1' } : {}),
        // Stamp every request with the active UI locale. The BFF uses
        // this to localize template responses (layer dashboards,
        // overviews, sidebar menu); endpoints with no localized
        // content ignore the header at zero cost.
        [LOCALE_HEADER]: currentLocale(),
        ...headers,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const url = withBase(path);
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Network-level failure: DNS, CORS, aborted, BFF down, etc.
      // fetch() doesn't throw on HTTP-level errors (4xx/5xx) — only on
      // these. They're the "blocked" symptom operators see when the
      // BFF or its upstream is unreachable.
      const detail = err instanceof Error ? err.message : String(err);
      pushEvent('api', 'err', `${method} ${path} · network ${detail}`);
      // Wrap into a clear, actionable message — the raw "Failed to fetch" /
      // "Load failed" reads as a mystery to operators. status 0 = no HTTP
      // response reached us at all (BFF down / unreachable).
      throw new BffApiError(
        0,
        `Cannot reach the server — the BFF is unreachable (${detail}).`,
        null,
      );
    }
    if (res.status === 401) {
      // 401 is normal-ish (session expired) — log at 'info' rather
      // than 'err' so it doesn't read as a failure when it's just the
      // re-auth dance.
      pushEvent('api', 'info', `${method} ${path} · 401 (re-auth)`);
      this.on401?.();
      throw new BffApiError(401, 'unauthenticated', null);
    }
    if (!res.ok) {
      // Read the body ONCE as text, then try to parse it as JSON. Calling
      // res.json() then res.text() in a fallback double-reads the stream
      // ("body stream already read") and masks the real error — which is
      // exactly what happens when a non-JSON error (e.g. a Vite proxy 502
      // page when the BFF is down) comes back.
      const raw = await res.text().catch(() => '');
      let parsed: unknown = raw;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      // Surface the BFF's `code` / `message` envelope when present so
      // the operator gets the actionable reason instead of just "500".
      let extra = '';
      if (parsed && typeof parsed === 'object') {
        const env = parsed as { code?: unknown; message?: unknown };
        if (typeof env.code === 'string' || typeof env.message === 'string') {
          extra = ` · ${env.code ?? ''}${env.code && env.message ? ' — ' : ''}${env.message ?? ''}`;
        }
      } else if (typeof parsed === 'string' && parsed.length > 0 && parsed.length < 200) {
        extra = ` · ${parsed}`;
      }
      pushEvent('api', 'err', `${method} ${path} · ${res.status}${extra}`);
      throw new BffApiError(res.status, `${method} ${path} failed (${res.status})`, parsed);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  /** Multipart variant of {@link request} for file uploads (source-map
   *  `.map` files). Sends a FormData body WITHOUT a content-type header so
   *  the browser sets the multipart boundary; otherwise mirrors request()'s
   *  401 hook + error envelope. */
  async requestForm<T>(method: string, path: string, form: FormData): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'include',
      headers: {
        ...(readColdStageHeader() ? { [COLD_STAGE_HEADER]: '1' } : {}),
        [LOCALE_HEADER]: currentLocale(),
      },
      body: form,
    };
    const url = withBase(path);
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      pushEvent('api', 'err', `${method} ${path} · network ${detail}`);
      throw new BffApiError(0, `Cannot reach the server — the BFF is unreachable (${detail}).`, null);
    }
    if (res.status === 401) {
      pushEvent('api', 'info', `${method} ${path} · 401 (re-auth)`);
      this.on401?.();
      throw new BffApiError(401, 'unauthenticated', null);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let parsed: unknown = raw;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      pushEvent('api', 'err', `${method} ${path} · ${res.status}`);
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
  readonly browserErrors = new BrowserErrorsApi(this);
  readonly profile = new ProfileApi(this);
  readonly ebpf = new EbpfApi(this);
  readonly networkProfile = new NetworkProfileApi(this);
  readonly asyncProfile = new AsyncProfileApi(this);
  readonly pprof = new PprofApi(this);
  readonly dsl = new DslApi(this);
  readonly liveDebug = new LiveDebugApi(this);
  readonly inspect = new InspectApi(this);
  readonly oapOps = new OapOpsApi(this);
  readonly alarms = new AlarmsApi(this);
  readonly infra3d = new Infra3dApi(this);
  readonly layerTemplates = new LayerTemplatesApi(this);
  readonly configs = new ConfigsApi(this);
  readonly adminAuth = new AdminAuthApi(this);
  readonly adminUsers = new AdminUsersApi(this);
  readonly templateSync = new TemplateSyncApi(this);
}

export const bffClient = new BffClient();

/** Vantage-compatible alias — imported as `bff` by ported views. */
export const bff = bffClient;
