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
 * Two halves. Which pages the store holds: remote rows only, each page valid
 * on its own, in page order, and nothing at all when the store cannot be read.
 * And which of them one reader is served: a page is a view over the alarms
 * the reader may read, so it keeps only the pins their `alarms:read` reaches,
 * narrowed to the groups they were given.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAlarmPin, type UITemplateClient, type UITemplateRow } from '@skywalking-horizon-ui/api-client';
import { buildEnvelope, serializeEnvelope } from '../templates/names.js';
import { invalidateSyncCache, resetTemplateSyncState, setTemplateReadOnly } from '../templates/sync.js';
import { canonicalLayerKey } from '../templates/identity.js';
import { SessionAccess } from '../../rbac/layer-access.js';
import type { Verb } from '../../rbac/verbs.js';
import { logger } from '../../logger.js';
import {
  alarmPagesFor,
  namedPagePins,
  readStoredAlarmPages,
  type PinReach,
  type StoredAlarmPages,
} from './pages.js';

type Store = UITemplateRow[] | 'unreachable';

const row = (id: string, key: string, content: unknown, disabled = false): UITemplateRow =>
  ({ id, disabled, configuration: serializeEnvelope(buildEnvelope('alert', key, content)) }) as UITemplateRow;

const defaultRow = (pinnedLayers: string[], defaultWindowMs = 7_200_000): UITemplateRow =>
  row('default', 'default', { pinnedLayers, defaultWindowMs, overviewAlarmsLimit: 200 });

const pageRow = (id: string, content: Record<string, unknown> = {}, disabled = false): UITemplateRow =>
  row(`row-${id}`, id, { id, title: id, pinnedLayers: ['GENERAL'], ...content }, disabled);

function client(store: { current: Store }): () => UITemplateClient {
  return () =>
    ({
      list: async (): Promise<UITemplateRow[]> => {
        if (store.current === 'unreachable') throw new Error('ECONNREFUSED');
        return store.current.map((r) => ({ ...r }));
      },
      create: () => Promise.reject(new Error('reading pages must not write to OAP')),
      update: () => Promise.reject(new Error('reading pages must not write to OAP')),
      disable: () => Promise.reject(new Error('reading pages must not write to OAP')),
    }) as unknown as UITemplateClient;
}

const read = (store: Store): Promise<StoredAlarmPages> => readStoredAlarmPages(client({ current: store }));

