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
import {
  matchServiceInRoster,
  resolveRequiredService,
  resolveRequiredServiceArgs,
  resolveServiceArgs,
  resolveServiceScope,
  serviceArgsFromQuery,
  type RosterService,
} from './service-scope.js';

const SERVICE_ID = 'bWVzaC1zdnI6OnNvbmdz.1';

interface Captured {
  query: string;
  variables: Record<string, unknown>;
}

function oap(services: RosterService[] | null): {
  opts: GraphqlOptions;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
    calls.push({ query: body.query, variables: body.variables ?? {} });
    return new Response(JSON.stringify({ data: { services } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { opts: { queryUrl: 'http://oap:12800', timeoutMs: 5000, fetch }, calls };
}

describe('resolveServiceScope', () => {
  it('reports "all" for a caller that supplied no service, without asking OAP', async () => {
    const { opts, calls } = oap([]);
    expect(await resolveServiceScope(opts, 'mesh', undefined)).toEqual({ kind: 'all' });
    expect(await resolveServiceScope(opts, 'mesh', '')).toEqual({ kind: 'all' });
    expect(await resolveServiceScope(opts, 'mesh', null)).toEqual({ kind: 'all' });
    expect(calls).toHaveLength(0);
  });

  // The name slot is for names, but a caller that hands it an id still gets the
  // right answer — through the roster's `id` column, not a shape test.
  it('matches an id handed to the name slot against the roster', async () => {
    const { opts, calls } = oap([{ id: SERVICE_ID, name: 'songs' }]);
    expect(await resolveServiceScope(opts, 'mesh', SERVICE_ID)).toEqual({
      kind: 'service',
      serviceId: SERVICE_ID,
    });
    expect(calls).toHaveLength(1);
  });

  it('resolves a name through listServices, asking for the UPPER-CASE layer', async () => {
    const { opts, calls } = oap([{ id: SERVICE_ID, name: 'songs' }]);
    expect(await resolveServiceScope(opts, 'mesh', 'songs')).toEqual({
      kind: 'service',
      serviceId: SERVICE_ID,
    });
    expect(calls[0]?.variables).toEqual({ layer: 'MESH' });
  });

  // A name with a dot is NOT an id: the loose "contains . and no whitespace"
  // test used to classify mesh names like `*.sample-services` as ids.
  it('still looks up a dotted service name instead of treating it as an id', async () => {
    const { opts, calls } = oap([{ id: SERVICE_ID, name: 'songs.sample-services' }]);
    expect(await resolveServiceScope(opts, 'mesh', 'songs.sample-services')).toEqual({
      kind: 'service',
      serviceId: SERVICE_ID,
    });
    expect(calls).toHaveLength(1);
  });

  // An OAP service id is `base64(<name>).<0|1>`, and an ordinary name can wear
  // that shape: `api.1` (base64 alphabet + `.1`), `orders.2026`. A shape test
  // classified both as ids and sent them to OAP as ids, where they matched
  // nothing. They are NAMES and must be looked up.
  it.each(['api.1', 'orders.2026'])('resolves the id-shaped name %s as a NAME', async (name) => {
    const { opts, calls } = oap([{ id: SERVICE_ID, name }]);
    expect(await resolveServiceScope(opts, 'mesh', name)).toEqual({
      kind: 'service',
      serviceId: SERVICE_ID,
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses an id-shaped name the layer does not have, instead of passing it through', async () => {
    const { opts } = oap([{ id: SERVICE_ID, name: 'songs' }]);
    const scope = await resolveServiceScope(opts, 'mesh', 'api.1');
    expect(scope).toMatchObject({ kind: 'unknown', serviceArg: 'api.1' });
  });

  it('reports "unknown" — never "all" — when the name matches nothing', async () => {
    const { opts } = oap([{ id: SERVICE_ID, name: 'songs' }]);
    const scope = await resolveServiceScope(opts, 'mesh', 'retired-service');
    expect(scope).toMatchObject({ kind: 'unknown', serviceArg: 'retired-service' });
    expect(scope.kind === 'unknown' && scope.message).toContain('retired-service');
    expect(scope.kind === 'unknown' && scope.message).toContain('MESH');
  });
});

describe('resolveServiceArgs — the caller says which slot it filled', () => {
  it('trusts an explicit serviceId without a lookup', async () => {
    const { opts, calls } = oap([]);
    expect(await resolveServiceArgs(opts, 'mesh', { serviceId: SERVICE_ID })).toEqual({
      kind: 'service',
      serviceId: SERVICE_ID,
    });
    expect(calls).toHaveLength(0);
  });

  // The whole point of the split: `api.1` in the NAME slot is a name, even
  // though it is shaped like an id.
  it('looks the name slot up even when the name is shaped like an id', async () => {
    const { opts, calls } = oap([{ id: SERVICE_ID, name: 'api.1' }]);
    expect(await resolveServiceArgs(opts, 'mesh', { service: 'api.1' })).toEqual({
      kind: 'service',
      serviceId: SERVICE_ID,
    });
    expect(calls).toHaveLength(1);
  });

  it('reports "all" when neither slot is filled', async () => {
    const { opts } = oap([]);
    expect(await resolveServiceArgs(opts, 'mesh', {})).toEqual({ kind: 'all' });
    expect(await resolveRequiredServiceArgs(opts, 'mesh', { serviceId: '', service: '' })).toMatchObject({
      kind: 'unknown',
    });
  });

  it('takes the explicit id on the required path too', async () => {
    const { opts, calls } = oap([]);
    expect(await resolveRequiredServiceArgs(opts, 'mesh', { serviceId: SERVICE_ID })).toEqual({
      kind: 'service',
      serviceId: SERVICE_ID,
    });
    expect(calls).toHaveLength(0);
  });
});

// OAP mints a service id as `base64(<name>).<1 normal | 0 virtual>`, so an
// agent-detected service and a conjectured peer of the same name are two
// entities one string cannot tell apart.
describe('a NAME shared by a normal and a virtual service', () => {
  const NORMAL = { id: 'cGF5bWVudHM=.1', name: 'payments', normal: true };
  const VIRTUAL = { id: 'cGF5bWVudHM=.0', name: 'payments', normal: false };
  const roster = [NORMAL, VIRTUAL];

  it('resolves to the one the caller asked for', () => {
    expect(matchServiceInRoster(roster, 'payments', 'mesh', { normal: true })).toEqual({
      kind: 'service',
      serviceId: NORMAL.id,
    });
    expect(matchServiceInRoster(roster, 'payments', 'mesh', { normal: false })).toEqual({
      kind: 'service',
      serviceId: VIRTUAL.id,
    });
  });

  it('refuses — rather than picking one — when the caller carried no flag', () => {
    const scope = matchServiceInRoster(roster, 'payments', 'mesh');
    expect(scope).toMatchObject({ kind: 'unknown', serviceArg: 'payments' });
    expect(scope.kind === 'unknown' && scope.message).toContain('normal and a virtual');
  });

  it('reports the missing side by name when only the other one exists', () => {
    const scope = matchServiceInRoster([NORMAL], 'payments', 'mesh', { normal: false });
    expect(scope).toMatchObject({ kind: 'unknown' });
    expect(scope.kind === 'unknown' && scope.message).toContain('No virtual service "payments"');
  });

  it('keeps a flagless roster row usable — an absent flag cannot contradict the hint', () => {
    expect(
      matchServiceInRoster([{ id: SERVICE_ID, name: 'songs' }], 'songs', 'mesh', { normal: false }),
    ).toEqual({ kind: 'service', serviceId: SERVICE_ID });
  });

  it('carries the flag through the route-arg path', async () => {
    const { opts } = oap(roster);
    expect(await resolveServiceArgs(opts, 'mesh', { service: 'payments', normal: false })).toEqual({
      kind: 'service',
      serviceId: VIRTUAL.id,
    });
    expect(await resolveRequiredServiceArgs(opts, 'mesh', { service: 'payments', normal: true })).toEqual({
      kind: 'service',
      serviceId: NORMAL.id,
    });
  });
});

// The name slot matches names first. When the same string is one service's
// NAME and another's id, the slot cannot say which was meant.
describe('a string that is one service\'s name and another\'s id', () => {
  const roster = [
    { id: 'YXBpLjE=.1', name: 'api.1', normal: true },
    { id: 'api.1', name: 'gateway', normal: true },
  ];

  it('refuses instead of silently taking the name', () => {
    const scope = matchServiceInRoster(roster, 'api.1', 'mesh');
    expect(scope).toMatchObject({ kind: 'unknown', serviceArg: 'api.1' });
    expect(scope.kind === 'unknown' && scope.message).toContain('serviceId');
  });

  // The caller that says "this is an id" is never in doubt — no lookup runs at all.
  it('answers the same string, said to be an id, with that id', async () => {
    const { opts, calls } = oap(roster);
    expect(await resolveServiceArgs(opts, 'mesh', { serviceId: 'api.1' })).toEqual({
      kind: 'service',
      serviceId: 'api.1',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('serviceArgsFromQuery', () => {
  it('keeps the two slots apart and trims them', () => {
    expect(serviceArgsFromQuery({ serviceId: ` ${SERVICE_ID} ` })).toEqual({
      serviceId: SERVICE_ID,
      service: '',
      normal: null,
    });
    expect(serviceArgsFromQuery({ service: ' songs ' })).toEqual({
      serviceId: '',
      service: 'songs',
      normal: null,
    });
  });

  it('reads `normal` only when it is literally true/false', () => {
    expect(serviceArgsFromQuery({ service: 's', normal: 'true' }).normal).toBe(true);
    expect(serviceArgsFromQuery({ service: 's', normal: 'FALSE' }).normal).toBe(false);
    for (const junk of ['', '1', 'yes', undefined]) {
      expect(serviceArgsFromQuery({ service: 's', normal: junk }).normal).toBeNull();
    }
  });
});

describe('resolveRequiredService', () => {
  it('folds "no service supplied" into a refusal for callers that cannot widen', async () => {
    const { opts } = oap([]);
    const scope = await resolveRequiredService(opts, 'mesh', '');
    expect(scope.kind).toBe('unknown');
    expect(scope.kind === 'unknown' && scope.message).toContain('No service supplied');
  });

  it('passes a resolved service straight through', async () => {
    const { opts } = oap([{ id: SERVICE_ID, name: 'songs' }]);
    expect(await resolveRequiredService(opts, 'mesh', 'songs')).toEqual({
      kind: 'service',
      serviceId: SERVICE_ID,
    });
  });
});
