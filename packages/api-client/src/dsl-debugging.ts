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
 * DSL live-debugger client — `/dsl-debugging/*` endpoints, typed against
 * the **as-built** wire emitted by `DSLDebuggingRestHandler.java` on the
 * `swip-13-dsl-debugger` branch. The wire shape was rewritten upstream
 * (commits 4275f61df5 / 0e4058614c / 6f2db069a0): records now carry an
 * envelope (`startedAtMs`, `dsl`, `rule`) plus a per-execution
 * `samples[]` array, and the per-DSL stage vocabulary collapsed to five
 * unified sample types (`input | filter | function | aggregation |
 * output`).
 *
 *   POST   /dsl-debugging/session?catalog=&name=&ruleName=&clientId=
 *                                 [&granularity=]
 *                                 body (optional JSON):
 *                                 { recordCap?, retentionMillis?,
 *                                   granularity? }
 *   GET    /dsl-debugging/session/{id}
 *   POST   /dsl-debugging/session/{id}/stop
 *   GET    /dsl-debugging/sessions             — JSON object, not NDJSON
 *   GET    /dsl-debugging/status               — 5-field health snapshot
 *
 * Notable wire facts:
 * - Inputs are query params; the optional JSON body carries
 *   `recordCap` / `retentionMillis` / `granularity` overrides.
 *   `granularity` query param wins over body.
 * - The session response carries top-level `ruleKey` + `capturedAt`,
 *   per-record `startedAtMs` + `dsl` + `rule` envelope, and per-record
 *   `samples[]` whose entries discriminate via `type`.
 * - Per-record `contentHash` was removed; the verbatim `dsl` string
 *   carries hot-update awareness instead.
 * - `priorCleanup` is now a structured object `{local, peers[]}`, not a
 *   flat array.
 * - Peer install ack values are UPPERCASE: `INSTALLED | NOT_LOCAL |
 *   FAILED`.
 * - Session-start can fail with `cluster_view_split` (HTTP 421) when
 *   the cluster's view of the rule disagrees across nodes.
 */

import { RuntimeRuleApiError, type ApplyResult } from './types.js';
import type { FetchLike } from './runtime-rule.js';

/** Debug-session catalog — every wire name accepted by the handler.
 *  Matches `Catalog.java` enum's `wireName` values. */
export type DebugCatalog = 'otel-rules' | 'log-mal-rules' | 'telegraf-rules' | 'lal' | 'oal';

export const DEBUG_CATALOGS: readonly DebugCatalog[] = [
  'otel-rules',
  'log-mal-rules',
  'telegraf-rules',
  'lal',
  'oal',
] as const;

export function isDebugCatalog(value: unknown): value is DebugCatalog {
  return typeof value === 'string' && (DEBUG_CATALOGS as readonly string[]).includes(value);
}

/** Query-param inputs (mandatory) for `POST /dsl-debugging/session`. */
export interface StartSessionQuery {
  /** Stable per-debug-context UUID. UI mints one per browser tab /
   *  debugger widget into sessionStorage and reuses it across polls. */
  clientId: string;
  catalog: DebugCatalog;
  /** For LAL: rule file name — the upstream allows either with or
   *  without an extension; runtime-rule-applied LAL uses the rule
   *  name directly.
   *  For MAL: the rule's `name` from `/runtime/rule/list`.
   *  For OAL: source class name (e.g. `Endpoint`, `ServiceRelation`). */
  name: string;
  /** For LAL: the rule within the file (or the rule name for
   *  runtime-rule LAL).
   *  For MAL: the metric's full name (matches the holder lookup key).
   *  For OAL: the source class name (same value as `name`). */
  ruleName: string;
  /** Per-DSL capture granularity. Currently only LAL distinguishes
   *  block vs statement; MAL/OAL ignore the flag server-side.
   *  Defaults to `block`. */
  granularity?: Granularity;
}

/** Mirror of OAP's `SessionLimits.MAX_RECORD_CAP` — both default and
 *  hard ceiling for `recordCap` on `POST /dsl-debugging/session`.
 *  Studio's BFF rejects requests above this with `400
 *  invalid_recordCap` before the OAP round-trip; UI inputs bound to
 *  the same value. Keep in sync with `SessionLimits.java` upstream. */
