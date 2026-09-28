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
 * The built-in roles hold no layer grant, so the layer rules must leave them
 * as they were: maintainer, operator and admin read every layer and are never
 * checked per service; viewer reads every layer except the Platform monitoring
 * ones, which were only ever meant for `cluster:read`.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '../config/builtin-roles.js';
import { configSchema } from '../config/schema.js';
import type { ConfigSource } from '../config/loader.js';
import { ServiceIdentityResolver } from '../logic/services/service-identity.js';
import type { ServiceCatalog, ServiceLayerCatalog } from '../logic/services/service-layer-catalog.js';
import { LAYER_SCOPED_VERBS, resolveVerbsForRoles } from './verbs.js';
import { SessionAccess } from './layer-access.js';
import { RequestAccess } from './request-access.js';

const cfg = configSchema.parse({});
const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
const empty: ServiceCatalog = { layers: [], byLayer: new Map(), byName: new Map() };
const catalog = { get: async () => empty } as unknown as ServiceLayerCatalog;
const services = new ServiceIdentityResolver({ config, catalog, fetch: async () => new Response('{}') });
const facts = { isOperate: (l: string) => l === 'BANYANDB' || l.startsWith('SO11Y_'), canonical: (l: string) => l.toUpperCase() };

const accessFor = (role: string) =>
  new RequestAccess(new SessionAccess(resolveVerbsForRoles(BUILTIN_ROLES, [role], true), undefined, facts), services);
const held = (role: string) => [...LAYER_SCOPED_VERBS].filter((v) => accessFor(role).plain(v));

describe('the built-in roles under layer grants', () => {
  it('hold no layer grant, so every verb they have is held plainly', () => {
    for (const role of Object.keys(BUILTIN_ROLES)) {
      const a = accessFor(role);
      expect(a.session.hasLayerGrants(), role).toBe(false);
      for (const v of held(role)) expect(a.layerLimited([v]), `${role} ${v}`).toBe(false);
    }
  });

  it('let maintainer, operator and admin read every layer without a per-service check', () => {
    for (const role of ['maintainer', 'operator', 'admin']) {
      const a = accessFor(role);
      expect(held(role).length, role).toBeGreaterThan(0);
      for (const v of held(role)) expect(a.readsEveryLayer([v]), `${role} ${v}`).toBe(true);
      for (const layer of ['GENERAL', 'MESH', 'BANYANDB', 'SO11Y_OAP']) expect(a.menuShows(layer), `${role} ${layer}`).toBe(true);
    }
  });

  it('let viewer read every layer but the Platform monitoring ones, with the menu it always had', () => {
    const a = accessFor('viewer');
    for (const layer of ['GENERAL', 'MESH', 'K8S_SERVICE', 'VIRTUAL_DATABASE']) {
      expect(a.menuShows(layer), layer).toBe(true);
      expect(a.onLayer(['metrics:read'], layer)?.whole, layer).toBe(true);
    }
    for (const layer of ['BANYANDB', 'SO11Y_OAP', 'SO11Y_SATELLITE']) {
      expect(a.menuShows(layer), layer).toBe(false);
      expect(a.onLayer(['metrics:read'], layer), layer).toBeNull();
    }
  });

  it('give operator and admin the template-write permission a draft preview needs', () => {
    for (const role of ['operator', 'admin']) {
      expect(accessFor(role).plain('layer-template:write'), role).toBe(true);
    }
    for (const role of ['viewer', 'maintainer']) {
      // Neither can open the template editor either, so neither has a preview to run.
      expect(accessFor(role).plain('layer-template:read'), role).toBe(false);
    }
  });
});
