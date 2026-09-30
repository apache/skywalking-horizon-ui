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
 * A tool names a layer as the page's URL does, and is checked on it the same
 * way; a service catalog that could not be read is an outage, not an answer.
 */

import { describe, expect, it } from 'vitest';
import { configSchema } from '../../../config/schema.js';
import type { ConfigSource } from '../../../config/loader.js';
import { SessionAccess } from '../../../rbac/layer-access.js';
import { RequestAccess } from '../../../rbac/request-access.js';
import { ServiceIdentityResolver, serviceIdOf } from '../../../logic/services/service-identity.js';
import type { ServiceCatalog, ServiceLayerCatalog } from '../../../logic/services/service-layer-catalog.js';
import type { ToolContext } from '../tool-context.js';
import { layerRefusal, readableRow } from './access.js';

const PAY = { id: serviceIdOf('payments::checkout', true), name: 'payments::checkout', normal: true, group: 'payments' };
const cfg = configSchema.parse({});
const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
const facts = { isOperate: () => false, canonical: (l: string) => l.toUpperCase() };

function ctxFor(grants: string[], snapshot: ServiceCatalog): ToolContext {
  const catalog = { get: async () => snapshot } as unknown as ServiceLayerCatalog;
  const services = new ServiceIdentityResolver({ config, catalog, fetch: async () => { throw new Error('OAP unreachable'); } });
  const access = new RequestAccess(new SessionAccess(grants, undefined, facts), services);
  return { access, hasVerb: () => false } as unknown as ToolContext;
}

// payments::checkout reports into both GENERAL and MESH.
const both: ServiceCatalog = { layers: ['GENERAL', 'MESH'], byLayer: new Map([['GENERAL', [PAY]], ['MESH', [PAY]]]), byName: new Map() };

describe('a tool that names a layer', () => {
  it('is refused a layer the grant does not reach, though the service is granted on another', async () => {
    const ctx = ctxFor(['logs:read@GENERAL[payments]'], both);
    expect(await readableRow(ctx, 'logs:read', 'GENERAL', PAY.name, both)).toMatchObject({ row: { id: PAY.id } });
    expect(await readableRow(ctx, 'logs:read', 'MESH', PAY.name, both)).toMatchObject({ answer: expect.stringMatching(/^Permission denied/) });
    expect(layerRefusal(ctx, 'logs:read', 'MESH')).toMatch(/^Permission denied/);
    expect(layerRefusal(ctx, 'logs:read', 'GENERAL')).toBeNull();
  });

  it('says the catalog could not be read, rather than that the service is unknown or not the user\'s', async () => {
    const down: ServiceCatalog = { layers: [], byLayer: new Map(), byName: new Map(), unreachable: true };
    for (const grants of [['logs:read'], ['logs:read@GENERAL[payments]']]) {
      const pick = await readableRow(ctxFor(grants, down), 'logs:read', 'GENERAL', PAY.name, down);
      expect(pick).toMatchObject({ answer: expect.stringMatching(/catalog could not be read.*not a permission problem/) });
    }
  });
});