export const MAX_RECORD_CAP = 100;

/** Mirror of OAP's `SessionLimits.MAX_RETENTION_MILLIS` — 1 hour
 *  hard cap on per-session retention windows. */
export const MAX_RETENTION_MILLIS = 60 * 60 * 1000;

/** Optional JSON body for `POST /dsl-debugging/session`. */
export interface StartSessionBody {
  /** Default + hard cap 100 (`SessionLimits.MAX_RECORD_CAP`). Session
   *  moves to `captured` once this many records have been appended.
   *  OAP rejects `recordCap > 100` with `400 invalid_limits`; the BFF
   *  short-circuits the same way before the OAP round-trip. */
  recordCap?: number;
  /** Default 5 min, max 1 h (3 600 000 ms). Wall-clock retention
   *  before the session is reaped. */
  retentionMillis?: number;
  /** Body fallback for granularity — query param wins when set. */
  granularity?: Granularity;
}

/** LAL-only knob — does the recorder emit per-statement records or
 *  just block-level ones. Server query param wins over body. */
export type Granularity = 'block' | 'statement';

export const GRANULARITIES: readonly Granularity[] = ['block', 'statement'] as const;

export function isGranularity(v: unknown): v is Granularity {
  return v === 'block' || v === 'statement';
}

export type StartSessionArgs = StartSessionQuery & StartSessionBody;

/** Wire-side ack from the `InstallDebugSession` fan-out. The first
 *  five come from the proto enum (`InstallState`); `FAILED` is
 *  appended by the receiving node when the peer call itself failed
 *  (timeout, RPC error). */
export type PeerInstallAckState =
  | 'INSTALLED'
  | 'NOT_LOCAL'
  | 'ALREADY_INSTALLED'
  | 'REJECTED'
  | 'TOO_MANY_SESSIONS'
  | 'FAILED';

/** Per-peer install ack. Values are UPPERCASE in the wire. */
export interface PeerInstallAck {
  peer: string;
  /** Set when the peer responded. */
  nodeId?: string;
  ack: PeerInstallAckState;
  detail?: string;
}

/** At-a-glance "session live on N of M OAPs" summary attached to the
 *  start-session response. `total` counts the receiving node + every
 *  reachable peer; `created` counts those that returned `INSTALLED`
 *  or `ALREADY_INSTALLED`. Per-peer detail lives in `peers[]`. */
export interface InstallSummary {
  created: number;
  total: number;
}

/** Local node's prior-cleanup outcome — the broadcast also runs locally
 *  and the receiving node reports the count of prior sessions it
 *  terminated for the same `clientId`. */
export interface LocalPriorCleanup {
  nodeId: string;
  stoppedCount: number;
  stoppedSessionIds: string[];
}

/** Per-peer prior-cleanup outcome from the `StopByClientId` fan-out. */
export interface PeerPriorCleanup {
  peer: string;
  /** Set on success. */
  nodeId?: string;
  stoppedCount?: number;
  stoppedSessionIds?: string[];
  /** Set instead of the success fields when the peer call failed. */
  ack?: 'failed';
  detail?: string;
}

/** Cluster-wide prior-cleanup report. The local slice is always present;
 *  `peers[]` is one entry per known peer (may be empty in single-node). */
export interface PriorCleanup {
  local: LocalPriorCleanup;
  peers: PeerPriorCleanup[];
}

export interface RuleKey {
  catalog: DebugCatalog;
  name: string;
  ruleName: string;
}

export interface StartSessionResponse {
  sessionId: string;
  clientId: string;
  ruleKey: RuleKey;
  /** Unix-ms. */
  createdAt: number;
  /** Unix-ms. The session is reaped at this wall-clock. */
  retentionDeadline: number;
  /** Echoed back from the request (or the server default `block`). */
  granularity: Granularity;
  /** True when the receiving node had the rule loaded and bound a
   *  recorder locally. False on a router-only node where the install
   *  was a pure fan-out. */
  localInstalled: boolean;
  /** "session live on N of M OAPs" rollup — `created` counts nodes
   *  whose ack was `INSTALLED` / `ALREADY_INSTALLED`; `total` is
   *  receiving node + every reachable peer (1 + peers.length). */
  installed: InstallSummary;
  peers: PeerInstallAck[];
  priorCleanup: PriorCleanup;
}

