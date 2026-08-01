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

  it('forwards the service normal flag in both states', async () => {
    const virtual = makeStub();
    await new AlarmsApi(virtual.bff).list({
      startTime: 1,
      endTime: 2,
      service: 'mysql-a',
      normal: false,
    });
    expect(virtual.calls[0][1]).toContain('service=mysql-a&normal=false');

    const real = makeStub();
    await new AlarmsApi(real.bff).list({ startTime: 1, endTime: 2, service: 'songs', normal: true });
    expect(real.calls[0][1]).toContain('service=songs&normal=true');
  });

  it('omits the normal flag when the caller did not resolve one', async () => {
    const { bff, calls } = makeStub();
    await new AlarmsApi(bff).list({ startTime: 1, endTime: 2, service: 'songs' });
    expect(calls[0][1]).not.toContain('normal');
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

  /** A client whose org-settings read returns `alert`, and whose admin
   *  sync-status still holds a bundled-only row — the shape live mode must
   *  refuse to render. */
  function stubSettings(alert: unknown) {
    const { bff } = makeStub();
    const settings = vi.fn(async () => ({ theme: null, timeDefaults: null, alert }));
    (bff as unknown as { configs: { settings: typeof settings } }).configs = { settings };
    const syncStatus = vi.fn(async () => ({
      rows: [
        {
          name: 'horizon.alert.page-setup',
          effective: 'bundled',
          remote: null,
          bundled: {
            configuration: JSON.stringify({
              name: 'horizon.alert.page-setup',
              kind: 'alert',
              version: 1,
              content: { pinnedLayers: ['ON_DISK_ONLY'], defaultWindowMs: 14400000 },
            }),
          },
        },
      ],
    }));
    (bff as unknown as { templateSync: { syncStatus: typeof syncStatus } }).templateSync = {
      syncStatus,
    };
    return { bff, settings, syncStatus };
  }

  it('config normalizes the alert page-setup the BFF resolved', async () => {
    const { bff, settings, syncStatus } = stubSettings({
      pinnedLayers: ['MESH'],
      defaultWindowMs: 7200000,
      overviewAlarmsLimit: 300,
    });
    const cfg = await new AlarmsApi(bff).config();
    expect(cfg).toEqual({ pinnedLayers: ['MESH'], defaultWindowMs: 7200000, overviewAlarmsLimit: 300 });
    expect(settings).toHaveBeenCalledTimes(1);
    // The admin payload carries every template's bundled copy and needs a verb
    // the alarm badge's readers don't have; the badge must not touch it.
    expect(syncStatus).not.toHaveBeenCalled();
  });

  it('config falls back to shipped defaults — not the on-disk template — when the BFF resolved no value', async () => {
    const { bff } = stubSettings(null);
    const cfg = await new AlarmsApi(bff).config();
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
