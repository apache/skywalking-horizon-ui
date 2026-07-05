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

import { describe, it, expect, vi } from 'vitest';
import { AlarmsApi } from './alarms';
import type { BffClient } from '../client';

function makeStub() {
  const calls: Array<[string, string, unknown?]> = [];
  const bff = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return {} as unknown;
    }),
  } as unknown as BffClient;
  return { bff, calls };
}

describe('AlarmsApi.list — query param assembly', () => {
  it('includes only the required fields when filters are empty', async () => {
    const { bff, calls } = makeStub();
    await new AlarmsApi(bff).list({ startTime: 100, endTime: 200 });
    expect(calls[0][1]).toBe('/api/alarms?startTime=100&endTime=200&pageNum=1&pageSize=500');
  });

  it('defaults pageNum=1 and pageSize=500 when not provided', async () => {
    const { bff, calls } = makeStub();
    await new AlarmsApi(bff).list({ startTime: 1, endTime: 2 });
    expect(calls[0][1]).toContain('pageNum=1');
    expect(calls[0][1]).toContain('pageSize=500');
  });

  it('forwards entity filters (layer / service / instance / endpoint) with URL encoding', async () => {
    const { bff, calls } = makeStub();
    await new AlarmsApi(bff).list({
      startTime: 1,
      endTime: 2,
      layer: 'MESH',
      service: 'mesh-svr::reviews',
      instance: 'reviews-pod-1',
      endpoint: '/api/orders',
    });
    expect(calls[0][1]).toBe(
      '/api/alarms?startTime=1&endTime=2&pageNum=1&pageSize=500&layer=MESH&service=mesh-svr%3A%3Areviews&instance=reviews-pod-1&endpoint=%2Fapi%2Forders',
    );
  });

  it('forwards scope + keyword when present', async () => {
    const { bff, calls } = makeStub();
    await new AlarmsApi(bff).list({
      startTime: 1,
      endTime: 2,
      scope: 'Service',
      keyword: 'slow query',
    });
    expect(calls[0][1]).toContain('scope=Service');
    expect(calls[0][1]).toContain('keyword=slow+query');
  });
});

describe('AlarmsApi.services + config + count', () => {
  it('count GETs /api/alarms/count with start + end', async () => {
    const { bff, calls } = makeStub();
    await new AlarmsApi(bff).count(1000, 2000);
    expect(calls[0]).toEqual(['GET', '/api/alarms/count?startTime=1000&endTime=2000', undefined]);
  });

  it('services GETs with layer param', async () => {
    const { bff, calls } = makeStub();
    await new AlarmsApi(bff).services('MESH');
    expect(calls[0][1]).toBe('/api/alarms/services?layer=MESH');
  });

  function stubSyncStatus(rows: unknown[]) {
    const { bff } = makeStub();
    (bff as unknown as { templateSync: { syncStatus: () => Promise<unknown> } }).templateSync = {
      syncStatus: vi.fn(async () => ({ rows })),
    };
    return bff;
  }

  it('config reads + normalizes the alert page-setup from the template sync status', async () => {
    const bff = stubSyncStatus([
      {
        name: 'horizon.alert.page-setup',
        effective: 'remote',
        remote: {
          configuration: JSON.stringify({
            name: 'horizon.alert.page-setup',
            kind: 'alert',
            version: 1,
            content: { pinnedLayers: ['MESH'], defaultWindowMs: 7200000, overviewAlarmsLimit: 300 },
          }),
        },
        bundled: null,
      },
    ]);
    const cfg = await new AlarmsApi(bff).config();
    expect(cfg).toEqual({ pinnedLayers: ['MESH'], defaultWindowMs: 7200000, overviewAlarmsLimit: 300 });
  });

  it('config falls back to shipped defaults when the alert row is absent', async () => {
    const cfg = await new AlarmsApi(stubSyncStatus([])).config();
    expect(cfg).toEqual({ pinnedLayers: ['GENERAL', 'MESH'], defaultWindowMs: 1200000, overviewAlarmsLimit: 200 });
  });

  it('adminRules + adminRule hit /api/admin/alarm-rules', async () => {
    const { bff, calls } = makeStub();
    const api = new AlarmsApi(bff);
    await api.adminRules();
    await api.adminRule('service_resp_time_rule');
    expect(calls[0]).toEqual(['GET', '/api/admin/alarm-rules', undefined]);
    expect(calls[1]).toEqual([
      'GET',
      '/api/admin/alarm-rules/service_resp_time_rule',
      undefined,
    ]);
  });

  it('adminRule URL-encodes the rule id', async () => {
    const { bff, calls } = makeStub();
    await new AlarmsApi(bff).adminRule('rule with space / slash');
    expect(calls[0][1]).toBe(
      '/api/admin/alarm-rules/rule%20with%20space%20%2F%20slash',
    );
  });
});
