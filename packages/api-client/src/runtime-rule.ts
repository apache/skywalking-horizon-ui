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

import type {
  ApplyResult,
  BundledEntry,
  Catalog,
  DeleteMode,
  ListEnvelope,
  NotModified,
  RuleResponse,
  RuleSource,
  RuleStatus,
  RuleStatusResponse,
} from './types.js';
import { RuntimeRuleApiError } from './types.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RuntimeRuleClientOptions {
  /** OAP admin port URL, e.g. `http://oap:17128`. No trailing slash. */
  adminUrl: string;
  /** Optional fetch implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Optional default headers (e.g. for a forward-RPC token). */
  headers?: Record<string, string>;
  /** Default per-call timeout in ms. `0` disables. */
  timeoutMs?: number;
}

export interface AddOrUpdateArgs {
  catalog: Catalog;
  name: string;
  /** Raw YAML. */
  body: string;
  /** Default false. Required when the edit moves storage identity. */
  allowStorageChange?: boolean;
  /** Default false. Re-runs apply on byte-identical content; subsumes
   *  the prior `/fix` route. */
  force?: boolean;
}

export interface GetRuleArgs {
  catalog: Catalog;
  name: string;
  /** Default `runtime` — DAO row first, static fallback. `bundled`
   *  bypasses the DAO and returns only the static twin. */
  source?: RuleSource;
  /** Conditional fetch — if the server's ETag matches, the client
   *  returns a {@link NotModified} sentinel and saves the body. */
  ifNoneMatch?: string;
}

export interface RuleStatusArgs {
  catalog: Catalog;
  name: string;
  /** The poll handle from a `structural_applied` response. Resolves the
   *  live tracker on the main. Omit it (e.g. after a page reload) to
   *  resolve by catalog+name(+contentHash), which degrades to the
   *  durable rule row. */
  applyId?: string;
  /** SHA-256 hex of the content whose apply you're confirming —
   *  disambiguates the durable-DAO fallback once the applyId is gone. */
  contentHash?: string;
}

/**
 * Typed wrapper for the eight runtime-rule REST endpoints v1 binds to.
 *
 * Each method speaks the canonical route — the `/runtime/mal/otel/...`,
 * `/runtime/mal/log/...`, `/runtime/lal/...` shortcut variants are
 * sugar for scripted ops and aren't surfaced here.
 */
