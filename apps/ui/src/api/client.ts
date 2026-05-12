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
  LandingConfig,
  LandingResponse,
  MenuResponse,
  OapInfo,
  SetupResponse,
  SetupSavePayload,
} from '@skywalking-horizon-ui/api-client';

export type {
  MenuResponse,
  LayerDef,
  LayerCaps,
  LayerSlots,
  OapInfo,
  SetupResponse,
  SetupSavePayload,
  LayerConfig,
  LandingConfig,
  LandingColumn,
  LandingResponse,
  LandingServiceRow,
} from '@skywalking-horizon-ui/api-client';


export interface MeResponse {
  username: string;
  roles: string[];
  verbs: string[];
}

export class BffApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'BffApiError';
    this.status = status;
    this.body = body;
  }
}

type On401 = () => void;

export class BffClient {
  private on401: On401 | null = null;

  setOn401(fn: On401): void {
    this.on401 = fn;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(path, init);
    if (res.status === 401) {
      this.on401?.();
      throw new BffApiError(401, 'unauthenticated', null);
    }
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = await res.text();
      }
      throw new BffApiError(res.status, `${method} ${path} failed (${res.status})`, parsed);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  // ── auth ─────────────────────────────────────────────────────────────
  login(username: string, password: string): Promise<MeResponse> {
    return this.request<MeResponse>('POST', '/api/auth/login', { username, password });
  }

  logout(): Promise<{ status: 'ok' }> {
    return this.request<{ status: 'ok' }>('POST', '/api/auth/logout');
  }

  me(): Promise<MeResponse> {
    return this.request<MeResponse>('GET', '/api/auth/me');
  }

  // ── menu / layers ────────────────────────────────────────────────────
  menu(): Promise<MenuResponse> {
    return this.request<MenuResponse>('GET', '/api/menu');
  }

  oapInfo(): Promise<OapInfo> {
    return this.request<OapInfo>('GET', '/api/oap/info');
  }

  // ── setup (per-layer overrides) ──────────────────────────────────────
  loadSetup(): Promise<SetupResponse> {
    return this.request<SetupResponse>('GET', '/api/setup');
  }

  saveSetup(payload: SetupSavePayload): Promise<SetupResponse> {
    return this.request<SetupResponse>('POST', '/api/setup', payload);
  }

  // ── landing (per-layer top-N) ────────────────────────────────────────
  layerLanding(layerKey: string, cfg: LandingConfig): Promise<LandingResponse> {
    // The wire payload mirrors LandingConfig minus the priority/style
    // bits the BFF doesn't care about.
    const body = {
      topN: cfg.topN,
      orderBy: cfg.orderBy,
      columns: cfg.columns,
      ...(cfg.spark ? { spark: cfg.spark } : {}),
      ...(cfg.throughput ? { throughput: cfg.throughput } : {}),
    };
    return this.request<LandingResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/landing`,
      body,
    );
  }

  // ── cluster / preflight ──────────────────────────────────────────────
  preflight(): Promise<unknown> {
    return this.request('GET', '/api/preflight');
  }

  clusterState(): Promise<unknown> {
    return this.request('GET', '/api/cluster/state');
  }
}

export const bffClient = new BffClient();
