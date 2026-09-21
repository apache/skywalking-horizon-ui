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
 * The trace-list status pass. What matters is when it declines to answer: a
 * truncated error set, a Zipkin `status="ok"` the backend drops, and a failed
 * second search must all leave the row UNKNOWN, because the alternative is a
 * failed trace rendered green.
 */

import { describe, it, expect } from 'vitest';
import type { FetchLike, TraceQLTraceRow } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import { buildTraceQLOpts, encodeNativeTraceId } from '../../client/traceql.js';
import { fillTraceStatuses, statusTermIn, withStatusError } from './status.js';

const TRACEQL_URL = 'http://oap.test:3200';

function row(traceId: string, isError?: boolean): TraceQLTraceRow {
  return {
    traceId,
    rootService: 'agent::ui',
    rootName: '/homepage',
    startMs: 1_700_000_000_000,
    durationMs: 12,
    spanCount: 3,
    services: ['agent::ui'],
    ...(isError === undefined ? {} : { isError }),
  };
}

/** A search answering with these ids, and recording what it was asked. */
function backend(ids: string[]) {
  const asked: string[] = [];
  const fetch: FetchLike = async (url) => {
    const u = new URL(String(url));
    asked.push(u.searchParams.get('q') ?? '');
    return new Response(
      JSON.stringify({
        traces: ids.map((id) => ({
          traceID: encodeNativeTraceId(id),
          rootServiceName: 'agent::ui',
          rootTraceName: '/homepage',
          startTimeUnixNano: '1700000000000000000',
          durationMs: 12,
          spanSets: [],
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const opts = buildTraceQLOpts(configSchema.parse({ oap: { traceql: { url: TRACEQL_URL, nativePath: '/skywalking' } } }), 'native', fetch)!;
  return { opts, asked };
}

const PARAMS = { q: '{resource.service.name="agent::ui"}', startMs: 1, endMs: 2, limit: 3 };

describe('traceql trace-list status', () => {
  it('reads a status the expression already fixes, without a second search', async () => {
    expect(statusTermIn('{status="error"}')).toBe('error');
    expect(statusTermIn('{ status = "ok" }')).toBe('ok');
    expect(statusTermIn('{status="STATUS_CODE_OK"}')).toBe('other');
    expect(statusTermIn('{resource.service.name="a"}')).toBeNull();
    // An application tag that merely ENDS in `status` is not the intrinsic.
    expect(statusTermIn('{span.business_status="ok"}')).toBeNull();
    expect(statusTermIn('{span.http_status="error"}')).toBeNull();
    // A value that merely CONTAINS the token is not a status condition.
    expect(statusTermIn('{span.message="status=\\"error\\""}')).toBeNull();

    const { opts, asked } = backend([]);
    const out = await fillTraceStatuses(opts, { ...PARAMS, q: '{status="error"}' }, [row('a'), row('b')]);
    expect(out.map((r) => r.isError)).toEqual([true, true]);
    expect(asked).toEqual([]);
  });

  it('marks the failures it is told about, and infers nothing from a miss', async () => {
    const { opts, asked } = backend(['b']);
    const out = await fillTraceStatuses(opts, PARAMS, [row('a'), row('b'), row('c')]);
    // Measured on the demo: OAP matches these conditions per SEGMENT, so a
    // trace can fail downstream and still be absent from this answer. Absence
    // therefore establishes nothing — those rows stay unknown for the reader.
    expect(out.map((r) => r.isError)).toEqual([undefined, true, undefined]);
    expect(asked).toEqual(['{resource.service.name="agent::ui" && status="error"}']);
  });

  it('does not read a status term inside an alternation as a promise', async () => {
    // `{status="error" || status="ok"}` selects both, so the first term says
    // nothing about any given row. Painting them all red is a wrong answer
    // that also stops the per-trace read from ever correcting it.
    const { opts } = backend([]);
    const out = await fillTraceStatuses(opts, { ...PARAMS, q: '{status="error" || status="ok"}' }, [row('a'), row('b')]);
    expect(out.map((r) => r.isError)).toEqual([undefined, undefined]);
    // A literal that merely CONTAINS `||` is not an alternation.
    const fixed = await fillTraceStatuses(opts, { ...PARAMS, q: '{span.name="a||b" && status="error"}' }, [row('a')]);
    expect(fixed[0]!.isError).toBe(true);
  });

  it('does not read status="ok" as success', async () => {
    const { opts, asked } = backend([]);
    const out = await fillTraceStatuses(opts, { ...PARAMS, q: '{status="ok"}' }, [row('a')]);
    expect(out[0]!.isError).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('keeps a status the search already reported', async () => {
    const { opts } = backend([]);
    const out = await fillTraceStatuses(opts, PARAMS, [row('a', true), row('b')]);
    expect(out.map((r) => r.isError)).toEqual([true, undefined]);
  });

  it('extends only the single spanset the editor allows', () => {
    expect(withStatusError('{}')).toBe('{status="error"}');
    expect(withStatusError(undefined)).toBe('{status="error"}');
    expect(withStatusError('{duration>1ms}')).toBe('{duration>1ms && status="error"}');
    // A shape the editor refuses to run is not one to rewrite either.
    expect(withStatusError('{a} | count()')).toBeNull();
  });

  it('costs the statuses, not the list, when the second search fails', async () => {
    const fetch: FetchLike = async () => new Response('nope', { status: 500 });
    const opts = buildTraceQLOpts(
      configSchema.parse({ oap: { traceql: { url: TRACEQL_URL, nativePath: '/skywalking' } } }),
      'native',
      fetch,
    )!;
    const out = await fillTraceStatuses(opts, PARAMS, [row('a')]);
    expect(out[0]!.isError).toBeUndefined();
  });
});
