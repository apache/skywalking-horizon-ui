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

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { UITemplateClient, UITemplateRow } from '@skywalking-horizon-ui/api-client';
import {
  getSyncStatus,
  bootSeed,
  setTemplateReadOnly,
  invalidateSyncCache,
  createAndConfirm,
  updateAndConfirm,
  disableAndConfirm,
  WriteNotVisibleError,
  type BundledTemplate,
  type BundledOverlay,
  type SyncDeps,
  type SyncStatus,
  type TemplateRow,
} from './sync.js';
import { buildEnvelope, buildOverlayEnvelope, serializeEnvelope } from './names.js';
import { iterateBundledTemplates } from './aggregator.js';
import { logger } from '../../logger.js';

// A client that THROWS on any call — proves readonly mode never touches the
// OAP ui_template store (it short-circuits to the disk bundle before list()).
const throwingClient = {
  list: () => Promise.reject(new Error('ui_template store must not be called in readonly mode')),
  create: () => Promise.reject(new Error('no')),
  update: () => Promise.reject(new Error('no')),
  disable: () => Promise.reject(new Error('no')),
} as unknown as UITemplateClient;

const deps = { client: throwingClient, bundled: () => iterateBundledTemplates(), logger };

describe('sync — readonly mode renders from the disk bundle', () => {
  afterEach(() => {
    setTemplateReadOnly(false);
    invalidateSyncCache();
  });

  it('returns mode=readonly + reachable, without calling the ui_template client', async () => {
    setTemplateReadOnly(true);
    const status = await getSyncStatus(deps);
    expect(status.mode).toBe('readonly');
    expect(status.unreachable).toBe(false);
    expect(status.rows.length).toBeGreaterThan(0);
    // Every row is presented as effective:'remote' so every render consumer
    // resolves it exactly as it would a live remote row.
    expect(status.rows.every((r) => r.effective === 'remote' && r.remote !== null)).toBe(true);
  });

  it('includes per-locale translation overlay rows so non-English locales render translated', async () => {
    setTemplateReadOnly(true);
    const status = await getSyncStatus(deps);
    const overlays = status.rows.filter((r) => r.locale !== undefined);
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays.some((r) => r.locale === 'zh-CN')).toBe(true);
  });

  it('carries the bundled source rows (layer/overview/alert/...) as effective content', async () => {
    setTemplateReadOnly(true);
    const status = await getSyncStatus(deps);
    const kinds = new Set(status.rows.filter((r) => r.locale === undefined).map((r) => r.kind));
    expect(kinds.has('layer')).toBe(true);
    expect(kinds.has('overview')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Write paths. Every test below drives a fake OAP whose whole surface
 * is recorded, so "which mutations reached OAP" is an assertion, not
 * an inference — these paths run unattended at BFF boot against real
 * operator dashboards.
 * ------------------------------------------------------------------ */

const LAYER: BundledTemplate = { kind: 'layer', key: 'GENERAL', content: { key: 'GENERAL', tabs: [] } };
const OVERVIEW: BundledTemplate = { kind: 'overview', key: 'services', content: { id: 'services', widgets: [] } };
const ALERT: BundledTemplate = { kind: 'alert', key: 'page-setup', content: { columns: [] } };
const BUNDLED: BundledTemplate[] = [LAYER, OVERVIEW, ALERT];

const ZH_OVERLAY: BundledOverlay = { kind: 'layer', key: 'GENERAL', locale: 'zh-CN', content: { title: '通用' } };
const ES_OVERLAY: BundledOverlay = { kind: 'overview', key: 'services', locale: 'es', content: { title: 'Servicios' } };

const nameOf = (t: BundledTemplate): string => buildEnvelope(t.kind, t.key, t.content).name;
const cfgOf = (t: BundledTemplate): string => serializeEnvelope(buildEnvelope(t.kind, t.key, t.content));
/** Same envelope name, different bytes — what an operator edit looks like on the wire. */
const editedCfgOf = (t: BundledTemplate, content: unknown): string =>
  serializeEnvelope(buildEnvelope(t.kind, t.key, content));
const overlayNameOf = (o: BundledOverlay): string =>
  buildOverlayEnvelope(o.kind, o.key, o.locale, o.content).name;
const overlayCfgOf = (o: BundledOverlay): string =>
  serializeEnvelope(buildOverlayEnvelope(o.kind, o.key, o.locale, o.content));

const EDITED_GENERAL = editedCfgOf(LAYER, { key: 'GENERAL', tabs: [{ title: 'operator tab' }] });

const remoteRow = (id: string, configuration: string, disabled = false): UITemplateRow =>
  ({ id, configuration, disabled });
/** Every bundled template already present on OAP, byte-identical. */
const alreadySeeded = (): UITemplateRow[] => BUNDLED.map((t) => remoteRow(`oap-${t.key}`, cfgOf(t)));
/** …minus the layer row, so a fixture can supply its own duplicates of it
 *  without the other two templates adding seed traffic to the wire log. */
const seededExceptLayer = (): UITemplateRow[] => alreadySeeded().filter((r) => r.id !== 'oap-GENERAL');

interface FakeOapOptions {
  rows?: UITemplateRow[];
  /** How many subsequent `list()` calls still HIDE a write — models the
   *  storage read-after-write window `pollUntilVisible` exists to absorb.
   *  `Infinity` never reveals it (propagation timeout). */
  hiddenLists?: number;
  listThrows?: boolean;
  /** Requested ids (= envelope names) whose `create` throws. */
  createThrowsFor?: string[];
  /** Requested ids whose `create` answers with a negative ack. */
  createNacksFor?: string[];
  /** Requested id → the storage id OAP actually hands back. Models the OAP
   *  releases that ignore the requested id and generate their own UUID. */
  assignsId?: Record<string, string>;
  disableThrowsFor?: string[];
}

/** In-memory stand-in for OAP's `/ui-management/templates*` surface.
 *  `calls` is the wire log: `list`, `create:<id>`, `update:<id>`,
 *  `disable:<id>` in the order the orchestrator issued them. */
function fakeOap(opts: FakeOapOptions = {}) {
  const hide = opts.hiddenLists ?? 0;
  const rows: UITemplateRow[] = (opts.rows ?? []).map((r) => ({ ...r }));
  const pending: Array<{ apply: () => void; hiddenFor: number }> = [];
  const calls: string[] = [];

  const commit = (apply: () => void): void => {
    if (hide === 0) {
      apply();
      return;
    }
    pending.push({ apply, hiddenFor: hide });
  };

  const client = {
    list: async (): Promise<UITemplateRow[]> => {
      calls.push('list');
      if (opts.listThrows) throw new Error('ECONNREFUSED');
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i]!;
        if (p.hiddenFor <= 0) {
          p.apply();
          pending.splice(i, 1);
        } else {
          p.hiddenFor--;
        }
      }
      return rows.map((r) => ({ ...r }));
    },
    create: async (id: string, configuration: string) => {
      calls.push(`create:${id}`);
      if (opts.createThrowsFor?.includes(id)) throw new Error(`OAP refused create ${id}`);
      if (opts.createNacksFor?.includes(id)) return { id, status: false, message: 'duplicate name' };
      const storedId = opts.assignsId?.[id] ?? id;
      commit(() => rows.push({ id: storedId, configuration, disabled: false }));
      return { id: storedId, status: true, message: '' };
    },
    update: async (id: string, configuration: string) => {
      calls.push(`update:${id}`);
      commit(() => {
        const r = rows.find((x) => x.id === id);
        if (r) r.configuration = configuration;
      });
      return { id, status: true, message: '' };
    },
    disable: async (id: string) => {
      calls.push(`disable:${id}`);
      if (opts.disableThrowsFor?.includes(id)) throw new Error(`OAP refused disable ${id}`);
      commit(() => {
        const r = rows.find((x) => x.id === id);
        if (r) r.disabled = true;
      });
      return { id, status: true, message: '' };
    },
  } as unknown as UITemplateClient;

  return { client, rows, calls };
}

function depsFor(client: UITemplateClient, extra: Partial<SyncDeps> = {}): SyncDeps {
  return { client, bundled: () => BUNDLED, logger, ...extra };
}

const rowOf = (status: SyncStatus, name: string): TemplateRow => {
  const found = status.rows.find((r) => r.name === name);
  if (!found) throw new Error(`no row named ${name} in status (have: ${status.rows.map((r) => r.name).join(', ')})`);
  return found;
};

const writes = (calls: string[]): string[] => calls.filter((c) => c !== 'list');
const creates = (calls: string[]): string[] => calls.filter((c) => c.startsWith('create:'));

const warnings = (): string[] =>
  vi
    .mocked(logger.warn)
    .mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

/** Attach the rejection handler synchronously so advancing fake timers can
 *  never surface the pending failure as an unhandled rejection. */
function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected the write to reject, but it resolved');
    },
    (e: unknown) => e,
  );
}

