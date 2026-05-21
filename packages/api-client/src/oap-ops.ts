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
 *  cold* fields are `-1` when the backend has no cold stage. */
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
 *  `metadata` (TTL of the service/instance/endpoint/topology inventory)
 *  is not exposed by every OAP deployment, so it stays optional; the
 *  TTL query does not request it (matches booster) and the UI renders
 *  the row only when present. `cold*` is the cold-stage retention, `-1`
 *  when no cold stage is configured. Do NOT infer the storage backend
 *  from these fields — read the wire values verbatim and display them. */
export interface MetricsTTL {
  metadata?: number;
  minute: number;
  hour: number;
  day: number;
  coldMinute: number;
  coldHour: number;
  coldDay: number;
}

/** Wire shape of `GET /api/oap/ttl`. Never throws on an unreachable OAP
 *  — `reachable: false` + `error` carries the diagnostic so the page can
 *  render a degraded state instead of a hard failure. */
export interface OapTtlResponse {
  reachable: boolean;
  error?: string;
  records?: RecordsTTL;
  metrics?: MetricsTTL;
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
