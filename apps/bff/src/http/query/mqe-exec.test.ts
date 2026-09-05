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

import { describe, it, expect } from 'vitest';
import { bodySchema, entitySchema } from './mqe-exec.js';
import { expressionForServiceMetricSeries } from '../../util/mqe-catalog.js';
import { windowFromRange } from '../../util/window.js';

const RANGE = { step: 'MINUTE' as const, startMs: 1_760_000_000_000, endMs: 1_760_003_600_000 };

describe('mqe-exec entity schema', () => {
  it('accepts an entity with NO scope — relation metrics require it omitted', () => {
    // OAP marks `Entity.scope` nullable and deprecated (9.4.0) and senses the
    // scope from the metric name; forcing it empties relation results on some
    // versions, which is why every relation query the BFF builds leaves it off.
    const parsed = entitySchema.safeParse({
      serviceName: 'frontend',
      normal: true,
      destServiceName: 'orders',
      destNormal: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('scope' in parsed.data).toBe(false);
  });

  it('accepts an explicit scope for the single-entity sites', () => {
    for (const scope of ['Service', 'ServiceInstance', 'Endpoint']) {
      expect(entitySchema.safeParse({ scope, serviceName: 'frontend', normal: true }).success).toBe(true);
    }
  });

  it('carries both sides of a relation, instances included', () => {
    const parsed = entitySchema.safeParse({
      serviceName: 'frontend',
      normal: true,
      serviceInstanceName: 'frontend-1',
      destServiceName: 'orders',
      destNormal: false,
      destServiceInstanceName: 'orders-2',
    });
    expect(parsed.success).toBe(true);
  });

  it('carries both process names for a ProcessRelation entity', () => {
    const parsed = entitySchema.safeParse({
      serviceName: 'frontend',
      normal: true,
      serviceInstanceName: 'frontend-1',
      processName: 'nginx',
      destServiceName: 'orders',
      destNormal: true,
      destServiceInstanceName: 'orders-1',
      destProcessName: 'java',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown key rather than forwarding it to OAP', () => {
    // A typo must fail here, visibly, instead of silently widening the query.
    expect(entitySchema.safeParse({ serviceName: 'frontend', servcieName: 'typo' }).success).toBe(false);
  });

  it('rejects an empty-string scope — absent and blank are different', () => {
    expect(entitySchema.safeParse({ scope: '', serviceName: 'frontend' }).success).toBe(false);
  });

  it('rejects present-but-blank names instead of addressing OAP _blank', () => {
    expect(entitySchema.safeParse({ scope: 'Service', serviceName: '   ' }).success).toBe(false);
    expect(entitySchema.safeParse({ processName: '\t' }).success).toBe(false);
  });
});

describe('mqe-exec body schema', () => {
  it('accepts a blank expression — the catalog default is resolved server-side', () => {
    const parsed = bodySchema.safeParse({
      metric: 'cpm',
      layer: 'GENERAL',
      entity: { scope: 'Service', serviceName: 'frontend', normal: true },
      ...RANGE,
    });
    expect(parsed.success).toBe(true);
  });

  it('takes the window as epoch ms, so no caller needs the server offset', () => {
    const parsed = bodySchema.safeParse({
      expression: 'service_cpm',
      entity: { scope: 'Service', serviceName: 'frontend' },
      ...RANGE,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(typeof parsed.data.startMs).toBe('number');
      expect(parsed.data.step).toBe('MINUTE');
    }
  });

  it('rejects a step OAP does not accept on this path', () => {
    const parsed = bodySchema.safeParse({
      expression: 'service_cpm',
      entity: { serviceName: 'frontend' },
      step: 'SECOND',
      startMs: RANGE.startMs,
      endMs: RANGE.endMs,
    });
    expect(parsed.success).toBe(false);
  });

  it('requires an entity — an expression alone is not a query', () => {
    expect(bodySchema.safeParse({ expression: 'service_cpm', ...RANGE }).success).toBe(false);
  });

  it('does not impose the time picker\'s preset caps on the API', () => {
    // Sibling metrics routes bound no window length, and what OAP will serve
    // is OAP's to say — a span this route refused would be a span the
    // dashboard route serves, for no reason a caller could discover.
    const base = {
      expression: 'service_cpm',
      entity: { scope: 'Service', serviceName: 'frontend' },
      step: 'MINUTE' as const,
      startMs: RANGE.startMs,
    };
    // Far past the picker's 4-hour MINUTE cap, and past its 1-minute floor.
    expect(bodySchema.safeParse({ ...base, endMs: RANGE.startMs + 30_000 }).success).toBe(true);
    expect(bodySchema.safeParse({ ...base, endMs: RANGE.startMs + 30 * 24 * 3600_000 }).success).toBe(true);
  });

  it('rejects epoch values outside JavaScript Date range', () => {
    expect(bodySchema.safeParse({
      expression: 'service_cpm',
      entity: { scope: 'Service', serviceName: 'frontend' },
      step: 'MINUTE',
      startMs: RANGE.startMs,
      endMs: 10_000_000_000_000_000,
    }).success).toBe(false);
  });
});

describe('mqe-exec window + catalog resolution', () => {
  it('refuses a reversed range before it reaches OAP', () => {
    expect(windowFromRange('MINUTE', RANGE.endMs, RANGE.startMs, 0)).toBeNull();
  });

  it('formats the window for its step in OAP-server local time', () => {
    // +480 = UTC+8: the same instant must format to the server's clock, not
    // the caller's, which is the whole reason the conversion is BFF-side.
    const utc = windowFromRange('MINUTE', RANGE.startMs, RANGE.endMs, 0);
    const shanghai = windowFromRange('MINUTE', RANGE.startMs, RANGE.endMs, 480);
    expect(utc).not.toBeNull();
    expect(shanghai).not.toBeNull();
    expect(shanghai!.start).not.toEqual(utc!.start);
    expect(shanghai!.start).toMatch(/^\d{4}-\d{2}-\d{2} \d{4}$/);
  });

  it('resolves a blank service-list column to its catalog default', () => {
    // A blank `mqe` on a header column is not a blank query — the landing
    // route runs this same default, so the panel must show the same thing.
    // The column's `metric` is the SHORT logical id (`cpm`), not the OAP
    // metric name, which is what the catalog is keyed by.
    expect(expressionForServiceMetricSeries('cpm', 'GENERAL')).toBe('service_cpm');
  });

  it('returns null for a metric the catalog has no default for', () => {
    expect(expressionForServiceMetricSeries('not_a_real_metric_xyz', 'GENERAL')).toBeNull();
  });
});
