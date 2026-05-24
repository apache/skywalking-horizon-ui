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
  DashboardConfig,
  DashboardResponse,
  DashboardWidget,
  EndpointDependencyResponse,
  LandingConfig,
  LandingResponse,
  TopologyResponse,
} from '@skywalking-horizon-ui/api-client';
import { pushEvent } from '@/controls/eventLog';
import type { BffClient } from '../client';

/** BFF cap on widgets per `/api/layer/:key/dashboard` body. Mirrors
 *  the zod `widgetSchema.max(40)` in `apps/bff/src/http/query/dashboard.ts`
 *  — kept here as a single source of truth for the chunking logic in
 *  `dashboard()` below. Bumping this requires bumping the BFF zod cap
 *  too. The cap exists to protect OAP's storage page-size cliffs, not
 *  to enforce a UI limit, so the UI splits oversized requests rather
 *  than refusing them. */
export const DASHBOARD_WIDGETS_PER_REQUEST = 40;

/** `bff.layer` — per-layer data: landing top-N, dashboard widgets,
 *  endpoint / instance pickers, topology, endpoint dependency. */
export class LayerApi {
  constructor(private readonly bff: BffClient) {}

  landing(
    layerKey: string,
    cfg: LandingConfig,
    range?: { step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number },
  ): Promise<LandingResponse> {
    const body: Record<string, unknown> = {
      topN: cfg.topN,
      orderBy: cfg.orderBy,
      columns: cfg.columns,
      ...(cfg.spark ? { spark: cfg.spark } : {}),
      ...(cfg.throughput ? { throughput: cfg.throughput } : {}),
    };
    if (range) {
      body.step = range.step;
      body.startMs = range.startMs;
      body.endMs = range.endMs;
    }
    return this.bff.request<LandingResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/landing`,
      body,
    );
  }

  dashboardConfig(layerKey: string, scope?: string): Promise<DashboardConfig> {
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    return this.bff.request<DashboardConfig>(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/dashboard/config${qs}`,
    );
  }

  async dashboard(
    layerKey: string,
    body: {
      service?: string;
      /** Active instance — only honored when `scope === 'instance'`. */
      serviceInstance?: string;
      /** Active endpoint — only honored when `scope === 'endpoint'`. */
      endpoint?: string;
      widgets?: DashboardWidget[];
      scope?: string;
      step?: 'MINUTE' | 'HOUR' | 'DAY';
      /** Range start ms. Paired with `endMs` + `step`. */
      startMs?: number;
      /** Range end ms. */
      endMs?: number;
    } = {},
    /** Dev-mode `?mockTop=N` — pad every TopList result to N synthetic rows. */
    opts: { mockTop?: number } = {},
  ): Promise<DashboardResponse> {
    const qs = opts.mockTop && opts.mockTop > 0 ? `?mockTop=${opts.mockTop}` : '';
    const path = `/api/layer/${encodeURIComponent(layerKey)}/dashboard${qs}`;
    const widgets = body.widgets ?? [];

    // Fast path: a single request is enough.
    if (widgets.length <= DASHBOARD_WIDGETS_PER_REQUEST) {
      return this.bff.request<DashboardResponse>('POST', path, body);
    }

    // Slow path: oversize widget set. The BFF rejects bodies with more
    // than `DASHBOARD_WIDGETS_PER_REQUEST` widgets (protects OAP's
    // storage page-size cliffs); the UI chunks instead of refusing.
    // We fire chunks in parallel because each chunk hits a different
    // subset of OAP metrics — there's no in-OAP locking that benefits
    // from serial dispatch.
    const chunks: DashboardWidget[][] = [];
    for (let i = 0; i < widgets.length; i += DASHBOARD_WIDGETS_PER_REQUEST) {
      chunks.push(widgets.slice(i, i + DASHBOARD_WIDGETS_PER_REQUEST));
    }
    pushEvent(
      'api',
      'info',
      `${path} · ${widgets.length} widgets → ${chunks.length} chunks of ≤${DASHBOARD_WIDGETS_PER_REQUEST}`,
    );

    const responses = await Promise.all(
      chunks.map((chunk) =>
        this.bff.request<DashboardResponse>('POST', path, { ...body, widgets: chunk }),
      ),
    );

    // Merge: concatenate `widgets` in original order, AND-fold
    // `reachable`, surface the first non-empty `error`. All other
    // top-level fields are deterministic for the same body shape so
    // we pick the first response's values.
    const first = responses[0]!;
    return {
      ...first,
      widgets: responses.flatMap((r) => r.widgets),
      reachable: responses.every((r) => r.reachable),
      error: responses.find((r) => r.error)?.error,
    };
  }

  endpoints(
    layerKey: string,
    service: string,
    query: string,
    limit = 20,
  ): Promise<{
    layer: string;
    service: string;
    query: string;
    limit: number;
    generatedAt: number;
    endpoints: Array<{ id: string; name: string }>;
    reachable: boolean;
    error?: string;
  }> {
    const qs = new URLSearchParams({ service, q: query, limit: String(limit) });
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/endpoints?${qs.toString()}`,
    );
  }

  instances(
    layerKey: string,
    service: string,
  ): Promise<{
    layer: string;
    service: string;
    generatedAt: number;
    instances: Array<{
      id: string;
      name: string;
      language: string | null;
      attributes: Array<{ name: string; value: string }>;
    }>;
    reachable: boolean;
    error?: string;
  }> {
    const qs = `?service=${encodeURIComponent(service)}`;
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/instances${qs}`,
    );
  }

  topology(
    layerKey: string,
    service?: string,
    depth = 1,
    range?: { step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number },
  ): Promise<TopologyResponse> {
    const qs = new URLSearchParams();
    if (service) qs.set('service', service);
    qs.set('depth', String(depth));
    if (range) {
      qs.set('step', range.step);
      qs.set('startMs', String(range.startMs));
      qs.set('endMs', String(range.endMs));
    }
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/topology?${qs.toString()}`,
    );
  }

  endpointDependency(
    layerKey: string,
    service: string,
    endpoint: string,
  ): Promise<EndpointDependencyResponse> {
    const qs = new URLSearchParams({ service, endpoint });
    return this.bff.request(
      'GET',
      `/api/layer/${encodeURIComponent(layerKey)}/endpoint-dependency?${qs.toString()}`,
    );
  }
}