/** The five unified sample types. The rule's static stage vocabulary
 *  (per-DSL block names like `meterEmit`, `extractor`, `aggregation`)
 *  collapsed into these on the wire — each DSL only emits a subset:
 *
 *  - MAL: `input | filter | function | output`
 *  - LAL: `input | filter | function | output`
 *  - OAL: `input | filter | function | aggregation | output` */
export type SampleType = 'input' | 'filter' | 'function' | 'aggregation' | 'output';

export const SAMPLE_TYPES: readonly SampleType[] = [
  'input',
  'filter',
  'function',
  'aggregation',
  'output',
] as const;

/** A single MAL `Sample` row inside a SampleFamily — what the upstream
 *  ELSampleFamilyDebugDump.toJson surfaces per row. */
export interface MalSampleRow {
  name: string;
  labels: Record<string, string>;
  /** Numeric value as JSON number (Long / Double / counter). */
  value: number;
  /** Unix-ms. */
  timestamp: number;
}

/** MAL non-output payload — the captured `SampleFamily.toJson()`.
 *  `families` only appears on the file-level filter probe, which
 *  captures the full multi-family input map. The flat case (`samples` +
 *  `items`) is the per-stage shape every chain method emits. */
export interface MalSamplesPayload {
  /** Set on the file-level filter probe only — count of source
   *  families that fed this filter. */
  families?: number;
  /** Sample-row count. `0` together with `empty: true` means the
   *  family was empty (probe still captured for visibility). */
  samples?: number;
  empty?: boolean;
  /** Either flat sample rows (chain-method probes) or nested
   *  per-family arrays (file-level filter probe). The recorder picks
   *  the shape based on which probe fired; clients must check. */
  items?: MalSampleRow[] | MalSamplesPayload[];
}

/** MAL `output`-type payload (the `appendMeterEmit` probe) — the
 *  materialised metric ready for L1 push. Per OAP's
 *  `MALDebugRecorderImpl.meterEmitPayload`: always `metric`, `entity`,
 *  `valueType`, `timeBucket`; `value` only when the holder type is
 *  recognised (LongValueHolder / IntValueHolder / DoubleValueHolder /
 *  LabeledValueHolder). Studio renders whatever's present and never
 *  infers from upstream stages. */
export interface MalOutputPayload {
  metric: string;
  /** `MeterEntity#toString()` — operator-readable form of the entity
   *  the metric is bound to (scope, service / instance / endpoint
   *  names, layer, attrs). */
  entity: string;
  /** Resolved meter function name (e.g. `sum`, `avg`, `histogram`,
   *  `avgLabeled`) — surfaced via the `@MeterFunction` annotation
   *  walk so the operator doesn't see the generated subclass name. */
  valueType: string;
  /** Time bucket of the emit (yyyyMMddHHmm). */
  timeBucket: number;
  /** Materialised reading. Three shapes per the recorder's holder
   *  switch:
   *  - `number` — scalar holders (Sum / Avg / Max / Min / Latest /
   *    SumPerMin / CPM …; finite doubles).
   *  - `string` — non-finite doubles serialised as `"NaN"`,
   *    `"Infinity"`, `"-Infinity"` so the wire stays valid JSON.
   *  - `Record<string, number>` — labeled metrics (`*Labeled`) and
   *    histogram-percentile functions emit a `DataTable`; keys are
   *    label combos for `*Labeled`, `p=<rank>` entries for percentile
   *    functions. */
  value?: number | string | Record<string, number>;
}

