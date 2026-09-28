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
  LAYER_PAGE_VERBS,
  LAYER_SCOPED_VERBS,
  capGrant,
  hasVerb,
  hasVerbOnSomeLayer,
  isGrantRecognised,
  parseGrant,
  resolveVerbsForRoles,
} from './verbs.js';
import { SessionAccess, type ServiceIdentity } from './layer-access.js';
import { ROUTE_POLICY } from './route-policy.js';
import { ROUTE_SCOPE } from './route-scope.js';

const OPERATE = new Set(['BANYANDB', 'SO11Y_OAP']);
const facts = {
  isOperate: (l: string) => OPERATE.has(l),
  canonical: (l: string) => {
    const u = l.toUpperCase();
    return u === 'DATABASE' ? 'VIRTUAL_DATABASE' : u;
  },
};
const access = (grants: string[], cap?: string[]) => new SessionAccess(grants, cap, facts);
const svc = (group: string, ...layers: string[]): ServiceIdentity => ({
  id: 'x.1',
  name: `${group}::x`,
  normal: true,
  group,
  layers,
});

describe('grant grammar', () => {
  it('parses a layer and its groups', () => {
    expect(parseGrant('metrics:read@general')).toEqual({ verb: 'metrics:read', qualifier: { layer: 'GENERAL' } });
    expect(parseGrant('metrics:read@GENERAL[payments, risk]')).toEqual({
      verb: 'metrics:read',
      qualifier: { layer: 'GENERAL', groups: ['payments', 'risk'] },
    });
    expect(parseGrant('logs:read@GENERAL[-]')?.qualifier?.groups).toEqual(['']);
  });

  it('refuses a malformed qualifier rather than widening it', () => {
    for (const bad of ['metrics:read@', '@GENERAL', 'metrics:read@GENERAL[]', 'metrics:read@GENERAL[a,,b]', 'metrics:read@GENERAL[a]x']) {
      expect(parseGrant(bad)).toBeNull();
      expect(isGrantRecognised(bad)).toBe(false);
    }
  });

  it('never lets a layer grant answer a question without a layer', () => {
    for (const g of ['metrics:read@GENERAL', '*:read@GENERAL', '*@GENERAL', 'metrics:*@GENERAL']) {
      expect(hasVerb([g], 'metrics:read')).toBe(false);
      expect(hasVerbOnSomeLayer([g], 'metrics:read')).toBe(true);
    }
    expect(hasVerbOnSomeLayer(['metrics:read@GENERAL'], 'overview:read')).toBe(false);
  });

  it('grants nothing on a verb whose data has no layer, nor through admin', () => {
    for (const g of ['cluster:read@GENERAL', 'overview:read@GENERAL', 'admin@GENERAL', 'audit:read@GENERAL']) {
      expect(isGrantRecognised(g)).toBe(false);
      expect(hasVerbOnSomeLayer([g], g.split('@')[0]!)).toBe(false);
    }
    expect(hasVerbOnSomeLayer(['*@GENERAL'], 'audit:read')).toBe(false);
    expect(hasVerbOnSomeLayer(['*:read@GENERAL'], 'cluster:read')).toBe(false);
  });

  it('does not expand a retired name written with a layer', () => {
    const verbs = resolveVerbsForRoles({ r: ['dashboard:read@GENERAL'] }, ['r'], true);
    expect(verbs).toEqual(['dashboard:read@GENERAL']);
    expect(hasVerb(verbs, 'layer-template:read')).toBe(false);
  });

  it('caps a layer grant by verb and keeps its layer', () => {
    expect(capGrant('metrics:*@GENERAL[a]', ['*:read'])).toEqual(['metrics:read@GENERAL[a]']);
    expect(capGrant('profile:enable@GENERAL', ['*:read'])).toEqual([]);
    expect(capGrant('metrics:read@GENERAL', undefined)).toEqual(['metrics:read@GENERAL']);
  });

  it('lists every verb a layer route needs among the layer-scoped verbs', () => {
    for (const [key, policy] of Object.entries(ROUTE_POLICY)) {
      if (!key.includes(' /api/layer/:key/')) continue;
      const verbs =
        typeof policy === 'string' ? [policy] : Array.isArray(policy) ? policy : 'anyOf' in policy ? policy.anyOf : [];
      for (const v of verbs) expect(LAYER_SCOPED_VERBS.has(v), `${key} → ${v}`).toBe(true);
    }
    for (const v of LAYER_PAGE_VERBS) expect(LAYER_SCOPED_VERBS.has(v)).toBe(true);
  });

  it('keys every scope rule on a route the policy table knows', () => {
    for (const key of Object.keys(ROUTE_SCOPE)) expect(ROUTE_POLICY[key], key).toBeDefined();
  });
});

describe('which layers a session reaches', () => {
  it('a plain verb reaches every layer but the operate ones', () => {
    const a = access(['metrics:read']);
    expect(a.onLayer('metrics:read', 'general')?.whole).toBe(true);
    expect(a.onLayer('metrics:read', 'banyandb')).toBeNull();
  });

  it('cluster:read opens the operate layers to a plain verb', () => {
    expect(access(['metrics:read', 'cluster:read']).onLayer('metrics:read', 'BANYANDB')?.whole).toBe(true);
  });

  it('an explicit layer grant opens an operate layer without cluster:read', () => {
    const a = access(['metrics:read@BANYANDB']);
    expect(a.onLayer('metrics:read', 'BANYANDB')?.whole).toBe(true);
    expect(a.onLayer('metrics:read', 'GENERAL')).toBeNull();
    expect(a.plain('metrics:read')).toBe(false);
  });

  it('merges groups across grants and roles, and folds OAP layer aliases', () => {
    const a = access(['metrics:read@GENERAL[payments]', 'metrics:read@general[risk]', 'metrics:read@DATABASE']);
    const r = a.onLayer('metrics:read', 'GENERAL');
    expect(r?.whole).toBe(false);
    expect([...(r?.groups ?? [])].sort()).toEqual(['payments', 'risk']);
    expect(a.onLayer('metrics:read', 'VIRTUAL_DATABASE')?.whole).toBe(true);
  });

  it('decides layer-limited per verb', () => {
    const a = access(['alarms:read', 'metrics:read@GENERAL']);
    expect(a.layerLimited('metrics:read')).toBe(true);
    expect(a.layerLimited('alarms:read')).toBe(false);
  });

  it('reads a service through any layer it reports into, for its group only', () => {
    const a = access(['metrics:read@MESH[mesh-svr]']);
    expect(a.onService('metrics:read', svc('mesh-svr', 'MESH', 'MESH_DP'))).toBe(true);
    expect(a.onService('metrics:read', svc('other', 'MESH'))).toBe(false);
    expect(a.onService('metrics:read', svc('mesh-svr', 'MESH_DP'))).toBe(false);
  });

  it('keeps a service that lives only in an operate layer from a plain viewer', () => {
    expect(access(['metrics:read']).onService('metrics:read', svc('', 'BANYANDB'))).toBe(false);
    expect(access(['metrics:read']).onService('metrics:read', svc('', 'BANYANDB', 'K8S_SERVICE'))).toBe(true);
  });

  it('narrows by the OAuth cap, never widens', () => {
    const a = access(['metrics:*@GENERAL', 'profile:enable'], ['*:read']);
    expect(a.onLayer('metrics:read', 'GENERAL')?.whole).toBe(true);
    expect(a.onLayer('profile:enable', 'GENERAL')).toBeNull();
    expect(a.holds('profile:enable')).toBe(false);
  });
});