export class RuntimeRuleClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: RuntimeRuleClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = options.adminUrl.replace(/\/$/, '');
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /** `GET /runtime/rule/list[?catalog=]` */
  async list(catalog?: Catalog): Promise<ListEnvelope> {
    const url = this.url('/runtime/rule/list', catalog ? { catalog } : undefined);
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as ListEnvelope;
  }

  /** `GET /runtime/rule/bundled?catalog=[&withContent=]` */
  async listBundled(catalog: Catalog, withContent = true): Promise<BundledEntry[]> {
    const url = this.url('/runtime/rule/bundled', {
      catalog,
      withContent: String(withContent),
    });
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as BundledEntry[];
  }

  /** `GET /runtime/rule?catalog=&name=[&source=]`. Returns {@link
   *  NotModified} when the server replies 304 to a conditional fetch. */
  async get(args: GetRuleArgs): Promise<RuleResponse | NotModified> {
    const params: Record<string, string> = {
      catalog: args.catalog,
      name: args.name,
    };
    if (args.source) params.source = args.source;
    const url = this.url('/runtime/rule', params);

    const headers: Record<string, string> = { Accept: 'application/x-yaml' };
    if (args.ifNoneMatch) headers['If-None-Match'] = args.ifNoneMatch;

    const res = await this.send(url, { method: 'GET', headers });

    if (res.status === 304) {
      return {
        notModified: true,
        etag: res.headers.get('ETag') ?? '',
        contentHash: res.headers.get('X-Sw-Content-Hash') ?? '',
        status: (res.headers.get('X-Sw-Status') as RuleStatus) ?? 'n/a',
      };
    }
    if (!res.ok) throw await this.toError(res, url);

    const body = await res.text();
    return {
      status: (res.headers.get('X-Sw-Status') as RuleResponse['status']) ?? 'n/a',
      source: (res.headers.get('X-Sw-Source') as RuleResponse['source']) ?? 'runtime',
      contentHash: res.headers.get('X-Sw-Content-Hash') ?? '',
      updateTime: Number(res.headers.get('X-Sw-Update-Time') ?? '0'),
      etag: res.headers.get('ETag') ?? '',
      content: body,
    };
  }

  /** `POST /runtime/rule/addOrUpdate?catalog=&name=[&allowStorageChange=][&force=]` */
  async addOrUpdate(args: AddOrUpdateArgs): Promise<ApplyResult> {
    const params: Record<string, string> = {
      catalog: args.catalog,
      name: args.name,
    };
    if (args.allowStorageChange) params.allowStorageChange = 'true';
    if (args.force) params.force = 'true';
    const url = this.url('/runtime/rule/addOrUpdate', params);

    const res = await this.send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: args.body,
    });

    return this.expectApplyResult(res, url);
  }

  /** `POST /runtime/rule/inactivate?catalog=&name=` (Design A — see
   *  `reference_runtime_rule_api.md`). */
  async inactivate(catalog: Catalog, name: string): Promise<ApplyResult> {
    const url = this.url('/runtime/rule/inactivate', { catalog, name });
    const res = await this.send(url, { method: 'POST' });
    return this.expectApplyResult(res, url);
  }

  /** `POST /runtime/rule/delete?catalog=&name=[&mode=revertToBundled]`.
   *  The two-step gate is server-side: a 409 `requires_inactivate_first`
   *  is surfaced via {@link RuntimeRuleApiError}. */
  async delete(catalog: Catalog, name: string, mode: DeleteMode = ''): Promise<ApplyResult> {
    const params: Record<string, string> = { catalog, name };
    if (mode) params.mode = mode;
    const url = this.url('/runtime/rule/delete', params);
    const res = await this.send(url, { method: 'POST' });
    return this.expectApplyResult(res, url);
  }

  /** `GET /runtime/rule/status?catalog=&name=[&applyId=][&contentHash=]`.
   *  Reports the progress of a structural `/addOrUpdate` apply. ALWAYS
   *  200 — `found: false` (phase `UNKNOWN`) when nothing matches, never
   *  404. */
  async status(args: RuleStatusArgs): Promise<RuleStatusResponse> {
    const params: Record<string, string> = { catalog: args.catalog, name: args.name };
    if (args.applyId) params.applyId = args.applyId;
    if (args.contentHash) params.contentHash = args.contentHash;
    const url = this.url('/runtime/rule/status', params);
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as RuleStatusResponse;
  }

  /** `GET /runtime/rule/dump` or `/dump/{catalog}` — streams `tar.gz`. */
  async dump(catalog?: Catalog): Promise<Response> {
    const path = catalog
      ? `/runtime/rule/dump/${encodeURIComponent(catalog)}`
      : '/runtime/rule/dump';
    const url = this.url(path);
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return res;
  }

  // ─── private helpers ─────────────────────────────────────────────

  private url(path: string, params?: Record<string, string>): string {
    const u = new URL(this.base + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
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

  /** Handle the apply-result-or-error response shape that addOrUpdate /
   *  inactivate / delete share. 2xx returns the parsed JSON; everything
   *  else throws a {@link RuntimeRuleApiError} with the parsed body so
   *  callers can switch on `applyStatus` (e.g. the 409
   *  `storage_change_requires_explicit_approval` path). */
  private async expectApplyResult(res: Response, url: string): Promise<ApplyResult> {
    if (res.status >= 200 && res.status < 300) {
      return (await res.json()) as ApplyResult;
    }
    throw await this.toError(res, url);
  }

  private async toError(res: Response, url: string): Promise<RuntimeRuleApiError> {
    const text = await res.text();
    let parsed: ApplyResult | string = text;
    try {
      const json = JSON.parse(text) as Partial<ApplyResult>;
      if (typeof json.applyStatus === 'string' && typeof json.message === 'string') {
        parsed = json as ApplyResult;
      }
    } catch {
      // not JSON; keep the raw text.
    }
    return new RuntimeRuleApiError(res.status, parsed, url);
  }
}