/** Same reason as `rejectionOf`, for a write expected to SUCCEED under fake
 *  timers: a regression that turns it into a timeout must surface as a failed
 *  assertion, not as an unhandled rejection five real seconds later. */
function settled<T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> {
  return p.then(
    (ok) => ({ ok }),
    (err: unknown) => ({ err }),
  );
}

describe('bootSeed — seeds absent templates only', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    setTemplateReadOnly(false);
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('creates every missing template and never rewrites one OAP already has', async () => {
    const oap = fakeOap({ rows: [remoteRow('oap-uuid-general', EDITED_GENERAL)] });
    const status = await bootSeed(depsFor(oap.client));

    expect(creates(oap.calls)).toEqual([`create:${nameOf(OVERVIEW)}`, `create:${nameOf(ALERT)}`]);
    expect(oap.calls.some((c) => c.startsWith('update:'))).toBe(false);
    expect(oap.calls.some((c) => c.startsWith('disable:'))).toBe(false);
    // The operator's edited dashboard survives boot byte-for-byte and stays
    // the effective content — a seed must never reset it to the bundle.
    expect(oap.rows.find((r) => r.id === 'oap-uuid-general')?.configuration).toBe(EDITED_GENERAL);
    const general = rowOf(status, nameOf(LAYER));
    expect(general.status).toBe('diverged');
    expect(general.effective).toBe('remote');
    expect(general.remote?.id).toBe('oap-uuid-general');
    // Post-seed re-list: the freshly created ones report as synced, not fallback.
    expect(rowOf(status, nameOf(OVERVIEW)).status).toBe('synced');
    expect(rowOf(status, nameOf(ALERT)).status).toBe('synced');
  });

  it('does not resurrect a template the operator disabled', async () => {
    const oap = fakeOap({ rows: [remoteRow('oap-uuid-general', cfgOf(LAYER), true)] });
    const status = await bootSeed(depsFor(oap.client));

    expect(creates(oap.calls)).toEqual([`create:${nameOf(OVERVIEW)}`, `create:${nameOf(ALERT)}`]);
    const general = rowOf(status, nameOf(LAYER));
    expect(general.status).toBe('disabled');
    expect(general.effective).toBeNull();
    expect(oap.rows.find((r) => r.id === 'oap-uuid-general')?.disabled).toBe(true);
  });

  it('writes nothing at all when OAP already matches the bundle', async () => {
    const oap = fakeOap({ rows: alreadySeeded() });
    const status = await bootSeed(depsFor(oap.client));

    // One list to read state. No re-list, because nothing changed, and boot
    // never probes for duplicates any more.
    expect(oap.calls).toEqual(['list']);
    expect(status.rows.map((r) => r.name).sort()).toEqual(BUNDLED.map(nameOf).sort());
    expect(status.rows.every((r) => r.status === 'synced')).toBe(true);
  });

  it('keeps seeding the remaining templates after one create fails', async () => {
    const oap = fakeOap({ createThrowsFor: [nameOf(OVERVIEW)] });
    const status = await bootSeed(depsFor(oap.client));

    expect(creates(oap.calls)).toEqual([
      `create:${nameOf(LAYER)}`,
      `create:${nameOf(OVERVIEW)}`,
      `create:${nameOf(ALERT)}`,
    ]);
    expect(rowOf(status, nameOf(LAYER)).status).toBe('synced');
    expect(rowOf(status, nameOf(ALERT)).status).toBe('synced');
    // The casualty degrades to the disk bundle rather than taking boot down.
    const overview = rowOf(status, nameOf(OVERVIEW));
    expect(overview.status).toBe('bundled-fallback');
    expect(overview.effective).toBe('bundled');
    expect(overview.remote).toBeNull();
    expect(warnings().some((w) => w.includes(nameOf(OVERVIEW)) && w.includes('seed failed'))).toBe(true);
  });

  it('OAP unreachable at boot — bundled-fallback status, not a single write attempted', async () => {
    const oap = fakeOap({ listThrows: true });
    const status = await bootSeed(depsFor(oap.client));

    expect(oap.calls).toEqual(['list']);
    expect(status.unreachable).toBe(true);
    expect(status.mode).toBe('live');
    // Every bundled template is still served — an OAP outage degrades to the
    // disk bundle, it does not blank the UI.
    expect(status.rows.map((r) => r.name).sort()).toEqual(BUNDLED.map(nameOf).sort());
    expect(status.rows.every((r) => r.status === 'bundled-fallback' && r.effective === 'bundled')).toBe(true);
    expect(rowOf(status, nameOf(LAYER)).bundled?.configuration).toBe(cfgOf(LAYER));
  });

  it('readonly mode never issues a write — bootSeed does not touch the ui_template client', async () => {
    setTemplateReadOnly(true);
    // `throwingClient` rejects every method, so any call would fail the boot.
    const status = await bootSeed({
      client: throwingClient,
      bundled: () => BUNDLED,
      bundledOverlays: () => [ZH_OVERLAY],
      logger,
    });
    expect(status.mode).toBe('readonly');
    expect(status.unreachable).toBe(false);
    expect(rowOf(status, nameOf(LAYER)).effective).toBe('remote');
    expect(rowOf(status, overlayNameOf(ZH_OVERLAY)).locale).toBe('zh-CN');
  });
});

