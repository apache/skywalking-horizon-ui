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
 * The `live`-mode contract: Horizon renders the REMOTE (OAP-stored) layer
 * template and nothing else. The disk bundle is the seed source, never a
 * render-time fallback — an unreachable store blocks the layer's features
 * instead of serving disk content that may not be what the operator
 * published. An OAP that cannot serve the template store at all is run with
 * `templates.mode: readonly`, where the bundle is the declared source.
 *
 * Every "blocks" assertion here also pins `template: null`: a re-introduced
 * bundled fallback would satisfy "not blocked" AND hand back content, so
 * both halves are asserted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UITemplateClient, UITemplateRow } from '@skywalking-horizon-ui/api-client';
import { invalidateSyncCache } from '../templates/sync.js';
import { iterateBundledTemplates } from '../templates/aggregator.js';
import { buildEnvelope, serializeEnvelope } from '../templates/names.js';
import { logger } from '../../logger.js';
import { resolveEffectiveLayer } from './effective.js';

/** What OAP's `/ui-management/templates` surface holds, or a store the BFF
 *  cannot read at all (`unreachable` — an OAP 10.x never serves that path). */
type Store = UITemplateRow[] | 'unreachable';

function templateClient(store: Store): () => UITemplateClient {
  return () =>
    ({
      list: async (): Promise<UITemplateRow[]> => {
        if (store === 'unreachable') throw new Error('HTTP 404 on /ui-management/templates');
        return store.map((r) => ({ ...r }));
      },
      // Resolution is a pure read path — any write here is a bug.
      create: () => Promise.reject(new Error('resolveEffectiveLayer must not write to OAP')),
      update: () => Promise.reject(new Error('resolveEffectiveLayer must not write to OAP')),
      disable: () => Promise.reject(new Error('resolveEffectiveLayer must not write to OAP')),
    }) as unknown as UITemplateClient;
}

const layerRow = (key: string, content: unknown, disabled = false): UITemplateRow => {
  const env = buildEnvelope('layer', key, content);
  return { id: `oap-${key}`, configuration: serializeEnvelope(env), disabled };
};

/** The release ships a layer template for this key — asserted, not assumed,
 *  so a "no fallback" test can never pass just because the disk is empty. */
function bundledLayerContent(key: string): unknown {
  for (const b of iterateBundledTemplates()) {
    if (b.kind === 'layer' && b.key.toUpperCase() === key) return b.content;
  }
  throw new Error(`no bundled layer template for ${key} — pick a key the release ships`);
}

beforeEach(() => {
  invalidateSyncCache();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  invalidateSyncCache();
  vi.restoreAllMocks();
});

describe('resolveEffectiveLayer — an unreachable template store blocks', () => {
  it('blocks a layer the release bundles, rather than serving the bundled copy', async () => {
    // The bundle HAS content for GENERAL; the resolver must still hand back
    // none of it. This is the case a bundled fallback would silently pass.
    expect(bundledLayerContent('GENERAL')).toBeTruthy();

    expect(await resolveEffectiveLayer(templateClient('unreachable'), 'GENERAL')).toEqual({
      template: null,
      blocked: true,
    });
  });

  it('blocks on the lower-cased layer key the routes pass in', async () => {
    expect(await resolveEffectiveLayer(templateClient('unreachable'), 'general')).toEqual({
      template: null,
      blocked: true,
    });
  });

  it('blocks uniformly, including a layer the release bundles nothing for', async () => {
    expect(await resolveEffectiveLayer(templateClient('unreachable'), 'NOT_A_BUNDLED_LAYER')).toEqual({
      template: null,
      blocked: true,
    });
  });
});

describe('resolveEffectiveLayer — a reachable store decides per row', () => {
  it('serves the remote row content, so an operator edit is what renders', async () => {
    const edited = { key: 'GENERAL', alias: 'Operator edit', components: { service: true } };
    const eff = await resolveEffectiveLayer(templateClient([layerRow('GENERAL', edited)]), 'GENERAL');

    expect(eff.blocked).toBe(false);
    expect(eff.template).toEqual(edited);
  });

  it('blocks a layer whose row the admin disabled', async () => {
    const eff = await resolveEffectiveLayer(
      templateClient([layerRow('GENERAL', bundledLayerContent('GENERAL'), true)]),
      'general',
    );

    expect(eff).toEqual({ template: null, blocked: true });
  });

  it('falls to in-code defaults when the store answers but holds no row for the layer', async () => {
    // The store is readable and simply has nothing for GENERAL (seed never
    // landed). That is a `bundled-fallback` row on the sync status — its
    // bundled side must NOT be resurrected as the rendered template.
    const eff = await resolveEffectiveLayer(templateClient([]), 'GENERAL');

    expect(eff).toEqual({ template: null, blocked: false });
  });
});

describe('resolveEffectiveLayer — no template client wired', () => {
  it('never blocks (tests / no OAP admin configured) — routes use in-code defaults', async () => {
    expect(await resolveEffectiveLayer(undefined, 'GENERAL')).toEqual({
      template: null,
      blocked: false,
    });
  });
});
