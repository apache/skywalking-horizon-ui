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
 * SWIP-14 Inspect API — read-only catalog + entity enumeration on
 * admin-server's port 17128. The endpoints are:
 *
 *   GET /inspect/metrics
 *   GET /inspect/entities?metric=…&start=…&end=…&step=…&limit=…
 *
 * Both are admin-only and are off by default — the operator must set
 * `SW_INSPECT=default` on OAP. Wire shapes match the implementation on
 * `swip-14-inspect-api` (final, post-review-pass-2). See
 * `oap-server/server-admin/inspect/src/main/java/.../response/`.
 *
 * The MQE values themselves live behind OAP's regular GraphQL
 * `execExpression` surface; the Inspect API only returns the catalog
 * and MQE-ready Entity shapes you can paste into that mutation.
 */

import type { FetchLike } from './runtime-rule.js';

// ── Catalog / metrics ──────────────────────────────────────────────

/** MetricsType emitted by OAP's `MetricsType.java`; values match
 *  `Column.ValueDataType` after the metadata mapping. */
export type InspectMetricType = 'REGULAR_VALUE' | 'LABELED_VALUE' | 'HEATMAP' | 'SAMPLED_RECORD';

/** Catalog string from `DefaultScopeDefine` — uppercase, underscore-
 *  separated. Used for the `/inspect/metrics?catalog=` filter. */
export type InspectCatalog =
  | 'SERVICE'
  | 'SERVICE_INSTANCE'
  | 'ENDPOINT'
  | 'SERVICE_RELATION'
  | 'SERVICE_INSTANCE_RELATION'
  | 'ENDPOINT_RELATION'
  | (string & {});

/** Scope name (e.g. `Service`, `ServiceInstance`, `Endpoint`,
 *  `ServiceRelation`, `ServiceInstanceRelation`, `EndpointRelation`).
 *  Comes straight from `Scope.Finder.valueOf(scopeId).name()`. */
export type InspectScope =
  | 'Service'
  | 'ServiceInstance'
  | 'Endpoint'
  | 'ServiceRelation'
  | 'ServiceInstanceRelation'
  | 'EndpointRelation'
  | (string & {});

export type InspectStep = 'MINUTE' | 'HOUR' | 'DAY';
export const INSPECT_STEPS: readonly InspectStep[] = ['MINUTE', 'HOUR', 'DAY'] as const;

/** Server-side hard cap on `/inspect/entities?limit=`. */
export const INSPECT_ENTITY_LIMIT_MAX = 300;

/** Storage value-type a caller declares when inspecting a FOREIGN metric —
 *  one this OAP does not define (no local registry entry to recover the
 *  column type from). Mirrors OAP's accepted set in `InspectRestHandler`:
 *  `LONG` / `INT` / `DOUBLE` are scalar; `LABELED` is a DataTable. HEATMAP
 *  and SAMPLED_RECORD are out of scope for `/inspect/entities`. */
export type InspectForeignValueType = 'LONG' | 'INT' | 'DOUBLE' | 'LABELED';
export const INSPECT_FOREIGN_VALUE_TYPES: readonly InspectForeignValueType[] = [
  'LONG',
  'INT',
  'DOUBLE',
  'LABELED',
] as const;

export interface MetricRow {
  name: string;
  type: InspectMetricType;
  catalog: InspectCatalog;
  scopeId: number;
  scope: InspectScope;
  valueColumnName: string;
  downsamplings: InspectStep[];
}

export interface MetricsResponse {
  metrics: MetricRow[];
}

// ── Entities ───────────────────────────────────────────────────────

/** MQE Entity input shape — field names match SkyWalking's GraphQL
 *  `Entity` input verbatim so the operator can paste this block
 *  straight into a `mutation execExpression(…, entity: …)`. The OAP
 *  side serialises with `@JsonInclude(NON_NULL)` so any field that
 *  doesn't apply to the scope is omitted from the JSON. */
export interface MqeEntity {
  scope: InspectScope;
  serviceName?: string;
  normal?: boolean;
  serviceInstanceName?: string;
  endpointName?: string;
  destServiceName?: string;
  destNormal?: boolean;
  destServiceInstanceName?: string;
  destEndpointName?: string;
}

/** Decoded entity-id payload — scope-dependent shape. For single
 *  scopes (`Service`, `ServiceInstance`, `Endpoint`) it carries
 *  service/instance/endpoint fields at the top level; for *Relation
 *  scopes it nests under `source` / `destination`. Modelled here as
 *  an open record because the JSON shape is fixed per scope but the
 *  union is wide. */
export type DecodedEntity = Record<string, unknown>;