describe('bootSeed — translation overlay seeding', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('creates only the overlay rows OAP is missing, leaving an edited one alone', async () => {
    const editedZh = serializeEnvelope(
      buildOverlayEnvelope('layer', 'GENERAL', 'zh-CN', { title: '操作员改过的标题' }),
    );
    const oap = fakeOap({ rows: [...alreadySeeded(), remoteRow('oap-zh', editedZh)] });
    const status = await bootSeed(depsFor(oap.client, { bundledOverlays: () => [ZH_OVERLAY, ES_OVERLAY] }));

    expect(writes(oap.calls)).toEqual([`create:${overlayNameOf(ES_OVERLAY)}`]);
    expect(oap.rows.find((r) => r.id === 'oap-zh')?.configuration).toBe(editedZh);

    const es = rowOf(status, overlayNameOf(ES_OVERLAY));
    expect(es.locale).toBe('es');
    expect(es.effective).toBe('remote');
    expect(es.remote?.configuration).toBe(overlayCfgOf(ES_OVERLAY));
    // `key` is the PARENT template's key — the `.i18n.<locale>` tail is stripped
    // so consumers can pair the overlay with its source row.
    expect(es.kind).toBe('overview');
    expect(es.key).toBe('services');
  });

  it('seeds no overlays when the caller supplies none — the disk catalog is never pushed implicitly', async () => {
    const oap = fakeOap({ rows: alreadySeeded() });
    await bootSeed(depsFor(oap.client));
    expect(writes(oap.calls)).toEqual([]);
  });
});