/** LAL `LogData.toJson()` — what the input probe sees on the way in. */
export interface LalLogDataInput {
  type: 'LogData';
  timestamp?: number;
  service?: string;
  serviceInstance?: string;
  endpoint?: string;
  layer?: string;
  tags?: { key: string; value: string }[];
  body?: {
    contentType?: string;
    format?: 'TEXT' | 'YAML' | 'JSON';
    text?: string;
  };
  /** Trace identifiers — only when the agent attached them. */
  traceId?: string;
  segmentId?: string;
  spanId?: number;
  /** Open shape — Envoy access-log path materialises as `Message` /
   *  alternative inputs that the framework's typed dispatcher
   *  serialises. */
  [key: string]: unknown;
}

/** LAL `Message`-class input (gRPC envelope). The framework's typed
 *  dispatcher captures whatever the rule's input type is — we model
 *  the open-payload case here. */
export interface LalMessageInput {
  type: 'Message';
  /** Class name + serialisable proto fields, captured opaquely. */
  [key: string]: unknown;
}

/** Tagged-union LAL input. `[type=LogData]` is the common case. */
export type LalInput = LalLogDataInput | LalMessageInput | { type: string; [k: string]: unknown };

/** LAL `LogBuilder.outputToJson()` — the DB-bound row the rule has
 *  built so far. Stable shape across stages because the builder is
 *  cached on `bindInput`. */
export interface LalLogBuilderOutput {
  type: 'LogBuilder';
  name?: string;
  service?: string;
  serviceInstance?: string;
  endpoint?: string;
  layer?: string;
  traceId?: string;
  segmentId?: string;
  spanId?: number;
  timestamp?: number;
  contentType?: string;
  content?: string;
  /** Merged-tag view: `original` from input, `lal-added` from the
   *  rule, `lal-override` when the rule's key collides with an input
   *  tag (runtime concatenates rather than replaces). */
  tags?: LalLogBuilderTag[];
  /** Open shape — EnvoyAccessLogBuilder etc. add custom fields. */
  [key: string]: unknown;
}

export interface LalLogBuilderTag {
  key: string;
  value: string;
  status?: 'original' | 'lal-added' | 'lal-override';
}

/** LAL `Message`-typed builder (e.g. EnvoyAccessLogBuilder). */
export interface LalMessageBuilderOutput {
  type: string;
  [key: string]: unknown;
}

export type LalOutput = LalLogBuilderOutput | LalMessageBuilderOutput;

/** LAL sample payload — every stage carries the same envelope. The
 *  input probe populates `input`; bindInput-onwards probes populate
 *  `output`. Either may be present (rare double-bind cases). */
export interface LalSamplePayload {
  /** True when the rule body called `abort()`. */
  aborted?: boolean;
  /** True when `parsed` slots have been populated by parser probes. */
  hasParsed?: boolean;
  /** Convenience list of keys the parser ran (extractor reads). */
  parsedKeys?: string[];
  input?: LalInput;
  output?: LalOutput;
}

/** OAL input / filter payload — the source object's columns. The
 *  upstream recorder calls `source.toJson()`; the column set is per
 *  source class. */
export interface OalSourcePayload {
  type: string;
  /** Column-bag — source-class-specific. The first row is `scope:
   *  number` (the OAL scope ordinal); other rows are operator-readable
   *  fields like `entityId`, `timeBucket`, `sourceServiceName`, etc. */
  fields: { scope?: number; entityId?: string; timeBucket?: number; [key: string]: unknown };
}

/** OAL function / aggregation / output payload — the materialised
 *  metric class's columns at this probe. The shape is `Metrics#toJson`
 *  so the field set is per-metric (CPM has `count/total/value`,
 *  histogram-style metrics have buckets, etc.). */
export interface OalMetricsPayload {
  type: string;
  timeBucket?: number;
  lastUpdateTimestamp?: number;
  id?: string;
  total?: number;
  value?: number;
  /** Open shape — per-metric extra columns (count, summation,
   *  histogram dataset, …). */
  [key: string]: unknown;
}

/** Union of every per-DSL payload a sample's `payload` can carry. */
export type SamplePayload =
  | MalSamplesPayload
  | MalOutputPayload
  | LalSamplePayload
  | OalSourcePayload
  | OalMetricsPayload
  | Record<string, unknown>;

