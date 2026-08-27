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
import { invalidateSyncCache, resetTemplateSyncState, templateStoreStatus } from '../templates/sync.js';
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

/** A row whose NAME and CONTENT were written independently. `buildEnvelope`
 *  derives one from the other, which is the agreement under test, so this
 *  writes the envelope by hand — the state a store can already be in. */
const misfiledRow = (name: string, content: unknown): UITemplateRow => ({
  id: `oap-${name}`,
  configuration: JSON.stringify({ name, kind: 'layer', version: 1, content }),
  disabled: false,
});

/** The release ships a layer template for this key — asserted, not assumed,
 *  so a "no fallback" test can never pass just because the disk is empty. */
function bundledLayerContent(key: string): unknown {
  for (const b of iterateBundledTemplates()) {
    if (b.kind === 'layer' && b.key.toUpperCase() === key) return b.content;
  }
  throw new Error(`no bundled layer template for ${key} — pick a key the release ships`);
}

beforeEach(() => {
  resetTemplateSyncState();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  resetTemplateSyncState();
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
      reason: 'store-unreachable',
    });
  });

  it('blocks on the lower-cased layer key the routes pass in', async () => {
    expect(await resolveEffectiveLayer(templateClient('unreachable'), 'general')).toEqual({
      template: null,
      blocked: true,
      reason: 'store-unreachable',
    });
  });

  it('blocks uniformly, including a layer the release bundles nothing for', async () => {
    expect(await resolveEffectiveLayer(templateClient('unreachable'), 'NOT_A_BUNDLED_LAYER')).toEqual({
      template: null,
      blocked: true,
      reason: 'store-unreachable',
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

    expect(eff).toEqual({ template: null, blocked: true, reason: 'layer-disabled' });
  });

  it('falls to in-code defaults when the store answers but holds no row for the layer', async () => {
    // The store is readable and simply has nothing for GENERAL (seed never
    // landed). That is a `bundled-fallback` row on the sync status — its
    // bundled side must NOT be resurrected as the rendered template.
    const eff = await resolveEffectiveLayer(templateClient([]), 'GENERAL');

    expect(eff).toEqual({ template: null, blocked: false, reason: 'no-remote-row' });
  });
});

/**
 * The row's NAME is what this resolver looks a layer up by, so a record stored
 * under the right name while holding another layer's template is the one shape
 * a name lookup cannot catch on its own — and the worst one, because it does
 * not orphan a dashboard, it serves someone else's under this layer.
 *
 * In-code defaults, not `blocked`: the record says nothing about THIS layer,
 * which is the same thing "no row" says. Blocking would let one stray record
 * dark a working layer, with no disable for the operator to un-do.
 */
describe('resolveEffectiveLayer — a record that is not this layer', () => {
  it('does not serve another layer’s template under this layer’s name', async () => {
    const k8sTemplate = { key: 'K8S', alias: 'Kubernetes', components: { service: true } };
    const eff = await resolveEffectiveLayer(
      templateClient([misfiledRow('horizon.layer.GENERAL', k8sTemplate)]),
      'general',
    );

    expect(eff).toEqual({ template: null, blocked: false, reason: 'no-remote-row' });
  });

  it('ignores a row stored under a name no reader computes, and still serves the readable one', async () => {
    const edited = { key: 'GENERAL', alias: 'Operator edit', components: { service: true } };
    const client = templateClient([
      misfiledRow('horizon.layer.general', { key: 'GENERAL', alias: 'lower-case row' }),
      layerRow('GENERAL', edited),
    ]);

    expect((await resolveEffectiveLayer(client, 'GENERAL')).template).toEqual(edited);
  });
});

describe('resolveEffectiveLayer — no template client wired', () => {
  it('never blocks (tests / no OAP admin configured) — routes use in-code defaults', async () => {
    expect(await resolveEffectiveLayer(undefined, 'GENERAL')).toEqual({
      template: null,
      blocked: false,
      reason: 'no-remote-row',
    });
  });
});

/**
 * A store that CAN'T be read is not the same as a store that never could.
 *
 * Blocking exists so an operator whose published dashboards cannot be read is
 * not shown the shipped defaults dressed up as their configuration. That
 * reasoning is about the DISK BUNDLE, and it does not reach the rows Horizon
 * read from OAP a minute ago — those are the operator's own work, merely stale.
 * Throwing them away turned a transient admin-port blip into every dashboard,
 * overview and map going blank at once.
 */
