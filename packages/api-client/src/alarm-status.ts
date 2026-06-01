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
 * Typed wrapper for OAP admin's `/status/alarm/*` endpoints (exposed
 * by `AlarmStatusQueryHandler` in skywalking core). These are the
 * authoritative source for **alarm rule** definitions and per-entity
 * runtime state — distinct from `/runtime/rule/*`, which only covers
 * MAL/LAL/OTEL catalogs (alarm rules live in `alarm-settings.yml`
 * and are NOT in those catalogs).
 *
 * Every endpoint returns a `ClusterAlarmStatus` envelope that fans
 * out across every OAP node in the cluster. Per-node `errorMsg` is
 * the node's read-side failure (gRPC timeout, etc.) — `null` means
 * the node responded. `status` is the parsed payload (rule list /
 * detail / running context). On a sole-node OAP the envelope still
 * has a one-entry `oapInstances` array.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface AlarmStatusClientOptions {
  /** OAP admin URL, e.g. `http://oap:17128`. No trailing slash. */
  adminUrl: string;
  /** Optional fetch override (tests). */
  fetch?: FetchLike;
  /** Optional default headers (basic auth, RPC token, etc.). */
  headers?: Record<string, string>;
  /** Default per-call timeout in ms. `0` disables. */
  timeoutMs?: number;
}

// ── Wire types (mirror oap-server AlarmRule* + ClusterAlarmStatus) ──

/** Per-OAP-node envelope inside a `ClusterAlarmStatus`. */
export interface InstanceAlarmStatus<T> {
  /** gRPC address of the OAP node — `host:port` for peers, `Self()`
   *  literal for the node serving the HTTP request. */
  address: string;
  /** Failure reason for THIS node only. Null/absent when the node
   *  responded successfully (status field is then populated) — OAP
   *  omits the key entirely on success rather than sending `null`. */
  errorMsg?: string | null;
  status: T | null;
}

export interface ClusterAlarmStatus<T> {
  oapInstances: InstanceAlarmStatus<T>[];
}

/** Returned by `/status/alarm/rules` — only rule IDs per node. */
export interface AlarmRuleList {
  ruleList: Array<{ id: string }>;
}

/** Returned by `/status/alarm/{ruleId}` — full rule body + the set of
 *  entities the rule has fired against on this node. */
export interface AlarmRuleDetail {
  ruleId: string;
  expression: string;
  /** Number of MINUTE buckets the rule evaluates over. */
  period: number;
  /** Minutes of silence after a fire before re-evaluating. */
  silencePeriod: number;
  /** Minutes of clean observation needed before a recovery is
   *  emitted. */
  recoveryObservationPeriod: number;
  additionalPeriod: number;
  includeEntityNames: string[];
  excludeEntityNames: string[];
  includeEntityNamesRegex?: string;
  excludeEntityNamesRegex?: string;
  runningEntities: Array<{
    scope: string;
    name: string;
    formattedMessage: string;
  }>;
  tags: Array<{ key: string; value: string }>;
  hooks: string[];
  /** OAP metric names the rule's expression depends on — derived by
   *  OAP's MQE visitor at rule load. */
  includeMetrics: string[];
}

/** One raw metric reading inside a `windowValues` bucket. `value` is a
 *  string on the wire (OAP serialises the metric's stored value as-is). */
export interface AlarmWindowMetric {
  name: string;
  timeBucket: number;
  value: string;
}

/** One bucket of the rule's sliding evaluation window. `index` runs
 *  0..size-1; `metrics` is empty for buckets that received no data. */
export interface AlarmWindowBucket {
  index: number;
  metrics: AlarmWindowMetric[];
}

/** One value point in a parsed MQE snapshot series. */
export interface AlarmMqeSnapshotValue {
  id: string;
  doubleValue: number;
  isEmptyValue: boolean;
}