describe('createAndConfirm — write plus read-after-write confirmation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the envelope name as the requested id (upstream skywalking#13884) and returns the ack id', async () => {
    const oap = fakeOap();
    const id = await createAndConfirm(oap.client, cfgOf(LAYER), logger);
    expect(id).toBe('horizon.layer.GENERAL');
    expect(oap.calls[0]).toBe('create:horizon.layer.GENERAL');
    expect(oap.rows.map((r) => r.id)).toEqual(['horizon.layer.GENERAL']);
  });

  it('takes the ACKED id as the row handle when OAP assigns its own, not the requested one', async () => {
    vi.useFakeTimers();
    // OAP releases before skywalking#13884 ignore the requested id and mint a
    // UUID. Keeping the requested id here would make every create poll for a
    // row id that never exists — a 504 on a write that actually succeeded.
    const oap = fakeOap({ assignsId: { [nameOf(LAYER)]: 'oap-uuid-42' } });
    const created = settled(createAndConfirm(oap.client, cfgOf(LAYER), logger));
    await vi.advanceTimersByTimeAsync(6000);

    expect(oap.calls[0]).toBe(`create:${nameOf(LAYER)}`);
    expect(await created).toEqual({ ok: 'oap-uuid-42' });
    expect(oap.rows.map((r) => r.id)).toEqual(['oap-uuid-42']);
  });

  it('keeps polling list() until the row appears — the ack alone is not trusted', async () => {
    vi.useFakeTimers();
    const oap = fakeOap({ hiddenLists: 3 });
    const created = createAndConfirm(oap.client, cfgOf(LAYER), logger);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(created).resolves.toBe('horizon.layer.GENERAL');
    expect(oap.calls.filter((c) => c === 'list').length).toBe(4);
  });

  it('throws WriteNotVisibleError carrying the id when the write never propagates', async () => {
    vi.useFakeTimers();
    const oap = fakeOap({ hiddenLists: Infinity });
    const captured = rejectionOf(createAndConfirm(oap.client, cfgOf(LAYER), logger));
    await vi.advanceTimersByTimeAsync(6000);
    const err = await captured;

    expect(err).toBeInstanceOf(WriteNotVisibleError);
    const notVisible = err as WriteNotVisibleError;
    // The admin routes hand `id` back to the operator in the 504 body.
    expect(notVisible.kind).toBe('create');
    expect(notVisible.id).toBe('horizon.layer.GENERAL');
    expect(notVisible.timeoutMs).toBe(5000);
    expect(notVisible.message).toContain('horizon.layer.GENERAL');
    expect(oap.calls.filter((c) => c === 'list').length).toBeGreaterThan(1);
  });

  it('rejects a negative ack without polling for visibility', async () => {
    const oap = fakeOap({ createNacksFor: [nameOf(LAYER)] });
    await expect(createAndConfirm(oap.client, cfgOf(LAYER), logger)).rejects.toThrow(
      'OAP rejected create: duplicate name',
    );
    expect(oap.calls).toEqual(['create:horizon.layer.GENERAL']);
  });
});

