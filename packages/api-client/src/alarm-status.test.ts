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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AlarmStatusApiError,
  AlarmStatusClient,
  type AlarmRunningContext,
  type ClusterAlarmStatus,
  type FetchLike,
} from './alarm-status.js';

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

const headersOf = (call: Recorded): Record<string, string> =>
  (call.init.headers as Record<string, string> | undefined) ?? {};

describe('AlarmStatusClient — endpoint targeting', () => {
  it('strips a trailing slash from adminUrl', async () => {
    const { fetchImpl, calls } = recorder(() => json({ oapInstances: [] }));
    await new AlarmStatusClient({ adminUrl: 'http://oap:17128/', fetch: fetchImpl }).listRules();
    expect(calls[0].url).toBe('http://oap:17128/status/alarm/rules');
  });

  it('percent-encodes the rule id and entity name so path-shaped names do not split the URL', async () => {
    // Endpoint-scoped alarms carry names like `GET:/api/v1/orders`; an unencoded
    // slash would address a different (non-existent) route and 404 the pane.
    const { fetchImpl, calls } = recorder(() => json({ oapInstances: [] }));
    const client = new AlarmStatusClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl });
    await client.ruleDetail('endpoint_resp_time_rule');
    await client.ruleContext('endpoint_resp_time_rule', 'GET:/api/v1/orders');
    expect(calls[0].url).toBe('http://oap:17128/status/alarm/endpoint_resp_time_rule');
    expect(calls[1].url).toBe(
      'http://oap:17128/status/alarm/endpoint_resp_time_rule/GET%3A%2Fapi%2Fv1%2Forders',
    );
  });

  it('reads with GET, Accept: application/json and the configured default headers', async () => {
    const { fetchImpl, calls } = recorder(() => json({ oapInstances: [] }));
    await new AlarmStatusClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
      headers: { Authorization: 'Basic c2VjcmV0' },
    }).listRules();
    expect(calls[0].init.method).toBe('GET');
    expect(headersOf(calls[0]).Accept).toBe('application/json');
    expect(headersOf(calls[0]).Authorization).toBe('Basic c2VjcmV0');
  });
});

describe('AlarmStatusClient — cluster envelope', () => {
  it('returns every node slice verbatim, including a node that failed to answer', async () => {
    // The UI unions the per-node slices; dropping or collapsing a null-status
    // node would hide that part of the cluster was not read at all.
    const envelope: ClusterAlarmStatus<AlarmRunningContext> = {
      oapInstances: [
        {
          address: 'Self()',
          status: {
            ruleId: 'service_resp_time_rule',
            expression: 'sum(service_resp_time > 1000) >= 3',
            additionalPeriod: 0,
            size: 10,
            silenceCountdown: -1,
            recoveryObservationCountdown: -1,
            currentState: 'FIRING',
            entityName: 'agent::songs',
            windowValues: [{ index: 0, metrics: [] }],
            lastAlarmTime: '1717070000000',
          },
        },
        { address: '10.0.0.2:11800', errorMsg: 'DEADLINE_EXCEEDED', status: null },
      ],
    };
    const { fetchImpl } = recorder(() => json(envelope));
    const got = await new AlarmStatusClient({
      adminUrl: 'http://oap:17128',
      fetch: fetchImpl,
    }).ruleContext('service_resp_time_rule', 'agent::songs');
    expect(got).toEqual(envelope);
    expect(got.oapInstances[1].status).toBeNull();
    expect(got.oapInstances[1].errorMsg).toBe('DEADLINE_EXCEEDED');
  });
});

describe('AlarmStatusClient — errors', () => {
  it('surfaces the HTTP status so a missing rule maps to 404 rather than a generic 502', async () => {
    const { fetchImpl } = recorder(() => new Response('rule not found', { status: 404 }));
    const err = (await new AlarmStatusClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl })
      .ruleDetail('gone')
      .catch((e: unknown) => e)) as AlarmStatusApiError;
    expect(err).toBeInstanceOf(AlarmStatusApiError);
    expect(err.name).toBe('AlarmStatusApiError');
    expect(err.status).toBe(404);
    expect(err.url).toContain('/status/alarm/gone');
    expect(err.body).toBe('rule not found');
  });

  it('keeps the whole body on the error while capping the message at 200 chars', async () => {
    const body = 'y'.repeat(400);
    const { fetchImpl } = recorder(() => new Response(body, { status: 500 }));
    const err = (await new AlarmStatusClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl })
      .listRules()
      .catch((e: unknown) => e)) as AlarmStatusApiError;
    expect(err.body).toBe(body);
    expect(err.message).toContain('y'.repeat(200));
    expect(err.message).not.toContain('y'.repeat(201));
  });
});

describe('AlarmStatusClient — timeout plumbing', () => {
  afterEach(() => vi.useRealTimers());

  it('sends no abort signal when timeoutMs is 0 (disabled)', async () => {
    const { fetchImpl, calls } = recorder(() => json({ oapInstances: [] }));
    await new AlarmStatusClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl }).listRules();
    expect(calls[0].init.signal).toBeUndefined();
  });

  it('aborts the in-flight request once timeoutMs elapses, and clears the timer otherwise', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const hang = new AlarmStatusClient({
      adminUrl: 'http://oap:17128',
      timeoutMs: 2_000,
      fetch: async (_url, init) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          seen?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
        });
      },
    });
    const pending = expect(hang.listRules()).rejects.toThrow('aborted by timeout');
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(seen?.aborted).toBe(true);

    let settled: AbortSignal | undefined;
    const fast = new AlarmStatusClient({
      adminUrl: 'http://oap:17128',
      timeoutMs: 2_000,
      fetch: async (_url, init) => {
        settled = init?.signal ?? undefined;
        return json({ oapInstances: [] });
      },
    });
    await fast.listRules();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled?.aborted).toBe(false);
  });
});