export interface EntityRow {
  entityId: string;
  decoded: DecodedEntity;
  /** Set for service-bearing rows; one row per registered Layer.
   *  Omitted (Java `null` → field absent thanks to `NON_NULL`) when
   *  the service is missing from the metadata cache. */
  layer?: string;
  /** Re-queryable MQE entity. Present on the aware path (metric defined on
   *  this OAP). Absent on the FOREIGN path — a metric this OAP doesn't define
   *  can't be MQE-queried here, so the structural decode emits no entity. */
  mqeEntity?: MqeEntity;
}

export interface EntitiesResponse {
  metric: string;
  /** `null` on the FOREIGN path: a foreign metric's exact scope can't be
   *  recovered, only its per-row structural shape (carried in `decoded`). */
  scope: InspectScope | null;
  step: InspectStep;
  /** Echo of the `start` query param in the step-specific format. */
  start: string;
  /** Echo of the `end` query param in the step-specific format. */
  end: string;
  rows: EntityRow[];
}

// ── Request args ───────────────────────────────────────────────────

export interface ListMetricsArgs {
  /** Java regex.Pattern over metric name. No filter when omitted. */
  regex?: string;
  /** Repeatable; matches `MetricsType` enum names. */
  type?: InspectMetricType[];
  /** Repeatable; matches `DefaultScopeDefine` catalog names. */
  catalog?: InspectCatalog[];
  /** If true, narrows to MQE-queryable types (`REGULAR_VALUE` +
   *  `LABELED_VALUE`). */
  mqeQueryable?: boolean;
}

export interface ListEntitiesArgs {
  metric: string;
  /** Date string per step format. Use `formatInspectDate(date, step)`
   *  to build it. */
  start: string;
  end: string;
  step: InspectStep;
  /** 1–300, default 300 server-side. Studio defaults to a smaller
   *  number per widget. */
  limit?: number;
  /** FOREIGN-metric storage column, e.g. `value`. Required together with
   *  `valueType` to inspect a metric this OAP does not define; omit both
   *  for an aware metric (OAP reads the column from its own registry). */
  valueColumn?: string;
  /** FOREIGN-metric value type. Required together with `valueColumn`. */
  valueType?: InspectForeignValueType;
}

// ── MQE result shape ───────────────────────────────────────────────
//
// What `mutation execExpression(...)` returns on the public GraphQL
// surface — `data.execExpression`. Studio's BFF unwraps the GraphQL
// envelope and forwards this shape verbatim to the SPA.

export type ExpressionResultType =
  | 'UNKNOWN'
  | 'SINGLE_VALUE'
  | 'TIME_SERIES_VALUES'
  | 'SORTED_LIST'
  | 'RECORD_LIST';

export interface MqeOwner {
  scope?: string | null;
  serviceID?: string | null;
  serviceName?: string | null;
  normal?: boolean | null;
  serviceInstanceID?: string | null;
  serviceInstanceName?: string | null;
  endpointID?: string | null;
  endpointName?: string | null;
}

export interface MqeKeyValue {
  key: string;
  value: string;
}

export interface MqeMetadata {
  labels: MqeKeyValue[];
}

export interface MqeValue {
  id?: string | null;
  owner?: MqeOwner | null;
  /** Stringified number or `null` when absent. */
  value: string | null;
  traceID?: string | null;
}

export interface MqeValues {
  metric: MqeMetadata;
  values: MqeValue[];
}

export interface ExpressionResult {
  type: ExpressionResultType;
  results: MqeValues[];
  error?: string | null;
}

/** Per-metric metadata supplied to `POST /inspect/values` for a metric this
 *  OAP doesn't define (mirrors OAP's `ForeignMetricInput`). */
export interface ForeignMetricInput {
  name: string;
  valueColumn: string;
  valueType: InspectForeignValueType;
}

/** Wire shape for `POST /inspect/values` — evaluate an MQE expression over
 *  one or more FOREIGN metrics (values read from shared storage with the
 *  caller-supplied column/type). Returns the native `ExpressionResult`, same
 *  shape as GraphQL `execExpression`. This is the admin-port counterpart to
 *  `execExpression` for metrics the connected OAP can't evaluate itself. */
export interface InspectValuesRequest {
  expression: string;
  entity: MqeEntity;
  start: string;
  end: string;
  step: InspectStep;
  foreignMetrics: ForeignMetricInput[];
}

/** Wire shape for Studio's `POST /api/inspect/exec`. The BFF will
 *  translate this into a GraphQL `mutation execExpression(...)` call
 *  against the resolved MQE base. */
export interface InspectExecRequest {
  expression: string;
  entity: MqeEntity;
  duration: {
    start: string;
    end: string;
    step: InspectStep;
    /** Cold-stage flag, BanyanDB-only. Default false. */
    coldStage?: boolean;
  };
  /** Forwarded to GraphQL as `debug: Boolean`. Off by default. */
  debug?: boolean;
}

