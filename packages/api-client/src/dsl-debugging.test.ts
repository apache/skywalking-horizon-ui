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
  DEBUG_CATALOGS,
  DslDebuggingClient,
  GRANULARITIES,
  MAX_RECORD_CAP,
  MAX_RETENTION_MILLIS,
  isDebugCatalog,
  isGranularity,
  type StartSessionArgs,
} from './dsl-debugging.js';
import { RuntimeRuleApiError } from './types.js';
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

const headersOf = (call: Recorded): Record<string, string> =>
  (call.init.headers as Record<string, string> | undefined) ?? {};

const query = (url: string): URLSearchParams => new URL(url).searchParams;

const START: StartSessionArgs = {
  clientId: 'tab-1',
  catalog: 'lal',
  name: 'k8s-service',
  ruleName: 'k8s-service',
};

const client = (fetchImpl: FetchLike, timeoutMs = 0): DslDebuggingClient =>
  new DslDebuggingClient({ adminUrl: 'http://oap:17128', fetch: fetchImpl, timeoutMs });

describe('DslDebuggingClient — session start', () => {
  it('carries the four mandatory inputs as query params, percent-encoded', async () => {
    const { fetchImpl, calls } = recorder(() => json({ sessionId: 's-1' }));
    await client(fetchImpl).startSession({
      ...START,
      catalog: 'otel-rules',
      name: 'vm rules/linux',
      ruleName: 'meter_vm_cpu_total{a="b"}',
    });
    const q = query(calls[0].url);
    expect(new URL(calls[0].url).pathname).toBe('/dsl-debugging/session');
    expect(q.get('catalog')).toBe('otel-rules');
    expect(q.get('name')).toBe('vm rules/linux');
    expect(q.get('ruleName')).toBe('meter_vm_cpu_total{a="b"}');
    expect(q.get('clientId')).toBe('tab-1');
    expect(calls[0].init.method).toBe('POST');
  });

  it('sends no body and no Content-Type when no limits are given, so OAP applies its defaults', async () => {
    const { fetchImpl, calls } = recorder(() => json({ sessionId: 's-1' }));
    await client(fetchImpl).startSession(START);
    expect(calls[0].init.body).toBeUndefined();
    expect(headersOf(calls[0])['Content-Type']).toBeUndefined();
  });

  it('sends recordCap / retentionMillis as a JSON body when supplied', async () => {
    const { fetchImpl, calls } = recorder(() => json({ sessionId: 's-1' }));
    await client(fetchImpl).startSession({ ...START, recordCap: 20, retentionMillis: 60_000 });
    expect(headersOf(calls[0])['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      recordCap: 20,
      retentionMillis: 60_000,
    });
  });

  it('routes granularity through the query param only — the channel the server prefers', async () => {
    const { fetchImpl, calls } = recorder(() => json({ sessionId: 's-1' }));
    const c = client(fetchImpl);
    await c.startSession(START);
    await c.startSession({ ...START, granularity: 'statement', recordCap: 5 });
    expect(query(calls[0].url).has('granularity')).toBe(false);
    expect(query(calls[1].url).get('granularity')).toBe('statement');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ recordCap: 5 });
  });
});

describe('DslDebuggingClient — session polling and stop', () => {
  it('returns null on 404 so a poller can stop without treating it as a transport failure', async () => {
    const { fetchImpl } = recorder(() =>
      json({ status: 'error', code: 'session_not_found', message: 'gone' }, 404),
    );
    await expect(client(fetchImpl).getSession('s-1')).resolves.toBeNull();
  });

  it('still throws on a non-404 failure while polling', async () => {
    const { fetchImpl } = recorder(() => new Response('boom', { status: 500 }));
    await expect(client(fetchImpl).getSession('s-1')).rejects.toBeInstanceOf(RuntimeRuleApiError);
  });

  it('percent-encodes the session id in the path on both read and stop', async () => {
    const { fetchImpl, calls } = recorder(() => json({ sessionId: 'a/b' }));
    const c = client(fetchImpl);
    await c.getSession('a/b c');
    await c.stopSession('a/b c');
    expect(calls[0].url).toBe('http://oap:17128/dsl-debugging/session/a%2Fb%20c');
    expect(calls[1].url).toBe('http://oap:17128/dsl-debugging/session/a%2Fb%20c/stop');
    expect(calls[1].init.method).toBe('POST');
  });

  it('passes the multi-node session envelope through untouched', async () => {
    const envelope = {
      sessionId: 's-1',
      capturedAt: 1717070000000,
      ruleKey: { catalog: 'lal', name: 'k8s-service', ruleName: 'k8s-service' },
      nodes: [
        { nodeId: 'n1', status: 'ok', records: [{ startedAtMs: 1, dsl: 'text', rule: {}, samples: [] }] },
        { peer: '10.0.0.2:11800', status: 'unreachable', records: [], detail: 'timeout' },
      ],
    };
    const { fetchImpl } = recorder(() => json(envelope));
    await expect(client(fetchImpl).getSession('s-1')).resolves.toEqual(envelope);
  });
});

