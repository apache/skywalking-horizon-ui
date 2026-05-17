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
  DashboardWidget,
  OverviewDashboard,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

export type BundleScopeMap = Partial<
  Record<'service' | 'instance' | 'endpoint', DashboardWidget[]>
>;

export interface ConfigBundle {
  etag: string;
  generatedAt: number;
  layers: Record<string, BundleScopeMap>;
  overviews: OverviewDashboard[];
}

/** `bff.configs` — preload of dashboard + overview configs. The SPA
 *  caches the response in localStorage and re-fetches with
 *  `If-None-Match` so a 304 means "your cached copy is still good". */
export class ConfigsApi {
  constructor(private readonly bff: BffClient) {}

  /**
   * Fetch the bundle, optionally with a prior `etag` for cache
   * validation. Returns `null` on a 304 (the caller's cached copy
   * is current); otherwise a full bundle.
   */
  async bundle(ifNoneMatch?: string): Promise<ConfigBundle | null> {
    const headers: Record<string, string> = {};
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    // Direct fetch so we can detect 304 without throwing.
    const res = await fetch('/api/configs/bundle', {
      method: 'GET',
      credentials: 'include',
      headers,
    });
    if (res.status === 304) return null;
    if (res.status === 401) {
      this.bff.handleUnauthorized();
      throw new Error('unauthenticated');
    }
    if (!res.ok) throw new Error(`bundle fetch failed (${res.status})`);
    return (await res.json()) as ConfigBundle;
  }
}