describe('the pages the store holds', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetTemplateSyncState();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    setTemplateReadOnly(false);
    resetTemplateSyncState();
    vi.restoreAllMocks();
  });

  it('reads the default page and the named pages, pins canonical, in page order', async () => {
    const stored = await read([
      defaultRow(['general', 'CACHE[payments, -]']),
      pageRow('payments', { title: 'Payments' }),
      pageRow('checkout', { title: 'checkout' }),
      pageRow('risk-2', { title: 'Risk', order: 5 }),
      pageRow('risk', { title: 'Risk', order: 5, defaultWindowMs: 14_400_000 }),
    ]);

    expect(stored.unreachable).toBe(false);
    expect(stored.default).toEqual({
      id: 'default',
      title: null,
      order: 0,
      pins: [{ layer: 'GENERAL' }, { layer: 'VIRTUAL_CACHE', groups: ['payments', ''] }],
      defaultWindowMs: 7_200_000,
    });
    // `order` first (absent is 1000), then title, then id.
    expect(stored.pages.map((p) => p.id)).toEqual(['risk', 'risk-2', 'checkout', 'payments']);
    expect(stored.pages[0]).toMatchObject({ title: 'Risk', order: 5, defaultWindowMs: 14_400_000 });
    expect(stored.pages[1]!.defaultWindowMs).toBeUndefined();
  });

  it('skips a page that is not valid, says so once, and serves the rest', async () => {
    const store: Store = [
      defaultRow(['GENERAL']),
      pageRow('good'),
      pageRow('bad-pin', { pinnedLayers: ['GENERAL[]'] }),
      pageRow('untitled', { title: '' }),
    ];
    const stored = await read(store);
    await read(store);

    expect(stored.pages.map((p) => p.id)).toEqual(['good']);
    const calls = (warn.mock.calls as unknown[][]).filter((c) => String(c[1]).startsWith('Alarm pages not served'));
    expect(calls).toHaveLength(1);
    const rows = (calls[0]![0] as { rows: Array<{ name: string; issues: string[] }> }).rows;
    expect(rows.map((r) => r.name).sort()).toEqual(['horizon.alert.bad-pin', 'horizon.alert.untitled']);
  });

  it('never reads the default page from its retired row', async () => {
    // What an upgraded store holds until the default page is saved again.
    const stored = await read([
      row('old', 'page-setup', { pinnedLayers: ['K8S'], defaultWindowMs: 1_200_000, overviewAlarmsLimit: 200 }),
    ]);
    expect(stored).toEqual({ unreachable: false, default: null, pages: [] });
  });

  it('leaves out a disabled page, a page on differing duplicate rows, and one filed under another id', async () => {
    const stored = await read([
      defaultRow(['GENERAL']),
      pageRow('retired', {}, true),
      pageRow('dup', { title: 'One' }),
      { ...pageRow('dup', { title: 'Two' }), id: 'row-dup-2' },
      row('misfiled', 'payments', { id: 'risk', title: 'Risk', pinnedLayers: ['GENERAL'] }),
      pageRow('kept'),
    ]);
    expect(stored.pages.map((p) => p.id)).toEqual(['kept']);
  });

  it('serves the default page only from OAP in live mode, never the bundle', async () => {
    expect(await read([])).toEqual({ unreachable: false, default: null, pages: [] });
  });

  it('serves no page when the store is unreachable, even after a good read', async () => {
    const store: { current: Store } = { current: [defaultRow(['GENERAL']), pageRow('payments')] };
    const templates = client(store);
    expect((await readStoredAlarmPages(templates)).pages).toHaveLength(1);

    store.current = 'unreachable';
    invalidateSyncCache();
    expect(await readStoredAlarmPages(templates)).toEqual({ unreachable: true, default: null, pages: [] });
  });

  it('readonly: the default page is the bundled one, and there are no named pages', async () => {
    setTemplateReadOnly(true);
    // The client throws on every call: reaching it at all would fail the test.
    const stored = await read('unreachable');
    expect(stored.unreachable).toBe(false);
    expect(stored.default?.pins).toEqual([{ layer: 'GENERAL' }, { layer: 'MESH' }]);
    expect(stored.default?.defaultWindowMs).toBe(1_200_000);
    expect(stored.pages).toEqual([]);
  });
});

/** Stored pages as the reach tests read them: the built-in operate layer is
 *  BANYANDB, reachable with a plain grant only beside `cluster:read`. */
const STORED: StoredAlarmPages = {
  unreachable: false,
  default: {
    id: 'default',
    title: null,
    order: 0,
    pins: [{ layer: 'GENERAL' }, { layer: 'MESH' }, { layer: 'BANYANDB' }],
    defaultWindowMs: 7_200_000,
  },
  pages: [
    { id: 'payments', title: 'Payments', order: 1000, pins: [{ layer: 'GENERAL', groups: ['payments'] }] },
    { id: 'storage', title: 'Storage', order: 1000, pins: [{ layer: 'BANYANDB' }], defaultWindowMs: 14_400_000 },
    {
      id: 'mixed',
      title: 'Mixed',
      order: 1000,
      pins: [{ layer: 'GENERAL' }, { layer: 'GENERAL', groups: ['payments', ''] }, { layer: 'MESH', groups: ['risk'] }],
    },
  ],
};

function reachOf(grants: string[]): PinReach {
  const session = new SessionAccess(grants as Verb[], undefined, {
    isOperate: (layer) => layer === 'BANYANDB',
    canonical: canonicalLayerKey,
  });
  return (layer) => session.onLayerAny(['alarms:read'], layer);
}

/** Each served page as `id: pins (hidden)`, the default page first. */
function served(grants: string[], stored: StoredAlarmPages = STORED): string[] {
  const res = alarmPagesFor(stored, reachOf(grants));
  return [res.default, ...res.pages]
    .filter((p) => p !== null)
    .map((p) => `${p.id}: ${p.pinnedLayers.join(' | ')} (${p.hiddenPins})`);
}

