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
import { resolveRequiredService, resolveServiceScope } from './service-scope.js';

const SERVICE_ID = 'bWVzaC1zdnI6OnNvbmdz.1';

interface Captured {
  query: string;
  variables: Record<string, unknown>;
}

function oap(services: Array<{ id: string; name: string }> | null): {
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

  it('takes an OAP-shaped id as-is, with no lookup round-trip', async () => {
    const { opts, calls } = oap([]);
    expect(await resolveServiceScope(opts, 'mesh', SERVICE_ID)).toEqual({
      kind: 'service',
      serviceId: SERVICE_ID,
    });
    expect(calls).toHaveLength(0);
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

  it('reports "unknown" — never "all" — when the name matches nothing', async () => {
    const { opts } = oap([{ id: SERVICE_ID, name: 'songs' }]);
    const scope = await resolveServiceScope(opts, 'mesh', 'retired-service');
    expect(scope).toMatchObject({ kind: 'unknown', serviceArg: 'retired-service' });
    expect(scope.kind === 'unknown' && scope.message).toContain('retired-service');
    expect(scope.kind === 'unknown' && scope.message).toContain('MESH');
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
