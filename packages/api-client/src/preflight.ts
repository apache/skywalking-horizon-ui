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
 * Wire shape for `GET /api/preflight` — a REACHABILITY check of each
 * OAP admin feature Horizon depends on. Drives the admin-port section
 * of the Cluster Status page and the per-page warning headers on
 * admin-host routes (DSL Management, Live Debugger, Dump, OAL viewer,
 * Inspect, dashboard templates).
 *
 * Health = `reachable`, NOT `enabled`. Each feature declares the
 * relative admin REST path it actually calls; the BFF fires a safe GET
 * at that path and reports whether the feature responds. A 404 (module
 * selector off, renamed, or absent in a fork) reads as unreachable —
 * an honest, release-agnostic signal. `enabled` (the config-dump
 * prefix) is kept only as an informational "the upstream release
 * advertises this selector" footnote, never as the health verdict.
 *
 * `adminReachable === false` means the admin host itself is down
 * (network, port not exposed, OAP not started); every feature is then
 * reported `reachable: false`. The operator's first move is to fix the
 * network / port exposure, not to flip selectors on.
 */

export interface PreflightModule {
  /** OAP module name as it appears in the config-dump key prefix. */
  name: string;
  /** The env var that toggles this module's selector on OAP. */
  envVar: string;
  /** True when horizon depends on this module being reachable. */
  required: boolean;
  /** The relative admin REST path the BFF GETs to test reachability. */
  probePath: string;
  /**
   * THE health signal: true iff the safe GET on `probePath` responded
   * (any status except 404 / 5xx / network error). `null` = not probed
   * (e.g. ui_template in readonly mode — Horizon never calls it).
   */
  reachable: boolean | null;
  /**
   * Informational footnote only: the upstream config dump carries a key
   * under this module's prefix. Release-specific; NOT a health verdict.
   */
  enabled: boolean;
  /** What part of horizon breaks when this feature is unreachable. */
  affects: string;
}

export interface PreflightResult {
  adminUrl: string;
  /** True iff `/debugging/config/dump` responded 2xx (admin port up). */
  adminReachable: boolean;
  /** Short reason when `adminReachable` is false. */
  adminError?: string;
  /**
   * Active template mode. In `readonly` the ui_template feature is not
   * probed (Horizon serves bundled templates) and its row reads "n/a".
   */
  templatesMode: 'live' | 'readonly';
  modules: PreflightModule[];
  /** Total keys in the dump. Diagnostic only. */
  dumpKeyCount: number;
  generatedAt: number;
}