/** A single captured probe sample — one execution step of the DSL
 *  pipeline. Multiple samples sit inside one `SessionRecord` and
 *  represent the in-order trace of one rule execution.
 *
 *  - `type`: the unified five-state lifecycle position.
 *  - `sourceText`: verbatim DSL fragment from ANTLR (or empty for
 *     LAL probes that don't correspond to a single text slice).
 *  - `continueOn`: did the pipeline continue past this probe? `false`
 *     on rejected filter branches, on `abort()` calls, on builder
 *     failures.
 *  - `payload`: per-DSL shape — see the per-DSL types above.
 *  - `sourceLine`: 1-based line number in the rule body. Omitted when
 *     0 / not applicable (block-level LAL probes, MAL chain stages on
 *     a one-liner rule).
 *  - `reason`: human-readable explanation of WHY this step stopped the
 *     pipeline (a parse exception, a non-matching regexp, an input-type
 *     mismatch), paired with `continueOn: false`. Optional — LAL-only
 *     today, and absent from OAP versions before it was added, so the
 *     UI must treat its absence as "no reason available". */
export interface SessionSample {
  type: SampleType;
  sourceText: string;
  continueOn: boolean;
  payload: SamplePayload;
  sourceLine?: number;
  reason?: string;
}

/** Catalog-specific structured rule metadata. The recorder fills in
 *  whatever it has — common fields:
 *  - all DSLs:  `ruleName`
 *  - OAL:       `sourceLine` (the OAL source statement's line in the
 *               .oal file)
 *  - MAL:       `metricPrefix`, `name`, `filter`, `exp`, `expSuffix`
 *  - LAL:       `ruleName` only
 *  Open string-keyed bag — Studio reads selectively. */
export interface SessionRecordRule {
  ruleName: string;
  sourceLine?: string;
  /** Open: MAL emits multi-field rule metadata (filter, exp, …). */
  [key: string]: string | undefined;
}

/** One captured execution of the rule. The verbatim `dsl` is the
 *  rule source as it stood at capture time — Studio renders this
 *  directly in the per-record card and the foldable LAL source pane,
 *  so hot-update edits show up record-by-record without an extra
 *  fetch (each record carries its own snapshot). */
export interface SessionRecord {
  /** Unix-ms when the execution started on the receiving node. */
  startedAtMs: number;
  /** Verbatim rule source — multi-line, exactly as the holder owned
   *  it when this execution fired. */
  dsl: string;
  rule: SessionRecordRule;
  samples: SessionSample[];
}

export type NodeStatus = 'ok' | 'captured' | 'not_local' | 'unreachable';

export interface NodeSlice {
  /** Set on the local slice and on successful peer slices. */
  nodeId?: string;
  /** Set on peer slices (the gRPC peer address); always present for
   *  unreachable peers, may also appear on healthy ones. */
  peer?: string;
  status: NodeStatus;
  captured?: boolean;
  totalBytes?: number;
  records: SessionRecord[];
  /** Set when `status === 'unreachable'`. */
  detail?: string;
}

export interface SessionResponse {
  sessionId: string;
  /** Unix-ms when the receiving node snapshotted the slice. */
  capturedAt: number;
  /** Echo of the install-time `RuleKey` — omitted when the local
   *  slice is null (post-stop polls / unknown session). */
  ruleKey?: RuleKey;
  nodes: NodeSlice[];
}

export interface StopPeerOutcome {
  peer: string;
  nodeId?: string;
  stopped?: boolean;
  ack?: 'failed';
  detail?: string;
}

export interface StopSessionResponse {
  sessionId: string;
  localStopped: boolean;
  peers: StopPeerOutcome[];
}

export interface ActiveSessionRow {
  sessionId: string;
  clientId: string;
  ruleKey: RuleKey;
  createdAt: number;
  retentionDeadline: number;
  captured: boolean;
  totalBytes: number;
}

export interface ActiveSessionsResponse {
  sessions: ActiveSessionRow[];
  count: number;
}