describe('DslDebuggingClient — error envelopes', () => {
  it('parses the {status,code,message} envelope into an object body so callers can switch on code', async () => {
    // The BFF derives its audit outcome and the UI its message from `code`;
    // a raw-string body would degrade every rejection to `http_<status>`.
    // Verbatim 400 body OAP answers when the requested recordCap is over
    // `SessionLimits.MAX_RECORD_CAP` — this client forwards the number as
    // given, so that is the reply a 500-record request gets.
    const body = {
      status: 'error',
      code: 'invalid_limits',
      message: 'recordCap 500 exceeds hard cap 100',
    };
    const { fetchImpl } = recorder(() => json(body, 400));
    const err = (await client(fetchImpl)
      .startSession({ ...START, recordCap: 500 })
      .catch((e: unknown) => e)) as RuntimeRuleApiError;
    expect(err).toBeInstanceOf(RuntimeRuleApiError);
    expect(err.status).toBe(400);
    expect(err.body).toEqual(body);
    expect(err.url).toContain('/dsl-debugging/session');
    // The thrown message is the only place the code survives for a caller
    // that logs the Error rather than reading `body`, so both the code and
    // the message have to land in it.
    expect(err.message).toContain('invalid_limits: recordCap 500 exceeds hard cap 100');
    expect(err.message).not.toContain('undefined');
  });

  it('keeps the per-peer install state the two install-time rejections carry', async () => {
    // `rule_not_found` / `too_many_sessions` extend the envelope with
    // `peers[]` — the BFF hands the whole body to the SPA, so the extra
    // field has to survive the parse instead of being trimmed to the three
    // envelope keys or degraded to text.
    const body = {
      status: 'error',
      code: 'rule_not_found',
      message:
        `No live DSL artifact bound to rule RuleKey(catalog=LAL, name=k8s-service, ` +
        `ruleName=k8s-service) on any reachable OAP node. Possible causes: rule never ` +
        `loaded (static-loader doesn't claim this name), rule was inactivated via ` +
        `runtime-rule, or the cluster hasn't compiled it yet. Per-peer install state ` +
        `is in peers[].`,
      peers: [{ peer: '10.0.0.2:11800', nodeId: 'n2', ack: 'NOT_LOCAL' }],
    };
    const { fetchImpl } = recorder(() => json(body, 404));
    const err = (await client(fetchImpl)
      .startSession(START)
      .catch((e: unknown) => e)) as RuntimeRuleApiError;
    expect(err.status).toBe(404);
    expect(err.body).toEqual(body);
    expect(err.message).toContain('rule_not_found: No live DSL artifact bound to rule');
    expect(err.message).not.toContain('undefined');
  });

  it('keeps a non-JSON body as raw text instead of inventing an envelope', async () => {
    const { fetchImpl } = recorder(() => new Response('<html>503</html>', { status: 503 }));
    const err = (await client(fetchImpl)
      .listSessions()
      .catch((e: unknown) => e)) as RuntimeRuleApiError;
    expect(err.body).toBe('<html>503</html>');
    expect(err.status).toBe(503);
  });

  it('leaves a JSON body that matches neither envelope as raw text', async () => {
    const { fetchImpl } = recorder(() => json({ code: 'oops' }, 400));
    const err = (await client(fetchImpl)
      .getStatus()
      .catch((e: unknown) => e)) as RuntimeRuleApiError;
    expect(err.body).toBe('{"code":"oops"}');
  });
});

describe('dsl-debugging vocabulary', () => {
  it('mirrors OAP SessionLimits — 100 records, 1 hour retention', () => {
    // The BFF rejects out-of-range requests against these (it bounds
    // retention with the literal 3_600_000) before the OAP round-trip; drift
    // here means the UI offers limits OAP will refuse.
    expect(MAX_RECORD_CAP).toBe(100);
    expect(MAX_RETENTION_MILLIS).toBe(3_600_000);
  });

  it('accepts every debuggable catalog, including OAL', () => {
    // isDebugCatalog derives from DEBUG_CATALOGS, so membership is pinned
    // directly — a silently dropped entry (say `telegraf-rules`) would sail
    // through the loop below while every debug session for that catalog gets
    // rejected `invalid_catalog`.
    expect([...DEBUG_CATALOGS].sort()).toEqual([
      'lal',
      'log-mal-rules',
      'oal',
      'otel-rules',
      'telegraf-rules',
    ]);
    for (const c of DEBUG_CATALOGS) expect(isDebugCatalog(c)).toBe(true);
    expect(isDebugCatalog('oal')).toBe(true);
    expect(isDebugCatalog('alarm')).toBe(false);
    expect(isDebugCatalog(undefined)).toBe(false);
    expect(isDebugCatalog(7)).toBe(false);
  });

  it('accepts only the two LAL granularities', () => {
    for (const g of GRANULARITIES) expect(isGranularity(g)).toBe(true);
    expect(isGranularity('BLOCK')).toBe(false);
    expect(isGranularity('line')).toBe(false);
    expect(isGranularity(null)).toBe(false);
  });
});
