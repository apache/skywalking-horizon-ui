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
  InspectApiError,
  InspectClient,
  formatInspectDate,
  isInspectDate,
  type InspectValuesRequest,
} from './inspect.js';
import type { FetchLike } from './runtime-rule.js';

interface Recorded {
  url: string;
  init: RequestInit;
}

function recorder(reply: (url: string) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply(String(input));
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const query = (url: string): URLSearchParams => new URL(url).searchParams;

describe('InspectClient — catalog query', () => {
  it('asks for the whole catalog with no query string when no filter is given', async () => {
    const { fetchImpl, calls } = recorder(() => json({ metrics: [] }));
    await new InspectClient({ adminUrl: 'http://oap:17128/', fetch: fetchImpl }).listMetrics();
    expect(calls[0].url).toBe('http://oap:17128/inspect/metrics');
  });

  it('repeats type / catalog filters as separate params, never as one joined value', async () => {
    // OAP parses each occurrence as one enum name; a comma-joined single
    // param matches nothing and the catalog comes back empty.
    const { fetchImpl, calls } = recorder(() => json({ metrics: [] }));
    await new InspectClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl }).listMetrics({
      regex: '^service_.*',
      type: ['REGULAR_VALUE', 'LABELED_VALUE'],
      catalog: ['SERVICE', 'ENDPOINT'],
      mqeQueryable: true,
    });
    const q = query(calls[0].url);
    expect(q.getAll('type')).toEqual(['REGULAR_VALUE', 'LABELED_VALUE']);
    expect(q.getAll('catalog')).toEqual(['SERVICE', 'ENDPOINT']);
    expect(q.get('regex')).toBe('^service_.*');
    expect(q.get('mqeQueryable')).toBe('true');
  });

  it('sends mqeQueryable only when the caller opts in', async () => {
    const { fetchImpl, calls } = recorder(() => json({ metrics: [] }));
    await new InspectClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl }).listMetrics({
      mqeQueryable: false,
    });
    expect(query(calls[0].url).has('mqeQueryable')).toBe(false);
  });
});

describe('InspectClient — entity enumeration', () => {
  it('always sends metric + window + step, and the optional knobs only when set', async () => {
    const { fetchImpl, calls } = recorder(() => json({ rows: [] }));
    const client = new InspectClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    await client.listEntities({
      metric: 'service_cpm',
      start: '2026-07-31 0900',
      end: '2026-07-31 0930',
      step: 'MINUTE',
    });
    await client.listEntities({
      metric: 'foreign_metric',
      start: '2026-07-31',
      end: '2026-07-31',
      step: 'DAY',
      limit: 50,
      valueColumn: 'value',
      valueType: 'LONG',
    });
    const plain = query(calls[0].url);
    expect(plain.get('metric')).toBe('service_cpm');
    expect(plain.get('start')).toBe('2026-07-31 0900');
    expect(plain.get('step')).toBe('MINUTE');
    expect(plain.has('limit')).toBe(false);
    expect(plain.has('valueColumn')).toBe(false);
    expect(plain.has('valueType')).toBe(false);
    const foreign = query(calls[1].url);
    expect(foreign.get('limit')).toBe('50');
    expect(foreign.get('valueColumn')).toBe('value');
    expect(foreign.get('valueType')).toBe('LONG');
  });

  it('posts the foreign-values request as JSON and returns the ExpressionResult', async () => {
    const req: InspectValuesRequest = {
      expression: 'latest(foreign_metric)',
      entity: { scope: 'Service', serviceName: 'agent::songs', normal: true },
      start: '2026-07-31 0900',
      end: '2026-07-31 0930',
      step: 'MINUTE',
      foreignMetrics: [{ name: 'foreign_metric', valueColumn: 'value', valueType: 'LONG' }],
    };
    const result = { type: 'SINGLE_VALUE', results: [{ metric: { labels: [] }, values: [] }] };
    const { fetchImpl, calls } = recorder(() => json(result));
    const got = await new InspectClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
    }).inspectValues(req);
    expect(calls[0].url).toBe('http://oap:17128/inspect/values');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(req);
    expect(got).toEqual(result);
  });
});

describe('InspectClient — errors', () => {
  it('parses the {error} envelope and keeps the 404 that means "inspect module off"', async () => {
    const { fetchImpl } = recorder(() => json({ error: 'no handler bound' }, 404));
    const err = (await new InspectClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl })
      .listMetrics()
      .catch((e: unknown) => e)) as InspectApiError;
    expect(err).toBeInstanceOf(InspectApiError);
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ error: 'no handler bound' });
    expect(err.message).toContain('no handler bound');
  });

  it('keeps a non-JSON error body as raw text', async () => {
    const { fetchImpl } = recorder(() => new Response('gateway timeout', { status: 504 }));
    const err = (await new InspectClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl })
      .listEntities({ metric: 'm', start: 's', end: 'e', step: 'HOUR' })
      .catch((e: unknown) => e)) as InspectApiError;
    expect(err.body).toBe('gateway timeout');
    expect(err.status).toBe(504);
  });
});

// OAP derives the accepted string format from the step and throws
// `verifyDateTimeString` on a mismatch — these two helpers are the contract.
describe('formatInspectDate / isInspectDate', () => {
  const instant = new Date(Date.UTC(2026, 6, 31, 9, 5, 42));

  it('formats each step in the shape OAP accepts for it', () => {
    expect(formatInspectDate(instant, 'DAY')).toBe('2026-07-31');
    expect(formatInspectDate(instant, 'HOUR')).toBe('2026-07-31 09');
    // MINUTE has no separator between hour and minute — `09:05` is rejected.
    expect(formatInspectDate(instant, 'MINUTE')).toBe('2026-07-31 0905');
  });

  it('zero-pads every component', () => {
    expect(formatInspectDate(new Date(Date.UTC(2026, 0, 2, 3, 4)), 'MINUTE')).toBe(
      '2026-01-02 0304',
    );
  });

  it('validates a string against its own step and rejects the other steps’ shapes', () => {
    expect(isInspectDate('2026-07-31', 'DAY')).toBe(true);
    expect(isInspectDate('2026-07-31 09', 'HOUR')).toBe(true);
    expect(isInspectDate('2026-07-31 0905', 'MINUTE')).toBe(true);
    expect(isInspectDate('2026-07-31 0905', 'DAY')).toBe(false);
    expect(isInspectDate('2026-07-31', 'MINUTE')).toBe(false);
    expect(isInspectDate('2026-07-31 09:05', 'MINUTE')).toBe(false);
    expect(isInspectDate('2026-7-31', 'DAY')).toBe(false);
    // The neighbouring steps are the ones that actually get mixed up, and this
    // guard is the BFF's only pre-flight check — a HOUR string that slips
    // through the MINUTE gate reaches OAP and throws verifyDateTimeString.
    expect(isInspectDate('2026-07-31 09', 'MINUTE')).toBe(false);
    expect(isInspectDate('2026-07-31 0905', 'HOUR')).toBe(false);
    expect(isInspectDate('2026-07-31 090542', 'MINUTE')).toBe(false);
  });
});
