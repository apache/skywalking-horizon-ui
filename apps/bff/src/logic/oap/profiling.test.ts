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
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { GraphqlOptions } from '../../client/graphql.js';
import { analyzeProfiling, pickAnalyzedEvent, summaryEventOrder } from './profiling.js';

describe('pickAnalyzedEvent', () => {
  it('picks the first event when none is requested', () => {
    expect(pickAnalyzedEvent(['CPU', 'ALLOC'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: ['ALLOC'],
    });
  });

  it('honours a requested event the task actually captured', () => {
    expect(pickAnalyzedEvent(['CPU', 'ALLOC'], 'ALLOC')).toEqual({
      primaryEvent: 'ALLOC',
      otherEvents: ['CPU'],
    });
  });

  it('falls back to the first event when the requested one was not captured', () => {
    expect(pickAnalyzedEvent(['CPU', 'ALLOC'], 'LOCK')).toEqual({
      primaryEvent: 'CPU',
      otherEvents: ['ALLOC'],
    });
  });

  // CPU / WALL / CTIMER / ITIMER all resolve to the identical EXECUTION_SAMPLE
  // JFR request — a task capturing two of them has ONE dataset, so the sibling
  // must not be offered as "call again to see a different result".
  it('does not name a same-JFR-type sibling as an "other" event', () => {
    expect(pickAnalyzedEvent(['CPU', 'WALL'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: [],
    });
  });

  it('drops only the same-JFR siblings, keeping a genuinely different event', () => {
    expect(pickAnalyzedEvent(['CPU', 'WALL', 'ALLOC'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: ['ALLOC'],
    });
  });

  it('treats an unrecognised event as its own EXECUTION_SAMPLE-equivalent bucket', () => {
    // Falls back to the same default as CPU/WALL/etc, so it is still
    // recognised as a sibling rather than wrongly listed as "other".
    expect(pickAnalyzedEvent(['CPU', 'SOMETHING_NEW'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: [],
    });
  });

  it('has no other events for a single-event task', () => {
    expect(pickAnalyzedEvent(['CPU'], undefined)).toEqual({ primaryEvent: 'CPU', otherEvents: [] });
  });

  // The "other events" must also be deduped AMONG THEMSELVES, not just
  // against the primary — CPU and WALL both resolve to EXECUTION_SAMPLE, so
  // offering both as follow-ups would be two names for the identical result.
  it('dedupes same-JFR-type siblings against each other, not just against the primary', () => {
    expect(pickAnalyzedEvent(['CPU', 'WALL', 'ALLOC'], undefined)).toEqual({
      primaryEvent: 'CPU',
      otherEvents: ['ALLOC'],
    });
  });

  // Inverse of the case above: the PRIMARY is the odd one out (ALLOC), and
  // the two same-JFR siblings (CPU, WALL) are among the "others" — exactly
  // the shape the original bug missed, since the old code only compared each
  // other-event against the PRIMARY's JFR key, never against each other.
  it('dedupes same-JFR-type siblings when the primary is the DIFFERENT event (inverse case)', () => {
    expect(pickAnalyzedEvent(['ALLOC', 'CPU', 'WALL'], 'ALLOC')).toEqual({
      primaryEvent: 'ALLOC',
      otherEvents: ['CPU'],
    });
  });

  it('keeps genuinely distinct events (CPU, LOCK, ALLOC all differ)', () => {
    expect(pickAnalyzedEvent(['ALLOC', 'CPU', 'LOCK'], 'ALLOC')).toEqual({
      primaryEvent: 'ALLOC',
      otherEvents: ['CPU', 'LOCK'],
    });
  });
});

describe('summaryEventOrder', () => {
  // The bug this guards: reusing pickAnalyzedEvent's JFR-deduped `otherEvents`
  // for the task-fact summary made a CPU+WALL task display as "CPU" only —
  // the summary is "what did this task capture", not "what is worth
  // re-analyzing", and those two questions have different answers.
  it('keeps a same-JFR-type sibling that pickAnalyzedEvent would drop', () => {
    expect(summaryEventOrder(['CPU', 'WALL'], 'CPU')).toEqual(['CPU', 'WALL']);
  });

  it('puts the primary event first regardless of its position in the capture list', () => {
    expect(summaryEventOrder(['CPU', 'ALLOC'], 'ALLOC')).toEqual(['ALLOC', 'CPU']);
  });

  it('keeps every event for a task with three or more', () => {
    expect(summaryEventOrder(['CPU', 'WALL', 'ALLOC'], 'CPU')).toEqual(['CPU', 'WALL', 'ALLOC']);
  });

  it('is just the primary event for a single-event task', () => {
    expect(summaryEventOrder(['CPU'], 'CPU')).toEqual(['CPU']);
  });
});

/* The assistant's `analyze_profiling` tool hands over a service NAME and no id
 * (its schema carries none), so this is the one path that still turns a name
 * into an id. It matches the NAME column only: the id column used to be a
 * fallback, which let an id-shaped name — or an id in the name slot — address a
 * different service than the one named. */
describe('analyzeProfiling resolves the assistant\'s service NAME', () => {
  const SERVICE_ID = 'c29uZ3M=.1';
  interface Captured {
    query: string;
    variables: Record<string, unknown>;
  }

  function oap(): { opts: GraphqlOptions; calls: Captured[] } {
    const calls: Captured[] = [];
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
      calls.push({ query: body.query, variables: body.variables ?? {} });
      const data = body.query.includes('listServices')
        ? { services: [{ id: SERVICE_ID, name: 'songs' }] }
        : { taskList: [] };
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { opts: { queryUrl: 'http://oap:12800', timeoutMs: 5000, fetch }, calls };
  }

  it('queries the resolved id', async () => {
    const { opts, calls } = oap();
    const out = await analyzeProfiling({ opts, profilingType: 'trace', layerKey: 'general', service: 'songs' });
    expect(out.reachable).toBe(true);
    const taskList = calls.find((c) => c.query.includes('getProfileTaskList'));
    expect(taskList?.variables.serviceId).toBe(SERVICE_ID);
  });

  it('refuses an id handed to the name slot instead of answering for it', async () => {
    const { opts, calls } = oap();
    const out = await analyzeProfiling({ opts, profilingType: 'trace', layerKey: 'general', service: SERVICE_ID });
    expect(out.reachable).toBe(false);
    expect(out.error).toContain('Unknown service');
    expect(calls.some((c) => c.query.includes('getProfileTaskList'))).toBe(false);
  });
});