describe('updateAndConfirm / disableAndConfirm — confirmed mutations', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('updateAndConfirm waits for the NEW bytes — a stale read keeps it polling', async () => {
    vi.useFakeTimers();
    const oap = fakeOap({ rows: [remoteRow('r1', cfgOf(LAYER))], hiddenLists: 2 });
    const updated = updateAndConfirm(oap.client, 'r1', EDITED_GENERAL, logger);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(updated).resolves.toBeUndefined();
    expect(oap.rows[0]?.configuration).toBe(EDITED_GENERAL);
    expect(oap.calls.filter((c) => c === 'list').length).toBe(3);
  });

  it('updateAndConfirm throws WriteNotVisibleError(update) when the new bytes never land', async () => {
    vi.useFakeTimers();
    const oap = fakeOap({ rows: [remoteRow('r1', cfgOf(LAYER))], hiddenLists: Infinity });
    const captured = rejectionOf(updateAndConfirm(oap.client, 'r1', EDITED_GENERAL, logger));
    await vi.advanceTimersByTimeAsync(6000);
    const err = await captured;

    expect(err).toBeInstanceOf(WriteNotVisibleError);
    expect((err as WriteNotVisibleError).kind).toBe('update');
    expect((err as WriteNotVisibleError).id).toBe('r1');
  });

  it('updateAndConfirm rejects a negative ack without polling', async () => {
    const oap = fakeOap({ rows: [remoteRow('r1', cfgOf(LAYER))] });
    const nacking = {
      ...oap.client,
      update: async () => ({ id: 'r1', status: false, message: 'read-only store' }),
    } as unknown as UITemplateClient;
    await expect(updateAndConfirm(nacking, 'r1', EDITED_GENERAL, logger)).rejects.toThrow(
      'OAP rejected update: read-only store',
    );
    expect(oap.calls).toEqual([]); // no visibility poll behind a rejected write
  });

  it('disableAndConfirm waits for disabled:true before returning', async () => {
    vi.useFakeTimers();
    const oap = fakeOap({ rows: [remoteRow('r1', cfgOf(LAYER))], hiddenLists: 1 });
    const disabled = disableAndConfirm(oap.client, 'r1', logger);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(disabled).resolves.toBeUndefined();
    expect(oap.rows[0]?.disabled).toBe(true);
    expect(oap.calls.filter((c) => c === 'list').length).toBe(2);
  });

  it('disableAndConfirm throws WriteNotVisibleError when the row never flips disabled', async () => {
    vi.useFakeTimers();
    const oap = fakeOap({ rows: [remoteRow('r1', cfgOf(LAYER))], hiddenLists: Infinity });
    const captured = rejectionOf(disableAndConfirm(oap.client, 'r1', logger));
    await vi.advanceTimersByTimeAsync(6000);
    const err = await captured;

    expect(err).toBeInstanceOf(WriteNotVisibleError);
    expect((err as WriteNotVisibleError).id).toBe('r1');
    // The operator reads this message in the 504 body — it must name the
    // operation that actually stalled, not a write we never issued.
    expect((err as WriteNotVisibleError).kind).toBe('disable');
    expect((err as WriteNotVisibleError).message).toBe('OAP disable id=r1 not visible within 5000ms');
  });
});

