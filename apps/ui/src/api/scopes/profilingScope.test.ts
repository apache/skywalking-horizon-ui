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
 * Every profiling task list is a service-scoped read, so each one carries the
 * roster row it was picked from — the id the OAP task query keys on AND the
 * name — rather than half an identity the backend would have to complete.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BffClient } from '../client';
import { ProfileApi } from './profile';
import { PprofApi } from './pprof';
import { AsyncProfileApi } from './async-profile';
import { EbpfApi } from './ebpf';
import { NetworkProfileApi } from './network-profile';
import { ContinuousProfilingApi } from './continuous-profiling';

const SERVICE = { id: 'Z2VuZXJhbC1zdnI6OnNvbmdz.1', name: 'general-svr::songs' };

function makeStub(): { bff: BffClient; urls: string[] } {
  const urls: string[] = [];
  const bff = {
    request: vi.fn(async (_method: string, path: string) => {
      urls.push(path);
      return {} as unknown;
    }),
  } as unknown as BffClient;
  return { bff, urls };
}

describe('profiling task lists carry the whole service identity', () => {
  const cases: Array<[string, (bff: BffClient) => Promise<unknown>]> = [
    ['trace profiling', (bff) => new ProfileApi(bff).tasks('general', SERVICE)],
    ['pprof', (bff) => new PprofApi(bff).tasks('general', SERVICE)],
    ['async profiler', (bff) => new AsyncProfileApi(bff).tasks('general', SERVICE)],
    ['eBPF', (bff) => new EbpfApi(bff).tasks('general', SERVICE)],
    ['network profiling', (bff) => new NetworkProfileApi(bff).tasks('general', { service: SERVICE })],
    ['continuous profiling', (bff) => new ContinuousProfilingApi(bff).policies(SERVICE)],
  ];

  for (const [label, call] of cases) {
    it(`${label}: sends serviceId AND service`, async () => {
      const { bff, urls } = makeStub();
      await call(bff);
      const qs = new URL(urls[0]!, 'http://ui').searchParams;
      expect(qs.get('serviceId')).toBe(SERVICE.id);
      expect(qs.get('service')).toBe(SERVICE.name);
    });
  }
});
