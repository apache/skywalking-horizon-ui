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
  OverviewDashboard,
  OverviewDashboardListResponse,
  OverviewDashboardResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

export interface OverviewTemplateSummary {
  id: string;
  title: string;
  description?: string;
  widgetCount: number;
  editable: boolean;
}
export interface OverviewTemplateListResponse {
  generatedAt: number;
  dashboards: OverviewTemplateSummary[];
}
export interface OverviewTemplateDetailResponse {
  generatedAt: number;
  dashboard: OverviewDashboard;
  editable: boolean;
}

/** `bff.overview` — cross-layer overview dashboards (Services / Mesh / …). */
export class OverviewApi {
  constructor(private readonly bff: BffClient) {}

  list(): Promise<OverviewDashboardListResponse> {
    return this.bff.request<OverviewDashboardListResponse>('GET', '/api/overview/dashboards');
  }
  get(id: string): Promise<OverviewDashboardResponse> {
    return this.bff.request<OverviewDashboardResponse>(
      'GET',
      `/api/overview/dashboards/${encodeURIComponent(id)}`,
    );
  }

  /* Admin endpoints — same dashboard JSON, write surface for editing
   * per-widget layer / limit / title / tip / span / rowSpan etc. */
  adminList(): Promise<OverviewTemplateListResponse> {
    return this.bff.request<OverviewTemplateListResponse>('GET', '/api/admin/overview-templates');
  }
  adminGet(id: string): Promise<OverviewTemplateDetailResponse> {
    return this.bff.request<OverviewTemplateDetailResponse>(
      'GET',
      `/api/admin/overview-templates/${encodeURIComponent(id)}`,
    );
  }
  adminCreate(body: OverviewDashboard): Promise<{ ok: true; id: string }> {
    return this.bff.request<{ ok: true; id: string }>(
      'POST',
      '/api/admin/overview-templates',
      body,
    );
  }
  adminDelete(id: string): Promise<{ ok: true; id: string }> {
    return this.bff.request<{ ok: true; id: string }>(
      'DELETE',
      `/api/admin/overview-templates/${encodeURIComponent(id)}`,
    );
  }
}
