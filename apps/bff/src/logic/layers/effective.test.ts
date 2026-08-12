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
 * What a route gets when the OAP template store cannot be read.
 *
 * The case that matters is not exotic: an OAP 10.x has no
 * `/ui-management/templates*` at all, so the store is unreachable for the
 * whole life of the deployment. Blocking there left layer-driven pages —
 * Traces most visibly — permanently empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import { invalidateSyncCache } from '../templates/sync.js';
import { resolveEffectiveLayer } from './effective.js';

/** A client whose every call fails the way an OAP without the ui-management
 *  module does: the path is not served. */
function unreachableClient(): () => UITemplateClient {
  return () =>
    ({
      list: async () => {
        throw new Error('HTTP 404 on /ui-management/templates');
      },
      create: async () => {
        throw new Error('unreachable');
      },
      update: async () => {
        throw new Error('unreachable');
      },
      disable: async () => {
        throw new Error('unreachable');
      },
    }) as unknown as UITemplateClient;
}

beforeEach(() => invalidateSyncCache());
afterEach(() => {
  invalidateSyncCache();
  vi.restoreAllMocks();
});

describe('resolveEffectiveLayer when the template store cannot be read', () => {
  it('serves the shipped bundle instead of blocking the layer', async () => {
    const eff = await resolveEffectiveLayer(unreachableClient(), 'GENERAL');

    // The whole point: not blocked, and carrying real bundled content.
    expect(eff.blocked).toBe(false);
    expect(eff.template).not.toBeNull();
    expect(eff.template?.key?.toUpperCase()).toBe('GENERAL');
  });

  it('carries the layer definition routes read, so Traces is not empty', async () => {
    const eff = await resolveEffectiveLayer(unreachableClient(), 'GENERAL');

    // A layer template drives which components a layer exposes; an empty
    // object would satisfy "not null" while still starving the routes.
    expect(Object.keys(eff.template ?? {}).length).toBeGreaterThan(1);
  });

  it('is lowercase/uppercase agnostic on the layer key', async () => {
    const lower = await resolveEffectiveLayer(unreachableClient(), 'general');
    expect(lower.blocked).toBe(false);
    expect(lower.template?.key?.toUpperCase()).toBe('GENERAL');
  });

  it('returns no template — and still does not block — for a layer the release bundles nothing for', async () => {
    const eff = await resolveEffectiveLayer(unreachableClient(), 'NOT_A_BUNDLED_LAYER');

    // Falls through to the route's in-code defaults rather than blocking,
    // which is the same shape as "reachable but no remote row".
    expect(eff).toEqual({ template: null, blocked: false });
  });

  it('never blocks merely because no client is wired (tests / no OAP admin)', async () => {
    expect(await resolveEffectiveLayer(undefined, 'GENERAL')).toEqual({
      template: null,
      blocked: false,
    });
  });
});
