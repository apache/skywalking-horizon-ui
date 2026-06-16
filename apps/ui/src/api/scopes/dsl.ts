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
  OalFilesResponse,
  OalRulesResponse,
  OalSourceDetail,
  RuleResponse,
  RuleSource,
  RuleStatusResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient, ClusterStateResponse } from '../client';
import { BffApiError, withBase } from '../client';
import { pushEvent } from '@/controls/eventLog';

/** `bff.dsl` — DSL Management: rule catalog browse, single-rule fetch /
 *  save / inactivate / delete, OAL read-only browse, cluster state, dump. */
export class DslApi {
  constructor(private readonly bff: BffClient) {}

  clusterState(): Promise<ClusterStateResponse> {
    return this.bff.request<ClusterStateResponse>('GET', '/api/cluster/state');
  }

  catalogList(catalog?: Catalog): Promise<ListEnvelope> {
    const path = catalog
      ? `/api/catalog/list?catalog=${encodeURIComponent(catalog)}`
      : '/api/catalog/list';
    return this.bff.request<ListEnvelope>('GET', path);
  }

  catalogBundled(catalog: Catalog, withContent = true): Promise<BundledEntry[]> {
    const params = new URLSearchParams({ catalog, withContent: String(withContent) });
    return this.bff.request<BundledEntry[]>('GET', `/api/catalog/bundled?${params.toString()}`);
  }

  /** Returns `null` when the rule doesn't exist (HTTP 404). */
  async getRule(args: {
    catalog: Catalog;
    name: string;
    source?: RuleSource;
  }): Promise<RuleResponse | null> {
    const params = new URLSearchParams({ catalog: args.catalog, name: args.name });
    if (args.source) params.set('source', args.source);
    const path = `/api/rule?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(withBase(path), {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/x-yaml' },
      });
    } catch (err) {
      pushEvent('api', 'err', `GET ${path} · network ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    if (res.status === 401) {
      pushEvent('api', 'info', `GET ${path} · 401 (re-auth)`);
      this.bff.handleUnauthorized();
      throw new BffApiError(401, 'unauthenticated', null);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      let parsed: unknown = null;
      try { parsed = await res.json(); } catch { parsed = await res.text(); }
      pushEvent('api', 'err', `GET ${path} · ${res.status}`);
      throw new BffApiError(res.status, `GET ${path} failed (${res.status})`, parsed);
    }
    const content = await res.text();
    return {
      status: (res.headers.get('x-sw-status') as RuleResponse['status']) ?? 'n/a',
      source: (res.headers.get('x-sw-source') as RuleResponse['source']) ?? 'runtime',
      contentHash: res.headers.get('x-sw-content-hash') ?? '',
      updateTime: Number(res.headers.get('x-sw-update-time') ?? '0'),
      etag: res.headers.get('etag') ?? '',
      content,
    };
  }

  async saveRule(args: {
    catalog: Catalog;
    name: string;
    body: string;
    allowStorageChange?: boolean;
    force?: boolean;
  }): Promise<ApplyResult> {
    const params = new URLSearchParams({ catalog: args.catalog, name: args.name });
    if (args.allowStorageChange) params.set('allowStorageChange', 'true');
    if (args.force) params.set('force', 'true');
    const path = `/api/rule?${params.toString()}`;
    const res = await fetch(withBase(path), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain' },
      body: args.body,
    });
    if (res.status === 401) {
      this.bff.handleUnauthorized();
      throw new BffApiError(401, 'unauthenticated', null);
    }
    if (!res.ok) {
      let parsed: unknown = null;
      try { parsed = await res.json(); } catch { parsed = await res.text(); }
      throw new BffApiError(res.status, `POST ${path} failed (${res.status})`, parsed);
    }
    return (await res.json()) as ApplyResult;
  }

  /** Poll a structural apply's progress. Pass `applyId` from the
   *  `structural_applied` response while the apply is live; pass
   *  `contentHash` to resolve from the durable rule row after a reload. */
  ruleStatus(args: {
    catalog: Catalog;
    name: string;
    applyId?: string;
    contentHash?: string;
  }): Promise<RuleStatusResponse> {
    const params = new URLSearchParams({ catalog: args.catalog, name: args.name });
    if (args.applyId) params.set('applyId', args.applyId);
    if (args.contentHash) params.set('contentHash', args.contentHash);
    return this.bff.request<RuleStatusResponse>('GET', `/api/rule/status?${params.toString()}`);
  }

  inactivateRule(catalog: Catalog, name: string): Promise<ApplyResult> {
    const params = new URLSearchParams({ catalog, name });
    return this.bff.request<ApplyResult>('POST', `/api/rule/inactivate?${params.toString()}`);
  }

  deleteRule(catalog: Catalog, name: string, mode: DeleteMode = ''): Promise<ApplyResult> {
    const params = new URLSearchParams({ catalog, name });
    if (mode) params.set('mode', mode);
    return this.bff.request<ApplyResult>('POST', `/api/rule/delete?${params.toString()}`);
  }

  // ── OAL (read-only) ────────────────────────────────────────────────

  oalFiles(): Promise<OalFilesResponse> {
    return this.bff.request<OalFilesResponse>('GET', '/api/oal/files');
  }

  /** Returns the raw `.oal` text or `null` on 404. */
  async oalFileContent(name: string): Promise<string | null> {
    const res = await fetch(withBase(`/api/oal/files/${encodeURIComponent(name)}`), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/plain' },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      let parsed: unknown = null;
      try { parsed = await res.json(); } catch { parsed = await res.text(); }
      throw new BffApiError(res.status, `oal/files/${name} failed`, parsed);
    }
    return res.text();
  }

  oalSources(): Promise<OalRulesResponse> {
    return this.bff.request<OalRulesResponse>('GET', '/api/oal/rules');
  }

  async oalSource(source: string): Promise<OalSourceDetail | null> {
    try {
      return await this.bff.request<OalSourceDetail>(
        'GET',
        `/api/oal/rules/${encodeURIComponent(source)}`,
      );
    } catch (err) {
      if (err instanceof BffApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Triggers an `/api/dump[/{catalog}]` download via an invisible
   *  anchor click — the BFF session cookie is HttpOnly and gets sent
   *  with the same-origin request automatically. */
  triggerDump(catalog?: Catalog): void {
    const path = catalog
      ? `/api/dump/${encodeURIComponent(catalog)}`
      : '/api/dump';
    const a = document.createElement('a');
    a.href = path;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}