// ── Date format ────────────────────────────────────────────────────

/** Format a `Date` into the date string OAP expects for the given
 *  step. Mirrors `Duration.getStartTimeBucket` / `getEndTimeBucket`'s
 *  accepted shapes:
 *
 *    DAY    → `yyyy-MM-dd`
 *    HOUR   → `yyyy-MM-dd HH`
 *    MINUTE → `yyyy-MM-dd HHmm`
 *
 *  All values are zero-padded; the date is interpreted in the OAP
 *  server's local timezone, so prefer feeding through `UTC` if your
 *  OAP is configured for UTC (the default for containerised deploys).
 */
export function formatInspectDate(d: Date, step: InspectStep): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const date = `${y}-${m}-${day}`;
  if (step === 'DAY') return date;
  const h = String(d.getUTCHours()).padStart(2, '0');
  if (step === 'HOUR') return `${date} ${h}`;
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${date} ${h}${min}`;
}

/** True iff `s` parses as a valid date string for the given step. */
export function isInspectDate(s: string, step: InspectStep): boolean {
  if (step === 'DAY') return /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (step === 'HOUR') return /^\d{4}-\d{2}-\d{2} \d{2}$/.test(s);
  return /^\d{4}-\d{2}-\d{2} \d{4}$/.test(s);
}

// ── Errors ─────────────────────────────────────────────────────────

/** OAP's inspect error envelope: `{ "error": "string" }`. */
export interface InspectErrorBody {
  error: string;
}

export class InspectApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: InspectErrorBody | string,
    public readonly url: string,
  ) {
    const detail = typeof body === 'string' ? body : body.error;
    super(`${status} on ${url} — ${detail}`);
    this.name = 'InspectApiError';
  }
}

// ── Client ─────────────────────────────────────────────────────────

export interface InspectClientOptions {
  /** OAP admin port URL, e.g. `http://oap:17128`. No trailing slash. */
  adminUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  /** Default per-call timeout in ms. `0` disables. */
  timeoutMs?: number;
}

export class InspectClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: InspectClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = options.adminUrl.replace(/\/$/, '');
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /** `GET /inspect/metrics` with optional `regex` / `type` / `catalog`
   *  / `mqeQueryable` filters. Returns the full catalog when no
   *  filters are passed. */
  async listMetrics(args: ListMetricsArgs = {}): Promise<MetricsResponse> {
    const params = new URLSearchParams();
    if (args.regex !== undefined) params.set('regex', args.regex);
    if (args.mqeQueryable === true) params.set('mqeQueryable', 'true');
    for (const t of args.type ?? []) params.append('type', t);
    for (const c of args.catalog ?? []) params.append('catalog', c);
    const qs = params.toString();
    const url = `${this.base}/inspect/metrics${qs ? `?${qs}` : ''}`;
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as MetricsResponse;
  }

  /** `GET /inspect/entities` — `metric` + time range + step + limit. Pass
   *  `valueColumn` + `valueType` to inspect a FOREIGN metric (one this OAP
   *  doesn't define). */
  async listEntities(args: ListEntitiesArgs): Promise<EntitiesResponse> {
    const params = new URLSearchParams({
      metric: args.metric,
      start: args.start,
      end: args.end,
      step: args.step,
    });
    if (args.limit !== undefined) params.set('limit', String(args.limit));
    if (args.valueColumn !== undefined) params.set('valueColumn', args.valueColumn);
    if (args.valueType !== undefined) params.set('valueType', args.valueType);
    const url = `${this.base}/inspect/entities?${params.toString()}`;
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as EntitiesResponse;
  }

  /** `POST /inspect/values` — read the VALUES of FOREIGN metric(s) this OAP
   *  doesn't define, supplying their storage column/type in `foreignMetrics`.
   *  Returns the same `ExpressionResult` shape as GraphQL `execExpression`. */
  async inspectValues(req: InspectValuesRequest): Promise<ExpressionResult> {
    const url = `${this.base}/inspect/values`;
    const res = await this.send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as ExpressionResult;
  }

  // ── private helpers ─────────────────────────────────────────────

  private async send(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.defaultHeaders,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    const finalInit: RequestInit = { ...init, headers };
    if (this.timeoutMs > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await this.fetchImpl(url, { ...finalInit, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    }
    return this.fetchImpl(url, finalInit);
  }

  private async toError(res: Response, url: string): Promise<InspectApiError> {
    const text = await res.text();
    let parsed: InspectErrorBody | string = text;
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (typeof json.error === 'string') {
        parsed = json as unknown as InspectErrorBody;
      }
    } catch {
      // not JSON; keep the raw text.
    }
    return new InspectApiError(res.status, parsed, url);
  }
}