export interface DslDebuggingStatus {
  module: string;
  phase: string;
  nodeId: string;
  injectionEnabled: boolean;
  activeSessions: number;
}

/** Known `code` values the handler emits. Open string for forward
 *  compatibility — the server may extend this enum. */
export type DebugErrorCode =
  | 'injection_disabled'
  | 'invalid_catalog'
  | 'invalid_limits'
  | 'invalid_granularity'
  | 'missing_param'
  | 'rule_not_found'
  | 'session_not_found'
  | 'registry_misconfigured'
  | 'source_not_found'
  | 'missing_source'
  | 'too_many_sessions'
  | 'cluster_view_split'
  | (string & {});

export interface DebugErrorBody {
  status: 'error';
  code: DebugErrorCode;
  message: string;
}

export interface DslDebuggingClientOptions {
  adminUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class DslDebuggingClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: DslDebuggingClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = options.adminUrl.replace(/\/$/, '');
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /** `POST /dsl-debugging/session?catalog=&name=&ruleName=&clientId=
   *  [&granularity=]`, optional JSON body with `recordCap` /
   *  `retentionMillis` / `granularity`. The query param wins over the
   *  body for granularity (matches upstream resolution order). */
  async startSession(args: StartSessionArgs): Promise<StartSessionResponse> {
    const params = new URLSearchParams({
      catalog: args.catalog,
      name: args.name,
      ruleName: args.ruleName,
      clientId: args.clientId,
    });
    if (args.granularity !== undefined) params.set('granularity', args.granularity);
    const url = `${this.base}/dsl-debugging/session?${params.toString()}`;
    const body: StartSessionBody = {};
    if (args.recordCap !== undefined) body.recordCap = args.recordCap;
    if (args.retentionMillis !== undefined) body.retentionMillis = args.retentionMillis;
    const hasBody = Object.keys(body).length > 0;
    const init: RequestInit = {
      method: 'POST',
      ...(hasBody
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    };
    const res = await this.send(url, init);
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as StartSessionResponse;
  }

  /** `GET /dsl-debugging/session/{id}`. Returns `null` on `404
   *  session_not_found`; live polls return a normal envelope where
   *  the local slice may be `status: "not_local"` after a stop. */
  async getSession(id: string): Promise<SessionResponse | null> {
    const url = `${this.base}/dsl-debugging/session/${encodeURIComponent(id)}`;
    const res = await this.send(url, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as SessionResponse;
  }

  /** `POST /dsl-debugging/session/{id}/stop` — idempotent. */
  async stopSession(id: string): Promise<StopSessionResponse> {
    const url = `${this.base}/dsl-debugging/session/${encodeURIComponent(id)}/stop`;
    const res = await this.send(url, { method: 'POST' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as StopSessionResponse;
  }

  /** `GET /dsl-debugging/sessions` — JSON object, not NDJSON. */
  async listSessions(): Promise<ActiveSessionsResponse> {
    const url = `${this.base}/dsl-debugging/sessions`;
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as ActiveSessionsResponse;
  }

  /** `GET /dsl-debugging/status` — per-node 5-field health snapshot. */
  async getStatus(): Promise<DslDebuggingStatus> {
    const url = `${this.base}/dsl-debugging/status`;
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as DslDebuggingStatus;
  }

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

  private async toError(res: Response, url: string): Promise<RuntimeRuleApiError> {
    const text = await res.text();
    let parsed: ApplyResult | string = text;
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      // Accept either the legacy `{ applyStatus, message }` envelope
      // (runtime-rule pipeline) or the `{ status, code, message }`
      // envelope (dsl-debugging / runtime-oal). Downstream `outcomeOf`
      // helpers switch on `code` or `applyStatus`.
      if (typeof json.applyStatus === 'string' && typeof json.message === 'string') {
        parsed = json as unknown as ApplyResult;
      } else if (
        json.status === 'error' &&
        typeof json.code === 'string' &&
        typeof json.message === 'string'
      ) {
        parsed = json as unknown as ApplyResult;
      }
    } catch {
      // not JSON; keep the raw text.
    }
    return new RuntimeRuleApiError(res.status, parsed, url);
  }
}