describe('resolveEffectiveLayer — a store that was readable before', () => {
  /** A client whose store can change between calls, so a test can take the
   *  admin port away after a successful read. */
  function flippingClient(store: { current: Store }): () => UITemplateClient {
    return () =>
      ({
        list: async (): Promise<UITemplateRow[]> => {
          if (store.current === 'unreachable') {
            throw new Error('HTTP 404 on /ui-management/templates');
          }
          return store.current.map((r) => ({ ...r }));
        },
        create: () => Promise.reject(new Error('must not write')),
        update: () => Promise.reject(new Error('must not write')),
        disable: () => Promise.reject(new Error('must not write')),
      }) as unknown as UITemplateClient;
  }

  const published = { key: 'GENERAL', alias: 'Edited by the operator' };

  it('keeps serving the last read rows when the store goes away', async () => {
    const store: { current: Store } = { current: [layerRow('GENERAL', published)] };
    const client = flippingClient(store);
    expect(await resolveEffectiveLayer(client, 'GENERAL')).toMatchObject({ reason: 'ok' });

    store.current = 'unreachable';
    invalidateSyncCache(); // only the 30s window; retention must survive it
    const after = await resolveEffectiveLayer(client, 'GENERAL');

    expect(after.blocked, 'a readable-before store blanked every dashboard').toBe(false);
    expect(after.template, 'the operator’s own published template was discarded').toMatchObject({
      alias: published.alias,
    });
  });

  it('still refuses the DISK BUNDLE — retention is remote rows, not defaults', async () => {
    // GENERAL is bundled, and the bundled copy differs from what is published.
    expect(bundledLayerContent('GENERAL')).toBeTruthy();
    const store: { current: Store } = { current: [layerRow('GENERAL', published)] };
    const client = flippingClient(store);
    await resolveEffectiveLayer(client, 'GENERAL');

    store.current = 'unreachable';
    invalidateSyncCache();
    const after = await resolveEffectiveLayer(client, 'GENERAL');

    expect(after.template).toMatchObject({ alias: published.alias });
    expect(
      JSON.stringify(after.template),
      'the bundled copy was served as though it were the live config',
    ).not.toBe(JSON.stringify(bundledLayerContent('GENERAL')));
  });

  it('blocks a layer it never read, even while retaining another', async () => {
    const store: { current: Store } = { current: [layerRow('GENERAL', published)] };
    const client = flippingClient(store);
    await resolveEffectiveLayer(client, 'GENERAL');

    store.current = 'unreachable';
    invalidateSyncCache();

    expect(await resolveEffectiveLayer(client, 'NOT_A_BUNDLED_LAYER')).toEqual({
      template: null,
      blocked: true,
      reason: 'store-unreachable',
    });
  });

  it('keeps a layer DISABLED while unreachable — that decision is an answer', async () => {
    const store: { current: Store } = { current: [layerRow('GENERAL', published, true)] };
    const client = flippingClient(store);
    expect(await resolveEffectiveLayer(client, 'GENERAL')).toMatchObject({
      blocked: true,
      reason: 'layer-disabled',
    });

    store.current = 'unreachable';
    invalidateSyncCache();

    expect(
      await resolveEffectiveLayer(client, 'GENERAL'),
      'an administrator’s decision stopped applying because the store blipped',
    ).toMatchObject({ blocked: true, reason: 'layer-disabled' });
  });
});

/**
 * What the Cluster Status page is told.
 *
 * A pure read of what the sync module already knows — it must never probe OAP,
 * or a status page would add load every time it rendered. And it has to say
 * more than "unreachable": that one word covers a 404 from a module nobody
 * enabled, a 401 from wrong credentials, and a timeout from a slow admin port
 * — three different things to go and fix.
 */
describe('templateStoreStatus — what the operator is shown', () => {
  function flipping(store: { current: Store }): () => UITemplateClient {
    return () =>
      ({
        list: async (): Promise<UITemplateRow[]> => {
          if (store.current === 'unreachable') throw new Error('HTTP 401 on /ui-management/templates');
          return store.current.map((r) => ({ ...r }));
        },
        create: () => Promise.reject(new Error('must not write')),
        update: () => Promise.reject(new Error('must not write')),
        disable: () => Promise.reject(new Error('must not write')),
      }) as unknown as UITemplateClient;
  }

  it('reports nothing loaded before the first read', () => {
    const s = templateStoreStatus();
    expect(s.lastSuccessfulSyncAt).toBeNull();
    expect(s.counts.layer).toBe(0);
    expect(s.servingRetained).toBe(false);
  });

  it('counts what is being served from OAP, and when it was read', async () => {
    const store: { current: Store } = {
      current: [layerRow('GENERAL', { key: 'GENERAL' }), layerRow('MESH', { key: 'MESH' })],
    };
    await resolveEffectiveLayer(flipping(store), 'GENERAL');

    const s = templateStoreStatus();
    expect(s.counts.layer, 'the count is not what OAP actually served').toBe(2);
    expect(s.lastSuccessfulSyncAt).not.toBeNull();
    expect(s.unreachable).toBe(false);
    expect(s.lastError).toBeNull();
  });

  it('keeps the failure’s own words, and says it is still serving', async () => {
    const store: { current: Store } = { current: [layerRow('GENERAL', { key: 'GENERAL' })] };
    const client = flipping(store);
    await resolveEffectiveLayer(client, 'GENERAL');

    store.current = 'unreachable';
    invalidateSyncCache();
    await resolveEffectiveLayer(client, 'GENERAL');

    const s = templateStoreStatus();
    expect(s.unreachable).toBe(true);
    expect(s.servingRetained, 'the page cannot tell a warning from an outage').toBe(true);
    expect(s.lastError?.message, 'only "unreachable" reached the page').toContain('401');
    expect(s.counts.layer, 'the counts stopped describing what is on screen').toBe(1);
  });

  it('forgets the error once a read succeeds again', async () => {
    const store: { current: Store } = { current: 'unreachable' };
    const client = flipping(store);
    await resolveEffectiveLayer(client, 'GENERAL');
    expect(templateStoreStatus().lastError).not.toBeNull();

    store.current = [layerRow('GENERAL', { key: 'GENERAL' })];
    invalidateSyncCache();
    await resolveEffectiveLayer(client, 'GENERAL');

    const s = templateStoreStatus();
    expect(s.lastError, 'an old failure was still being reported as current').toBeNull();
    expect(s.unreachable).toBe(false);
  });
});
