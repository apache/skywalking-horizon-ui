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
 * Read-only OAP operations surfaces:
 *   - Data retention (TTL) — `getRecordsTTL` / `getMetricsTTL` on the
 *     query port (`GET /api/oap/ttl`). All values are integer DAYS; `-1`
 *     means "no cold-stage data" on the cold-* fields.
 *   - Runtime configuration dump — `/debugging/config/dump` on the admin
 *     port (`GET /api/oap/config`). A flat key→value snapshot of OAP's
 *     resolved config; OAP masks secret values server-side (rendered as
 *     `******`) per `status.default.keywords4MaskingSecretsOfConfig`.
 * Both are surfaced under Operate as read-only diagnostics.
 */

/** OAP `RecordsTTL` — retention (days) for record-class storage.
 *  The plain fields (`normal`/`trace`/…) cover **hot + warm** for BanyanDB
 *  (already summed by the OAP-side resolver); for non-BanyanDB they're
 *  just the uniform `coreRecordDataTTL`. `cold*` is the cold-stage
 *  retention, `-1` when no cold stage is configured. */
export interface RecordsTTL {
  normal: number;
  trace: number;
  zipkinTrace: number;
  log: number;
  browserErrorLog: number;
  coldNormal: number;
  coldTrace: number;
  coldZipkinTrace: number;
  coldLog: number;
  coldBrowserErrorLog: number;
}

/** OAP `MetricsTTL` — retention (days) for metric-class storage.
 *  Same hot+warm vs cold semantics as {@link RecordsTTL}. `metadata`
 *  (service/instance/endpoint/topology inventory) is not exposed by
 *  every deployment, so it stays optional; the row is rendered only
 *  when present. Do NOT infer the storage backend directly from these
 *  fields — the BFF computes {@link OapTtlResponse.backend} once and
 *  the UI reads that. */
export interface MetricsTTL {
  metadata?: number;
  minute: number;
  hour: number;
  day: number;
  coldMinute: number;
  coldHour: number;
  coldDay: number;
}

/** Storage backend the connected OAP runs on, as far as the TTL probe
 *  can tell. `banyandb` enables the cold-stage UI affordances (the
 *  topbar Cold pill, the TTL page's cold pane); `other` hides them.
 *  `unknown` is the conservative result when OAP is unreachable or the
 *  probe hasn't landed yet. */
export type OapBackend = 'banyandb' | 'other' | 'unknown';

/** One stage's per-class retention in days. Mirrors {@link RecordsTTL}
 *  / {@link MetricsTTL} but flattened into a single "stage" so the UI
 *  can render hot+warm and cold with one component shape. */
export interface TtlStageBreakdown {
  records: {
    normal: number;
    trace: number;
    zipkinTrace: number;
    log: number;
    browserErrorLog: number;
  };
  metrics: {
    metadata?: number;
    minute: number;
    hour: number;
    day: number;
  };
}

/** Wire shape of `GET /api/oap/ttl`. Never throws on an unreachable OAP
 *  — `reachable: false` + `error` carries the diagnostic so the page can
 *  render a degraded state instead of a hard failure.
 *
 *  `backend` and `stages` are derived from `records`/`metrics` by the
 *  BFF; both are present when `reachable === true`. `stages.cold` is
 *  `null` when no `cold*` field is configured (covers non-BanyanDB
 *  always, and BanyanDB without a cold lifecycle stage). */
export interface OapTtlResponse {
  reachable: boolean;
  error?: string;
  records?: RecordsTTL;
  metrics?: MetricsTTL;
  backend?: OapBackend;
  stages?: {
    /** Hot + warm — queried by default. */
    hot: TtlStageBreakdown;
    /** Cold — opt-in per query via `Duration.coldStage: true`. `null`
     *  when no cold stage is configured for any class. */
    cold: TtlStageBreakdown | null;
  };
}

/** A single resolved config key→value from `/debugging/config/dump`. */
export interface OapConfigEntry {
  /** Dotted key, e.g. `core.default.restPort`. */
  key: string;
  /** Resolved value; secrets are masked to `******` by OAP. */
  value: string;
  /** First dotted segment (`core`, `storage`, …) — the owning module.
   *  Pre-split on the BFF so the UI can group without re-parsing. */
  module: string;
}

/** Wire shape of `GET /api/oap/config`. Entries are sorted by key. */
export interface OapConfigResponse {
  reachable: boolean;
  error?: string;
  /** Admin URL the dump was read from (`oap.adminUrl`). */
  adminUrl: string;
  entries: OapConfigEntry[];
  generatedAt: number;
}