describe('the pages one reader is served', () => {
  it('a plain grant without cluster:read loses the operate-layer pins, and a page of nothing else', () => {
    expect(served(['alarms:read'])).toEqual([
      'default: GENERAL | MESH (1)',
      'payments: GENERAL[payments] (0)',
      'mixed: GENERAL | GENERAL[payments, -] | MESH[risk] (0)',
    ]);
  });

  it('a plain grant with cluster:read reaches every pin', () => {
    expect(served(['alarms:read', 'cluster:read'])).toEqual([
      'default: GENERAL | MESH | BANYANDB (0)',
      'payments: GENERAL[payments] (0)',
      'storage: BANYANDB (0)',
      'mixed: GENERAL | GENERAL[payments, -] | MESH[risk] (0)',
    ]);
  });

  it('a layer grant reaches that layer whole', () => {
    expect(served(['alarms:read@GENERAL'])).toEqual([
      'default: GENERAL (2)',
      'payments: GENERAL[payments] (0)',
      'mixed: GENERAL | GENERAL[payments, -] (1)',
    ]);
  });

  it('a group grant narrows every pin of its layer to its groups, one tile each', () => {
    expect(served(['alarms:read@GENERAL[payments]'])).toEqual([
      'default: GENERAL[payments] (2)',
      'payments: GENERAL[payments] (0)',
      // GENERAL and GENERAL[payments, -] both narrow to payments: one tile.
      'mixed: GENERAL[payments] (1)',
    ]);
    expect(served(['alarms:read@GENERAL[-]'])).toEqual([
      'default: GENERAL[-] (2)',
      'mixed: GENERAL[-] (1)',
    ]);
  });

  it('a page whose pins share no group with the grant is not served; the default page always is', () => {
    expect(served(['alarms:read@GENERAL[risk]'])).toEqual([
      'default: GENERAL[risk] (2)',
      'mixed: GENERAL[risk] (2)',
    ]);
    expect(served(['alarms:read@K8S'])).toEqual(['default:  (3)']);
  });

  it('an explicit operate-layer grant reaches it without cluster:read', () => {
    expect(served(['alarms:read@BANYANDB'])).toEqual(['default: BANYANDB (2)', 'storage: BANYANDB (0)']);
  });

  it('a grant of another verb reaches no pin', () => {
    expect(served(['metrics:read', 'cluster:read'])).toEqual(['default:  (3)']);
  });

  it('opens a page on its own window, else the default page\'s, else the first window choice', () => {
    const res = alarmPagesFor(STORED, reachOf(['alarms:read', 'cluster:read']));
    expect(res.default?.defaultWindowMs).toBe(7_200_000);
    expect(res.pages.find((p) => p.id === 'storage')?.defaultWindowMs).toBe(14_400_000);
    expect(res.pages.find((p) => p.id === 'payments')?.defaultWindowMs).toBe(7_200_000);

    const noDefault = alarmPagesFor({ ...STORED, default: null }, reachOf(['alarms:read']));
    expect(noDefault.default).toBeNull();
    expect(noDefault.pages.find((p) => p.id === 'payments')?.defaultWindowMs).toBe(1_200_000);
  });

  it('carries the title verbatim, and none on the default page', () => {
    const res = alarmPagesFor(STORED, reachOf(['alarms:read']));
    expect(res.default?.title).toBeNull();
    expect(res.pages.map((p) => p.title)).toEqual(['Payments', 'Mixed']);
  });

  it('passes an unreachable store through as no page at all', () => {
    expect(alarmPagesFor({ unreachable: true, default: null, pages: [] }, reachOf(['alarms:read']))).toEqual({
      unreachable: true,
      default: null,
      pages: [],
    });
  });
});

describe('the pins one named page is read by', () => {
  it('are the pins the reader is served that page with', () => {
    for (const grants of [['alarms:read'], ['alarms:read@GENERAL'], ['alarms:read@GENERAL[payments]'], ['alarms:read@GENERAL[-]']]) {
      const served = alarmPagesFor(STORED, reachOf(grants)).pages.find((p) => p.id === 'mixed');
      const pins = namedPagePins(STORED, 'mixed', reachOf(grants));
      expect(pins?.map(formatAlarmPin), grants.join()).toEqual(served?.pinnedLayers);
    }
    expect(namedPagePins(STORED, 'mixed', reachOf(['alarms:read@GENERAL[payments]']))).toEqual([{ layer: 'GENERAL', groups: ['payments'] }]);
  });

  it('are none for a page the reader is not served, one the store lacks, or the default page', () => {
    expect(namedPagePins(STORED, 'storage', reachOf(['alarms:read']))).toBeNull();
    expect(namedPagePins(STORED, 'payments', reachOf(['alarms:read@GENERAL[risk]']))).toBeNull();
    expect(namedPagePins(STORED, 'nope', reachOf(['alarms:read', 'cluster:read']))).toBeNull();
    expect(namedPagePins(STORED, 'default', reachOf(['alarms:read', 'cluster:read']))).toBeNull();
  });
});
