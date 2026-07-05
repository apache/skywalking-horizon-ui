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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// OAP + server-offset mocked. fmtSecond returns the raw ms so the test can assert
// the exact window boundary passed to queryAlarms.
vi.mock('../../../client/graphql.js', () => ({ graphqlPost: vi.fn() }));
vi.mock('../../../util/window.js', () => ({
  getServerOffsetMinutes: vi.fn().mockResolvedValue(0),
  fmtSecond: (ms: number) => String(ms),
}));

import { telemetryTools } from './tools.js';
import { graphqlPost } from '../../../client/graphql.js';
import type { AiRequestContext } from '../../context.js';

const gql = graphqlPost as unknown as ReturnType<typeof vi.fn>;
const THREE_H_MS = 3 * 60 * 60_000;
const END = 1_700_000_000_000;

function mockCtx(hasVerb = true) {
  // A DELIBERATELY narrow chat window (10 min) — list_alarms must ignore it.
  const ctx = {
    hasVerb: () => hasVerb,
    opts: {},
    config: {},
    fetch: undefined,
    range: { startMs: END - 10 * 60_000, endMs: END, step: 'SECOND' },
  } as unknown as AiRequestContext;
  return { ctx };
}
function listAlarms(ctx: AiRequestContext) {
  return telemetryTools(ctx)[0];
}

beforeEach(() => gql.mockReset());

describe('telemetry list_alarms', () => {
  it('denies without alarms:read and never touches OAP', async () => {
    const out = String(await listAlarms(mockCtx(false).ctx).invoke({}));
    expect(out).toMatch(/permission|alarms:read/i);
    expect(gql).not.toHaveBeenCalled();
  });

  it('looks back an independent 3h window, NOT the narrow chat range', async () => {
    gql.mockResolvedValue({ queryAlarms: { msgs: [] } });
    await listAlarms(mockCtx().ctx).invoke({});
    const condition = (gql.mock.calls[0][2] as { condition: { duration: { start: string; end: string } } }).condition;
    // start is anchored at end-3h, never clamped up to the chat window's start.
    expect(condition.duration.start).toBe(String(END - THREE_H_MS));
    expect(condition.duration.end).toBe(String(END));
    expect(condition.duration.start).not.toBe(String(END - 10 * 60_000));
  });

  it('lists active (unrecovered) alarms first', async () => {
    gql.mockResolvedValue({
      queryAlarms: {
        msgs: [
          { id: '1', startTime: 1, recoveryTime: 999, scope: 'Service', name: 'recovered', message: 'ok' },
          { id: '2', startTime: 2, recoveryTime: null, scope: 'Service', name: 'firing', message: 'bad' },
        ],
      },
    });
    const rows = JSON.parse(String(await listAlarms(mockCtx().ctx).invoke({}))) as Array<{ active: boolean }>;
    expect(rows[0].active).toBe(true);
    expect(rows[1].active).toBe(false);
  });
});
