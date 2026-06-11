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
 * Wire types for the BROWSER-layer "Browser Errors" tab (#6784).
 *
 * Two halves:
 *   - The error log itself — a verbatim mirror of OAP's
 *     `queryBrowserErrorLogs(BrowserErrorLogQueryCondition)` shape.
 *   - The source-map cache the BFF holds in memory to de-obfuscate those
 *     errors' stacks. Maps are NOT stored in OAP; the descriptors below
 *     describe a per-BFF-instance, intentionally-temporary cache.
 */

/** OAP `ErrorCategory` enum, verbatim. `ALL` means "no filter". */
export type BrowserErrorCategory =
  | 'ALL'
  | 'AJAX'
  | 'RESOURCE'
  | 'VUE'
  | 'PROMISE'
  | 'JS'
  | 'UNKNOWN';

/** One `BrowserErrorLog` row. Fields mirror the GraphQL type 1:1. */
export interface BrowserErrorRow {
  service: string;
  serviceVersion: string;
  /** Unix millis (OAP `time` Long). */
  time: number;
  pagePath: string;
  category: BrowserErrorCategory;
  grade: string | null;
  message: string | null;
  /** Top-level error position. OAP only populates these for the `JS`
   *  category (the `window.onerror` path); `PROMISE` / `VUE` / `AJAX`
   *  report 0 and carry their real frames inside `stack`. */
  line: number | null;
  col: number | null;
  stack: string | null;
  errorUrl: string | null;
  firstReportedError: boolean;
}

export interface BrowserErrorsQueryRequest {
  /** OAP service id (`<base64>.<digits>`). */
  serviceId?: string;
  /** Service NAME — resolved to an id server-side (mirror of the logs route). */
  service?: string;
  serviceVersionId?: string;
  pagePathId?: string;
  /** Omitted or `ALL` ⇒ no category filter. */
  category?: BrowserErrorCategory;
  page?: number;
  pageSize?: number;
  /** Rolling window in minutes, ending at "now". Ignored when an explicit
   *  `startMs` / `endMs` pair is supplied. */
  windowMinutes?: number;
  /** Absolute range as epoch milliseconds (TZ-unambiguous). The BFF renders
   *  these into OAP-server-local time using the OAP offset — send ms, not
   *  pre-formatted local strings, so the browser↔OAP timezone delta is
   *  applied correctly. */
  startMs?: number;
  endMs?: number;
}

export interface BrowserErrorsResponse {
  generatedAt: number;
  query: BrowserErrorsQueryRequest;
  /** OAP no longer returns a cross-page total for this query; the BFF
   *  reports the returned row count, same as the logs feed. */
  total: number;
  logs: BrowserErrorRow[];
  reachable: boolean;
  error?: string;
}

/** Where a hosted map came from. `upload` = held in memory only (lost on
 *  restart / evicted under budget). `mount` = backed by a file in the
 *  static `bootMountDir` (reloaded on demand, survives restarts). */
export type SourceMapOrigin = 'upload' | 'mount';

export interface SourceMapDescriptor {
  id: string;
  /** Display label — the uploaded filename, or the basename for mounts. */
  label: string;
  origin: SourceMapOrigin;
  /** Raw `.map` byte size (the unit budgets are accounted in). */
  bytes: number;
  /** Unix millis the map was added (upload time / boot-scan time). */
  addedAt: number;
  /** Unix millis of the last resolve that used this map (drives LRU). */
  lastUsedAt: number;
}

/** Snapshot of the in-memory cache + its budget, for the manager UI's
 *  usage bar and the "temporary" warning. */
export interface SourceMapUsage {
  usedBytes: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxFileCount: number;
}

export interface SourceMapListResponse {
  /** False when `sourceMaps.enabled` is off — the UI hides the controls. */
  enabled: boolean;
  maps: SourceMapDescriptor[];
  usage: SourceMapUsage;
}

export interface SourceMapUploadResponse {
  ok: boolean;
  map?: SourceMapDescriptor;
  /** `disabled` | `too_large` | `invalid_map` | `no_file`. */
  error?: string;
}

export interface ResolveRequest {
  /** Raw browser `error.stack` string — the primary source of frames. */
  stack?: string;
  /** Top-level position fallback (used when `stack` yields no frames,
   *  e.g. a `JS`-category error with only `line`/`col`). */
  line?: number;
  col?: number;
  errorUrl?: string;
  category?: BrowserErrorCategory;
  /** Id of the map the operator chose to resolve against. */
  sourceMapId: string;
}

/** One resolved stack frame: the minified position as parsed from the
 *  stack, plus the original position the map points at (null if the
 *  frame falls outside the map). */
export interface ResolvedFrame {
  generated: { file: string | null; line: number | null; col: number | null; fn: string | null };
  original:
    | { source: string | null; line: number | null; col: number | null; name: string | null }
    | null;
  /** A few lines of original source around the position, when the map
   *  carries `sourcesContent`. */
  snippet?: { startLine: number; lines: string[] } | null;
}

export interface ResolveResponse {
  ok: boolean;
  /** Echo the chosen map so the UI can show "resolved against <label>"
   *  — version-matching is the operator's call, so naming it matters. */
  sourceMapId: string;
  sourceMapLabel: string | null;
  frames: ResolvedFrame[];
  /** `disabled` | `unknown_map` | `no_input`. */
  error?: string;
}
