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

import type { BffClient, Infra3dConfig } from '../client';

/** `bff.infra3d` — 3D Infrastructure Map admin config CRUD. The GET
 *  returns the live config (admin-saved override OR bundled defaults
 *  when no save exists). The POST accepts the full document — server
 *  validates and returns 400 with `{issues:[...]}` on failure. */
export class Infra3dApi {
  constructor(private readonly bff: BffClient) {}

  config(): Promise<Infra3dConfig> {
    return this.bff.request<Infra3dConfig>('GET', '/api/infra-3d/config');
  }

  /** Bundled defaults — independent of admin saves. Used by the
   *  admin editor's "Reset to bundled" button. */
  bundledConfig(): Promise<Infra3dConfig> {
    return this.bff.request<Infra3dConfig>('GET', '/api/infra-3d/config/bundled');
  }

  saveConfig(next: Infra3dConfig): Promise<Infra3dConfig> {
    return this.bff.request<Infra3dConfig>('POST', '/api/infra-3d/config', next);
  }

  /** Batched per-service MQE fetch for the cube traffic ring. Caller
   *  pre-chunks the service list to fit the BFF's per-call cap (the
   *  endpoint will 400 on > MAX_SERVICES). */
  metrics(payload: Infra3dMetricsRequest): Promise<Infra3dMetricsResponse> {
    return this.bff.request<Infra3dMetricsResponse>('POST', '/api/infra-3d/metrics', payload);
  }
}

export interface Infra3dMetricsRequest {
  services: Array<{ name: string; layer: string; normal: boolean; mqe: string }>;
  window?: { startMs: number; endMs: number; step: 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY' };
}

export interface Infra3dMetricsResponse {
  /** Keys are `${LAYER}::${serviceName}`. Null = OAP returned no
   *  data (empty series or non-fatal per-service error). */
  values: Record<string, number | null>;
  errors: Record<string, string>;
  generatedAt: number;
  window: { start: string; end: string; step: 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY' };
}
