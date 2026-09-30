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
import type { ServiceCatalog, ServiceLayerCatalog } from '../../../../logic/services/service-layer-catalog.js';

// OAP + server-offset mocked. fmtSecond returns the raw ms so the test can assert
// the exact window boundary passed to queryAlarms.
vi.mock('../../../../client/graphql.js', () => ({ graphqlPost: vi.fn(), buildOapOpts: () => ({}) }));
vi.mock('../../../../util/window.js', () => ({
  getServerOffsetMinutes: vi.fn().mockResolvedValue(0),
  fmtSecond: (ms: number) => String(ms),
}));
const held = vi.hoisted(() => ({ catalog: null as ServiceCatalog | null }));
vi.mock('../../../../logic/services/service-layer-catalog.js', () => ({
  serviceLayerCatalog: () => ({ get: async () => held.catalog }),
}));

import { telemetryTools } from './tools.js';
import { graphqlPost } from '../../../../client/graphql.js';
import type { ToolContext } from '../../tool-context.js';
import { configSchema } from '../../../../config/schema.js';
import type { ConfigSource } from '../../../../config/loader.js';
import { SessionAccess } from '../../../../rbac/layer-access.js';
import { RequestAccess } from '../../../../rbac/request-access.js';
import { ServiceIdentityResolver, serviceIdOf } from '../../../../logic/services/service-identity.js';

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
  } as unknown as ToolContext;
  return { ctx };
}
function listAlarms(ctx: ToolContext) {
  return telemetryTools(ctx)[0];
}

beforeEach(() => {
  gql.mockReset();
  held.catalog = CATALOG;
});

const svc = (name: string, group = '') => ({ id: serviceIdOf(name, true), name, normal: true, group });
const checkout = svc('payments::checkout', 'payments');
const scorer = svc('risk::scorer', 'risk');
const bdb = svc('showcase-banyandb');
const CATALOG: ServiceCatalog = {
  layers: ['GENERAL', 'BANYANDB'],
  byLayer: new Map([
    ['GENERAL', [checkout, scorer]],
    ['BANYANDB', [bdb]],
  ]),
  byName: new Map(),
};
const alarm = (scope: string, id: string, name: string) => ({ id, startTime: 1, recoveryTime: null, scope, name, message: name });
const ALARMS = [
  alarm('Service', checkout.id, checkout.name),
  alarm('Service', scorer.id, scorer.name),
  alarm('Service', bdb.id, bdb.name),
  alarm('ServiceRelation', scorer.id, `${scorer.name} to ${checkout.name}`),
  alarm('All', '', 'the deployment'),
];

/** OAP answering the alarm read with `msgs`, and `getService` with no such
 *  service — or not at all when `down`. */
function answer(msgs: unknown[], down = false): void {
  gql.mockImplementation(async (_opts: unknown, query: string) => {
    if (query.includes('HorizonAccessService')) {
      if (down) throw new Error('connect ECONNREFUSED');
      return { service: null };
    }
    return { queryAlarms: { msgs } };
  });
}

/** A context whose caller holds exactly `grants`. */
function ctxFor(grants: string[]): ToolContext {
  const cfg = configSchema.parse({});
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const catalog = { get: async () => held.catalog } as unknown as ServiceLayerCatalog;
  const facts = { isOperate: (l: string) => l === 'BANYANDB', canonical: (l: string) => l.toUpperCase() };
  const access = new RequestAccess(new SessionAccess(grants, undefined, facts), new ServiceIdentityResolver({ config, catalog }));
  return { ...mockCtx().ctx, access } as ToolContext;
}

const listed = async (ctx: ToolContext, args: Record<string, string> = {}) => String(await listAlarms(ctx).invoke(args));
const namesOf = (out: string) => (JSON.parse(out) as Array<{ name: string }>).map((r) => r.name);

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

  // OAP stores one layer per alarm — its entity's first, or none.
  it('applies a layer by the layers of the services an alarm concerns, never sending it to OAP', async () => {
    answer(ALARMS);
    const out = await listed(mockCtx().ctx, { layer: 'general' });
    expect(namesOf(out)).toEqual([checkout.name, scorer.name, `${scorer.name} to ${checkout.name}`]);
    const condition = (gql.mock.calls.find((c) => String(c[1]).includes('AiQueryAlarms'))![2] as { condition: Record<string, unknown> }).condition;
    expect(condition.layer).toBeUndefined();
  });

  it('answers a layer-limited caller with the alarms it may read, instead of refusing', async () => {
    answer(ALARMS);
    const out = await listed(ctxFor(['alarms:read@GENERAL[payments]']));
    expect(namesOf(out)).toEqual([checkout.name, `${scorer.name} to ${checkout.name}`]);
  });

  it('leaves out a plain reader\'s alarms of services only in an operate layer, without cluster:read', async () => {
    answer(ALARMS);
    expect(namesOf(await listed(ctxFor(['alarms:read'])))).not.toContain(bdb.name);
    answer(ALARMS);
    expect(namesOf(await listed(ctxFor(['alarms:read', 'cluster:read'])))).toContain(bdb.name);
  });

  it('does not tell a filtered reader that nothing is firing anywhere', async () => {
    answer(ALARMS);
    expect(await listed(mockCtx().ctx, { layer: 'mesh' })).toBe('No alarms in the recent window for layer MESH.');
    answer([ALARMS[1]]);
    expect(await listed(ctxFor(['alarms:read@GENERAL[payments]']))).toMatch(/services the current user may read/);
    answer([]);
    expect(await listed(mockCtx().ctx)).toMatch(/nothing is firing/);
  });

  it('narrows to one service group of a layer, written as a grant qualifies it', async () => {
    answer(ALARMS);
    const out = await listed(mockCtx().ctx, { layer: 'general[payments]' });
    expect(namesOf(out)).toEqual([checkout.name, `${scorer.name} to ${checkout.name}`]);
  });

  it('says a layer filter that names no layer is not one, rather than listing every layer', async () => {
    answer(ALARMS);
    expect(await listed(mockCtx().ctx, { layer: 'general~payments' })).toMatch(/is not a layer/);
  });

  // The filtered read stops at its budget; an empty answer is then no proof.
  it('says a filtered read that ran out of budget did not read the older alarms', async () => {
    answer(Array.from({ length: 2_500 }, () => ALARMS[1]));
    const out = await listed(ctxFor(['alarms:read@GENERAL[payments]']));
    expect(out).toMatch(/None of the newest 2000 alarms/);
    expect(out).toMatch(/does not show that nothing is firing/);
  });

  it('refuses a caller holding alarms:read on no layer at all', async () => {
    const out = await listed(ctxFor(['metrics:read']));
    expect(out).toMatch(/^Permission denied:.*alarms:read/);
    expect(gql).not.toHaveBeenCalled();
  });

  it('says OAP could not be asked whose an alarm is, not that permission is missing', async () => {
    const ghost = svc('payments::ghost', 'payments');
    answer([alarm('Service', ghost.id, ghost.name)], true);
    const out = await listed(ctxFor(['alarms:read@GENERAL[payments]']));
    expect(out).toMatch(/not a permission problem/);
  });

  it('says the service catalog could not be read rather than that nothing is firing', async () => {
    held.catalog = { layers: [], byLayer: new Map(), byName: new Map(), unreachable: true };
    answer(ALARMS);
    const out = await listed(ctxFor(['alarms:read@GENERAL[payments]']));
    expect(out).toMatch(/catalog could not be read/);
  });
});