/** A single MQE series as produced by the alarm checker. Lives inside
 *  the `mqeMetricsSnapshot` map JSON-encoded per metric — callers parse
 *  the string value into `AlarmMqeSnapshotSeries[]`. */
export interface AlarmMqeSnapshotSeries {
  metric: { labels: Array<{ key: string; value: string }> };
  values: AlarmMqeSnapshotValue[];
}

/** Returned by `/status/alarm/{ruleId}/{entityName}` — the rule's
 *  running window state for ONE entity, per OAP node. Only the node
 *  actually evaluating the entity returns a populated body; other nodes
 *  return a stub (`size: 0`, empty `windowValues`, `lastAlarmTime: 0`)
 *  and OMIT the evaluation-only fields (`currentState`, `entityName`,
 *  `mqeMetricsSnapshot`, …) — hence the optionals. */
export interface AlarmRunningContext {
  ruleId: string;
  expression: string;
  /** Window end as an OAP-server-local datetime string. Absent on a
   *  node that isn't evaluating this entity. */
  endTime?: string;
  additionalPeriod: number;
  /** Window size = `period + additionalPeriod`. `0` on a non-evaluating
   *  node. */
  size: number;
  silencePeriod?: number;
  recoveryObservationPeriod?: number;
  /** Silence countdown; `-1` means not running. */
  silenceCountdown: number;
  recoveryObservationCountdown: number;
  /** e.g. `FIRING` / `SILENCED_FIRING` / `RECOVERY_OBSERVATION`. Absent
   *  when this node isn't evaluating the entity. */
  currentState?: string;
  entityName?: string;
  windowValues: AlarmWindowBucket[];
  /** Metric name → JSON-encoded `AlarmMqeSnapshotSeries[]` (the data the
   *  expression was evaluated against this tick). */
  mqeMetricsSnapshot?: Record<string, string>;
  /** Epoch-ms of the last fire; `0` once recovered. Wire type is loose
   *  (number or numeric string), so callers coerce. */
  lastAlarmTime: number | string;
  lastAlarmMessage?: string;
  lastAlarmMqeMetricsSnapshot?: Record<string, string>;
}

export class AlarmStatusApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body?: string;
  constructor(status: number, url: string, body?: string) {
    super(`AlarmStatus ${status} ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    this.name = 'AlarmStatusApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class AlarmStatusClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: AlarmStatusClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = options.adminUrl.replace(/\/$/, '');
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /** `GET /status/alarm/rules` — every loaded rule, per OAP node. */
  async listRules(): Promise<ClusterAlarmStatus<AlarmRuleList>> {
    return this.json<ClusterAlarmStatus<AlarmRuleList>>('/status/alarm/rules');
  }

  /** `GET /status/alarm/{ruleId}` — full body for one rule, per OAP
   *  node. */
  async ruleDetail(ruleId: string): Promise<ClusterAlarmStatus<AlarmRuleDetail>> {
    return this.json<ClusterAlarmStatus<AlarmRuleDetail>>(
      `/status/alarm/${encodeURIComponent(ruleId)}`,
    );
  }

  /** `GET /status/alarm/{ruleId}/{entityName}` — running window state
   *  for one entity. */
  async ruleContext(
    ruleId: string,
    entityName: string,
  ): Promise<ClusterAlarmStatus<AlarmRunningContext>> {
    return this.json<ClusterAlarmStatus<AlarmRunningContext>>(
      `/status/alarm/${encodeURIComponent(ruleId)}/${encodeURIComponent(entityName)}`,
    );
  }

  private async json<T>(path: string): Promise<T> {
    const url = `${this.base}${path}`;
    const init: RequestInit = {
      method: 'GET',
      headers: { Accept: 'application/json', ...this.defaultHeaders },
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (this.timeoutMs > 0) {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      init.signal = ctrl.signal;
    }
    try {
      const res = await this.fetchImpl(url, init);
      if (!res.ok) {
        const body = await res.text();
        throw new AlarmStatusApiError(res.status, url, body);
      }
      return (await res.json()) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