describe('duplicate / conflict reconciliation', () => {
  beforeEach(() => {
    invalidateSyncCache();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    invalidateSyncCache();
    vi.restoreAllMocks();
  });

  it('the read path renders one enabled row and reports every enabled id', async () => {
    const oap = fakeOap({
      rows: [
        remoteRow('z-late', cfgOf(LAYER)),
        remoteRow('a-early', EDITED_GENERAL),
        remoteRow('m-tombstone', cfgOf(LAYER), true),
        ...seededExceptLayer(),
      ],
    });
    const status = await getSyncStatus(depsFor(oap.client));

    expect(oap.calls).toEqual(['list']); // the read path never writes
    expect(status.conflicts).toHaveLength(1);
    expect(status.conflicts[0]).toMatchObject({
      name: nameOf(LAYER),
      kind: 'layer',
      key: 'GENERAL',
      enabledIds: ['a-early', 'z-late'], // sorted ASC, not ranked
    });
    expect(rowOf(status, nameOf(LAYER)).remote?.id).toBe('a-early');
  });

  it('the render pick is content-blind — lowest id, even if the other copy is the edited one', async () => {
    // Horizon does not rank one operator's dashboard above another's. It
    // draws the lowest id and reports the conflict; deciding which copy
    // deserves to survive is an OAP-side call for a human.
    const oap = fakeOap({
      rows: [
        remoteRow('a-pristine-seed', cfgOf(LAYER)),
        remoteRow('z-operator-edited', EDITED_GENERAL),
        ...seededExceptLayer(),
      ],
    });
    const status = await getSyncStatus(depsFor(oap.client));

    expect(oap.calls).toEqual(['list']);
    expect(rowOf(status, nameOf(LAYER)).remote?.id).toBe('a-pristine-seed');
    expect(status.conflicts[0]).toMatchObject({
      enabledIds: ['a-pristine-seed', 'z-operator-edited'],
    });
  });

  it('a translation overlay duplicate is reported like any other, and nothing is written', async () => {
    const editedZh = serializeEnvelope(
      buildOverlayEnvelope('layer', 'GENERAL', 'zh-CN', { title: '操作员改过的标题' }),
    );
    const oap = fakeOap({
      rows: [
        ...alreadySeeded(),
        remoteRow('a-zh-pristine', overlayCfgOf(ZH_OVERLAY)),
        remoteRow('z-zh-edited', editedZh),
      ],
    });
    const status = await bootSeed(depsFor(oap.client, { bundledOverlays: () => [ZH_OVERLAY] }));

    expect(writes(oap.calls)).toEqual([]);
    expect(oap.rows.every((r) => !r.disabled)).toBe(true);
    expect(rowOf(status, overlayNameOf(ZH_OVERLAY)).remote?.id).toBe('a-zh-pristine');
    expect(status.conflicts.map((c) => c.enabledIds)).toEqual([['a-zh-pristine', 'z-zh-edited']]);
  });

  it('a disabled twin is not a conflict — the enabled row wins whatever its id', async () => {
    const oap = fakeOap({
      rows: [
        remoteRow('a-tombstone', EDITED_GENERAL, true),
        remoteRow('z-live', cfgOf(LAYER)),
        ...seededExceptLayer(),
      ],
    });
    const status = await getSyncStatus(depsFor(oap.client));

    expect(status.conflicts).toEqual([]);
    expect(rowOf(status, nameOf(LAYER)).remote?.id).toBe('z-live');
    expect(rowOf(status, nameOf(LAYER)).status).toBe('synced');
  });

  it('boot REPORTS a same-name duplicate and disables nothing', async () => {
    // Retiring a row is irreversible and the winner rule reads the local
    // bundle, so two instances on different Horizon versions could each
    // judge the other's survivor to be the loser. Boot therefore never
    // resolves — it renders one row and hands the decision to an admin.
    const oap = fakeOap({
      rows: [remoteRow('dupe-a', cfgOf(LAYER)), remoteRow('dupe-b', cfgOf(LAYER)), ...seededExceptLayer()],
    });
    const status = await bootSeed(depsFor(oap.client));

    expect(writes(oap.calls)).toEqual([]);
    expect(oap.rows.every((r) => !r.disabled)).toBe(true);
    expect(status.conflicts.map((c) => c.name)).toEqual([nameOf(LAYER)]);
    expect(status.conflicts[0]?.enabledIds).toEqual(['dupe-a', 'dupe-b']);
    expect(rowOf(status, nameOf(LAYER)).remote?.id).toBe('dupe-a');
  });

  it('leaves an existing tombstone alone — no redundant disable on every boot', async () => {
    const oap = fakeOap({
      rows: [remoteRow('live', cfgOf(LAYER)), remoteRow('tombstone', EDITED_GENERAL, true), ...seededExceptLayer()],
    });
    await bootSeed(depsFor(oap.client));
    expect(writes(oap.calls)).toEqual([]);
  });

  it('boot renders the operator-edited twin and leaves BOTH rows enabled', async () => {
    // The edited copy is what the operator sees, and nothing is retired
    // behind their back: an unattended restart must never spend the
    // irreversible disable, whichever way the rule happens to point.
    const rows = [
      remoteRow('a-operator-edited', EDITED_GENERAL),
      remoteRow('z-pristine-seed', cfgOf(LAYER)),
      ...seededExceptLayer(),
    ];
    const read = await getSyncStatus(depsFor(fakeOap({ rows }).client));
    expect(rowOf(read, nameOf(LAYER)).remote?.id).toBe('a-operator-edited');

    invalidateSyncCache();
    const oap = fakeOap({ rows });
    const status = await bootSeed(depsFor(oap.client));

    expect(writes(oap.calls)).toEqual([]);
    expect(oap.rows.every((r) => !r.disabled)).toBe(true);
    expect(rowOf(status, nameOf(LAYER)).remote?.id).toBe('a-operator-edited');
    expect(rowOf(status, nameOf(LAYER)).remote?.configuration).toBe(EDITED_GENERAL);
    expect(rowOf(status, nameOf(LAYER)).status).toBe('diverged');
  });

  it('repeated boots stay inert while a duplicate is open', async () => {
    // A restart loop must not accumulate writes, and must not "helpfully"
    // resolve on the second pass either — the conflict simply persists until
    // an admin acts on it.
    const oap = fakeOap({
      rows: [
        remoteRow('a-pristine-seed', cfgOf(LAYER)),
        remoteRow('z-operator-edited', EDITED_GENERAL),
        ...seededExceptLayer(),
      ],
    });
    await bootSeed(depsFor(oap.client));

    invalidateSyncCache();
    const status = await bootSeed(depsFor(oap.client));

    expect(writes(oap.calls)).toEqual([]);
    expect(oap.rows.every((r) => !r.disabled)).toBe(true);
    expect(rowOf(status, nameOf(LAYER)).remote?.id).toBe('a-pristine-seed');
  });

  it('identical twins render the lowest id, whatever order OAP listed them in', async () => {
    // OAP hands the higher id back first. The winner must not depend on that
    // order, so every instance and the admin route agree on which row is live
    // — the property that makes a later manual resolve safe.
    const rows = [
      remoteRow('z-late', cfgOf(LAYER)),
      remoteRow('a-early', cfgOf(LAYER)),
      ...seededExceptLayer(),
    ];
    const read = await getSyncStatus(depsFor(fakeOap({ rows }).client));
    expect(rowOf(read, nameOf(LAYER)).remote?.id).toBe('a-early');

    invalidateSyncCache();
    const oap = fakeOap({ rows });
    const status = await bootSeed(depsFor(oap.client));

    expect(writes(oap.calls)).toEqual([]);
    expect(oap.rows.every((r) => !r.disabled)).toBe(true);
    expect(rowOf(status, nameOf(LAYER)).remote?.id).toBe('a-early');
  });

  it('a failed duplicate disable does not abort boot — the conflict stays visible to the admin UI', async () => {
    const oap = fakeOap({
      rows: [remoteRow('dupe-a', cfgOf(LAYER)), remoteRow('dupe-b', cfgOf(LAYER)), ...seededExceptLayer()],
      disableThrowsFor: ['dupe-b'],
    });
    const status = await bootSeed(depsFor(oap.client));

    expect(oap.rows.every((r) => !r.disabled)).toBe(true);
    expect(status.conflicts.map((c) => c.name)).toEqual([nameOf(LAYER)]);
    expect(status.conflicts[0]?.enabledIds).toEqual(['dupe-a', 'dupe-b']);
    expect(warnings().some((w) => w.includes('dupe-b'))).toBe(true);
  });

  it('a duplicated name is reported so the delete route can refuse it', async () => {
    // The delete route resolves a name to the single rendered row, so with two
    // enabled rows it would disable one and leave the sibling rendering. It
    // refuses instead, using exactly this conflict entry.
    const oap = fakeOap({
      rows: [remoteRow('dupe-a', cfgOf(LAYER)), remoteRow('dupe-b', cfgOf(LAYER)), ...seededExceptLayer()],
    });
    const status = await getSyncStatus(depsFor(oap.client));

    const conflict = status.conflicts.find((c) => c.name === nameOf(LAYER));
    expect(conflict).toBeDefined();
    expect(conflict!.enabledIds).toEqual(['dupe-a', 'dupe-b']);
    // The rendered row alone would be the delete target — proving why one
    // disable is not enough to remove the template.
    expect(rowOf(status, nameOf(LAYER)).remote?.id).toBe('dupe-a');
  });

  it('every duplicated name is reported with all of its enabled ids', async () => {
    // Two independent duplicate pairs. Both must reach the admin UI — a
    // partially-reported conflict set would let an operator "resolve" what
    // they can see and leave the rest silently duplicated.
    const oap = fakeOap({
      rows: [
        remoteRow('general-a', cfgOf(LAYER)),
        remoteRow('general-b', cfgOf(LAYER)),
        remoteRow('services-a', cfgOf(OVERVIEW)),
        remoteRow('services-b', cfgOf(OVERVIEW)),
        remoteRow('oap-page-setup', cfgOf(ALERT)),
      ],
    });
    const status = await bootSeed(depsFor(oap.client));

    expect(writes(oap.calls)).toEqual([]);
    expect(oap.rows.every((r) => !r.disabled)).toBe(true);
    expect(status.conflicts.map((c) => c.name).sort()).toEqual([nameOf(LAYER), nameOf(OVERVIEW)].sort());
    expect(status.conflicts.map((c) => c.enabledIds).flat().sort()).toEqual([
      'general-a', 'general-b', 'services-a', 'services-b',
    ]);
    expect(rowOf(status, nameOf(OVERVIEW)).remote?.id).toBe('services-a');
  });
});
