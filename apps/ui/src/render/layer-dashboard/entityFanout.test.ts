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

import { describe, expect, it } from 'vitest';
import {
  createLimiter,
  entityDashboardBody,
  entityDashboardKey,
  fanoutEntities,
} from './entityFanout';

describe('fanoutEntities', () => {
  it('de-duplicates the primary out of the locked set and drops empties', () => {
    expect(fanoutEntities('p', ['a', 'p', 'b'])).toEqual(['a', 'b']);
    expect(fanoutEntities('p', ['a', '', 'b'])).toEqual(['a', 'b']);
  });

  it('a null primary fans out the whole (non-empty) locked set', () => {
    expect(fanoutEntities(null, ['a', '', 'b'])).toEqual(['a', 'b']);
    expect(fanoutEntities('p', [])).toEqual([]);
  });

  it('when the primary is the only lock there is nothing to fan out', () => {
    expect(fanoutEntities('p', ['p'])).toEqual([]);
  });
});

describe('entityDashboardBody — slot substitution per scope', () => {
  const range = { step: 'MINUTE' as const, startMs: 1000, endMs: 2000 };

  it('service scope puts the service in `service` (entityService), no name', () => {
    expect(entityDashboardBody('service', 'svcB', '', null, null)).toEqual({
      scope: 'service',
      service: 'svcB',
    });
  });

  it('instance scope keeps the primary service and sets serviceInstance', () => {
    expect(entityDashboardBody('instance', 'svcA', 'inst2', range, null)).toEqual({
      scope: 'instance',
      service: 'svcA',
      serviceInstance: 'inst2',
      step: 'MINUTE',
      startMs: 1000,
      endMs: 2000,
    });
  });

  it('endpoint scope keeps the primary service and sets endpoint', () => {
    expect(entityDashboardBody('endpoint', 'svcA', 'ep2', null, null)).toEqual({
      scope: 'endpoint',
      service: 'svcA',
      endpoint: 'ep2',
    });
  });
});

describe('entityDashboardKey — mirrors the single-query key shape', () => {
  it('places the entity in the scope slot, leaving others null', () => {
    expect(entityDashboardKey('GENERAL', 'instance', 'svcA', 'inst2', 0, 'MINUTE:1:2', null)).toEqual([
      'dashboard',
      'GENERAL',
      'svcA',
      'instance',
      0,
      'inst2',
      null,
      'MINUTE:1:2',
      null,
    ]);
  });

  it('distinct entities produce distinct keys (per-entity cache)', () => {
    const a = entityDashboardKey('GENERAL', 'service', 'svcA', '', 0, null, null);
    const b = entityDashboardKey('GENERAL', 'service', 'svcB', '', 0, null, null);
    expect(a).not.toEqual(b);
  });
});

describe('createLimiter — bounded concurrency', () => {
  it('never runs more than `max` tasks at once', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      new Promise<number>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active -= 1;
          resolve(active);
        }, 10);
      });
    const results = await Promise.all(Array.from({ length: 6 }, () => limit(task)));
    expect(peak).toBe(2);
    expect(results).toHaveLength(6);
  });

  it('max = 1 serializes (peak 1)', async () => {
    const limit = createLimiter(1);
    let active = 0;
    let peak = 0;
    const task = () =>
      new Promise<void>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active -= 1;
          resolve();
        }, 5);
      });
    await Promise.all(Array.from({ length: 4 }, () => limit(task)));
    expect(peak).toBe(1);
  });

  it('releases the slot even when a task rejects', async () => {
    const limit = createLimiter(1);
    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limit(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
