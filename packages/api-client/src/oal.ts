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
 * Read-only OAL listing — `GET /runtime/oal/*` introduced by SWIP-13.
 *
 * The actual implementation on the `swip-13-dsl-debugger` branch ships a
 * **per-source-dispatcher** listing, not a per-rule one — the OAL debugger
 * targets one source (e.g. `Endpoint`) and every metric routed off that
 * source captures together. So the listing is shaped to match: one row per
 * dispatcher, with the dispatcher's full metric set inline.
 *
 * File metadata is also intentionally minimal — `/files` returns just file
 * names; `/files/{name}` returns the raw `.oal` text as `text/plain`.
 *
 * Read-only by design. OAL hot-update is upstream-deferred; the path
 * prefix `/runtime/oal/*` is reserved for future write endpoints.
 */

import { RuntimeRuleApiError, type ApplyResult } from './types.js';
import type { FetchLike } from './runtime-rule.js';

export interface OalFilesResponse {
  /** OAL file names (with extension), e.g. `core.oal`. */
  files: string[];
  count: number;
}

/** One row per dispatcher in the running OAP. The OAL debugger targets a
 *  source — every metric on that source captures together. The listing
 *  endpoint emits metric names only; per-metric `status` requires the
 *  per-source detail call (`/runtime/oal/rules/{source}`). */
export interface OalSourceListing {
  /** OAL source class name without `Dispatcher` suffix, e.g. `Endpoint`. */
  source: string;
  /** Fully-qualified dispatcher class name. */
  dispatcher: string;
  /** Metric names routed off this source. */
  metrics: string[];
}

export interface OalRulesResponse {
  sources: OalSourceListing[];
  count: number;
}

/** Per-metric gate state from the per-source detail endpoint.
 *  `status: "live"` means the dispatcher's `DebugHolderProvider` has a
 *  holder ready and a session install on this metric will succeed.
 *  `no_holder` means the codegen knew the metric but no holder was
 *  bound (test mocks or dispatchers compiled before SWIP-13). */
export interface OalSourceMetricDetail {
  name: string;
  status: 'live' | 'no_holder';
}

/** Per-source detail — same `source` + `dispatcher` as the listing,
 *  but `metrics` carries per-metric `{name, status}` rather than bare
 *  strings. The wire has no source-level `status`; the rollup is
 *  derived per metric. */
export interface OalSourceDetail {
  source: string;
  dispatcher: string;
  metrics: OalSourceMetricDetail[];
}

export interface OalClientOptions {
  /** OAP admin-server URL, e.g. `http://oap:17128`. No trailing slash. */
  adminUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Typed wrapper for the four read-only OAL endpoints.
 */
export class OalClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: OalClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = options.adminUrl.replace(/\/$/, '');
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /** `GET /runtime/oal/files` — bare file-name listing. */
  async listFiles(): Promise<OalFilesResponse> {
    const url = `${this.base}/runtime/oal/files`;
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as OalFilesResponse;
  }

  /** `GET /runtime/oal/files/{name}` — returns raw `.oal` text
   *  (`text/plain`). Returns `null` when the file isn't loaded. */
  async getFileContent(name: string): Promise<string | null> {
    const url = `${this.base}/runtime/oal/files/${encodeURIComponent(name)}`;
    const res = await this.send(url, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toError(res, url);
    return await res.text();
  }

  /** `GET /runtime/oal/rules` — per-dispatcher listing for the picker. */
  async listSources(): Promise<OalRulesResponse> {
    const url = `${this.base}/runtime/oal/rules`;
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as OalRulesResponse;
  }

  /** `GET /runtime/oal/rules/{source}` — single-source detail with
   *  holder-bound status. Path param is the source class name. Returns
   *  `null` when no dispatcher owns that source. */
  async getSource(source: string): Promise<OalSourceDetail | null> {
    const url = `${this.base}/runtime/oal/rules/${encodeURIComponent(source)}`;
    const res = await this.send(url, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as OalSourceDetail;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain',
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
