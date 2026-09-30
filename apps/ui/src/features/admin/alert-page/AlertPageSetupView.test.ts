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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { i18n } from '@/i18n';
import { ALARM_PAGES_QUERY_KEY } from '@/shell/useAlarmPages';
import TemplateDiffModal from '@/features/admin/_shared/TemplateDiffModal.vue';
import AlertPageSetupView from './AlertPageSetupView.vue';
import AlertPageEditor from './AlertPageEditor.vue';
import { ALERT_ROWS_QUERY_KEY } from './useAlertPageEditor';

// The diff modal loads Monaco, which jsdom cannot run.
vi.mock('@/features/admin/_shared/TemplateDiffModal.vue', () => ({ default: { template: '<div />' } }));

const grants = vi.hoisted(() => new Set<string>());
vi.mock('@/state/auth', () => ({ useAuthStore: () => ({ hasVerb: (v: string) => grants.has(v) }) }));

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const layer = (key: string, serviceCount: number, extra: Record<string, unknown> = {}) => ({
  key, name: key, color: '#fff', serviceCount, active: serviceCount >= 0, level: null, slots: {}, caps: {}, ...extra,
});

const DEFAULT_CONTENT = { pinnedLayers: ['GENERAL'], defaultWindowMs: 1_200_000, overviewAlarmsLimit: 200 };

function alertRow(key: string, content: unknown, disabled = false) {
  const name = `horizon.alert.${key}`;
  return {
    name,
    kind: 'alert',
    key,
    status: disabled ? 'disabled' : 'remote-only',
    effective: disabled ? null : 'remote',
    remote: { id: `id-${key}`, configuration: JSON.stringify({ content, kind: 'alert', name, version: 1 }), disabled },
    bundled: null,
  };
}

let rows: ReturnType<typeof alertRow>[] = [];
let saves: Array<{ name: string; content: unknown }> = [];
let disables: string[] = [];
let resyncs = 0;
/** How the save route answers: stored and confirmed, or a 504 after OAP took
 *  the write (`landed`) or before it showed it (`unseen`). */
let saveReply: 'ok' | 'timeout-landed' | 'timeout-unseen' = 'ok';
let disableStatus = 200;
/** Every read of the stored pages fails — set once a test has mounted. */
let readsFail = false;
/** Requests to hold until the test lets them go. */
let hold: { save?: Promise<void>; resync?: Promise<void> } = {};
let roster: Array<{ id: string; name: string; normal: boolean; group: string | null }> = [];
let menuLayers: Array<ReturnType<typeof layer>> = [];

const contentOf = (r: ReturnType<typeof alertRow>): unknown =>
  (JSON.parse(r.remote.configuration) as { content: unknown }).content;

function status() {
  return { mode: 'live', unreachable: false, lastSuccessfulSyncAt: 1, generatedAt: 1, rows };
}

beforeEach(() => {
  grants.clear();
  grants.add('alarm-setup:read');
  grants.add('alarm-setup:write');
  saves = [];
  disables = [];
  resyncs = 0;
  saveReply = 'ok';
  disableStatus = 200;
  readsFail = false;
  hold = {};
  roster = [
    { id: 'a', name: 'payments::api', normal: true, group: 'payments' },
    { id: 'b', name: 'risk::scorer', normal: true, group: 'risk' },
    { id: 'c', name: 'loose', normal: true, group: null },
  ];
  menuLayers = [
    layer('general', 3),
    layer('mesh', 0),
    layer('banyandb', -1),
    layer('k8s_service', 2, { serviceGroup: 'payments-prod' }),
  ];
  rows = [
    alertRow('default', DEFAULT_CONTENT),
    // The retired singleton: never a page.
    alertRow('page-setup', { pinnedLayers: ['MESH'], defaultWindowMs: 1_200_000, overviewAlarmsLimit: 200 }),
    alertRow('oncall', { id: 'oncall', title: 'On-call', order: 10, pinnedLayers: ['GENERAL[payments]'] }),
    alertRow('batch', { id: 'batch', title: 'Batch jobs', pinnedLayers: ['K8S_SERVICE'] }),
    alertRow('audit', { id: 'audit', title: 'Audit', order: 10, pinnedLayers: ['MESH'] }),
    alertRow('retired', { id: 'retired', title: 'Retired', pinnedLayers: ['GENERAL'] }, true),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://ui');
      const path = url.pathname;
      if (path === '/api/menu') {
        return json({ layers: menuLayers, oap: { reachable: true } });
      }
      const readBack = ['/api/configs/settings', '/api/admin/templates/sync-status', '/api/admin/templates/resync'];
      if (readsFail && readBack.includes(path)) return json({ error: 'oap_unreachable' }, 503);
      if (path === '/api/configs/settings') {
        const stored = rows.find((r) => r.key === 'default' && !r.remote.disabled);
        return json({ alert: stored ? contentOf(stored) : DEFAULT_CONTENT });
      }
      if (path === '/api/admin/templates/sync-status') return json(status());
      if (path === '/api/admin/templates/resync') {
        resyncs++;
        if (hold.resync) await hold.resync;
        return json(status());
      }
      if (path === '/api/admin/templates/save') {
        if (hold.save) await hold.save;
        const body = JSON.parse(String(init?.body)) as { name: string; content: unknown };
        saves.push(body);
        const key = body.name.slice('horizon.alert.'.length);
        if (saveReply !== 'timeout-unseen') rows = [...rows.filter((r) => r.key !== key), alertRow(key, body.content)];
        return saveReply === 'ok' ? json(status()) : json({ error: 'oap_propagation_timeout' }, 504);
      }
      if (path === '/api/admin/templates/disable') {
        const body = JSON.parse(String(init?.body)) as { name: string };
        disables.push(body.name);
        if (disableStatus !== 200) return json({ error: 'conflict', message: 'the row changed on OAP' }, disableStatus);
        rows = rows.map((r) => (r.name === body.name ? alertRow(r.key, contentOf(r), true) : r));
        return json(status());
      }
      if (path === '/api/alarms/services') {
        return json({ layer: url.searchParams.get('layer'), services: roster });
      }
      return json({});
    }),
  );
});

let queryClient: QueryClient;

async function mountView(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }] });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const w = mount(AlertPageSetupView, {
    global: {
      plugins: [router, i18n, createPinia(), [VueQueryPlugin, { queryClient }]],
      stubs: { teleport: true },
    },
  });
  await flushPromises();
  return w;
}

const listLabels = (w: VueWrapper) => w.findAll('.apl__row .apl__label').map((r) => r.text());
const pinnedCodes = (w: VueWrapper) => w.findAll('.apin__pin .apin__code').map((c) => c.text());
function rowTag(w: VueWrapper, label: string): string | null {
  const row = w.findAll('.apl__row').find((r) => r.find('.apl__label').text() === label);
  if (!row) throw new Error(`no page row "${label}"`);
  const tag = row.find('.apl__tag');
  return tag.exists() ? tag.text() : null;
}
const statusLine = (w: VueWrapper) => w.find('.aps__actions > span').text();
const saveButton = (w: VueWrapper) => w.find('.aps__btn--primary');
const selectedLabel = (w: VueWrapper) => w.find('.apl__row.active .apl__label').text();

async function clickRow(w: VueWrapper, label: string): Promise<void> {
  const row = w.findAll('.apl__row').find((r) => r.find('.apl__label').text() === label);
  if (!row) throw new Error(`no page row "${label}"`);
  await row.trigger('click');
  await flushPromises();
}

async function chooseLayer(w: VueWrapper, key: string): Promise<void> {
  const btn = w.findAll('.apin__layer').find((b) => b.find('code').text() === key);
  if (!btn) throw new Error(`no layer "${key}"`);
  await btn.trigger('click');
  await flushPromises();
}

async function clickButton(w: VueWrapper, selector: string, text: string): Promise<void> {
  const btn = w.findAll(selector).find((b) => b.text() === text);
  if (!btn) throw new Error(`no button "${text}"`);
  await btn.trigger('click');
  await flushPromises();
}

describe('Alarm pages admin — list', () => {
  it('lists the default page first, then the enabled named pages by order, title and id', async () => {
    const w = await mountView();
    expect(listLabels(w)).toEqual(['Alarms (default)', 'Audit', 'On-call', 'Batch jobs']);
    expect(w.findAll('.apl__row .apl__path').map((p) => p.text())).toEqual([
      '/alarms',
      '/alarms/audit',
      '/alarms/oncall',
      '/alarms/batch',
    ]);
  });

  it('offers every layer the menu knows, with or without services, a split layer under its base key', async () => {
    const w = await mountView();
    expect(w.findAll('.apin__layer code').map((c) => c.text())).toEqual(['BANYANDB', 'GENERAL', 'K8S_SERVICE', 'MESH']);
  });

  it('is read-only without alarm-setup:write', async () => {
    grants.delete('alarm-setup:write');
    const w = await mountView();
    expect(w.find('.apl__new').attributes('disabled')).toBeDefined();
    expect(w.findAll('.apin__layer').every((b) => b.attributes('disabled') !== undefined)).toBe(true);
    expect(w.find('.aps__btn--primary').attributes('disabled')).toBeDefined();
  });
});

async function newPage(w: VueWrapper, id: string, title: string): Promise<void> {
  await w.find('.apl__new').trigger('click');
  const inputs = w.findAll('.nap__in');
  await inputs[0]!.setValue(id);
  await inputs[1]!.setValue(title);
  await clickButton(w, '.sw-btn', 'Create');
  await chooseLayer(w, 'GENERAL');
  await clickButton(w, '.apin__btn', 'Add pin');
}

describe('Alarm pages admin — new page', () => {
  async function typeId(w: VueWrapper, id: string, title = 'Payments'): Promise<string[]> {
    const inputs = w.findAll('.nap__in');
    await inputs[0]!.setValue(id);
    await inputs[1]!.setValue(title);
    await clickButton(w, '.sw-btn', 'Create');
    return w.findAll('.nap__err').map((e) => e.text());
  }

  it('refuses a malformed, reserved or already stored id — a disabled row included', async () => {
    const w = await mountView();
    await w.find('.apl__new').trigger('click');
    expect((await typeId(w, 'Payments'))[0]).toMatch(/lower-case letters/);
    expect((await typeId(w, 'default'))[0]).toMatch(/reserved/);
    expect((await typeId(w, 'page-setup'))[0]).toMatch(/reserved/);
    expect((await typeId(w, 'retired'))[0]).toMatch(/already stored on OAP/);
    expect((await typeId(w, 'oncall'))[0]).toMatch(/already stored on OAP/);
    expect(listLabels(w)).not.toContain('Payments');
  });

  it('opens a valid new page unsaved, and saves it only once it has a pin', async () => {
    const w = await mountView();
    await w.find('.apl__new').trigger('click');
    expect(await typeId(w, 'payments', 'Payments')).toEqual([]);
    expect(listLabels(w)).toContain('Payments');
    expect(w.find('.aps__btn--primary').attributes('disabled')).toBeDefined();

    await chooseLayer(w, 'GENERAL');
    await clickButton(w, '.apin__btn', 'Add pin');
    await w.find('.aps__btn--primary').trigger('click');
    await flushPromises();

    expect(saves).toEqual([
      { name: 'horizon.alert.payments', content: { id: 'payments', title: 'Payments', pinnedLayers: ['GENERAL'] } },
    ]);
    // No order: it sorts as 1000, beside "Batch jobs", then by title.
    expect(listLabels(w)).toEqual(['Alarms (default)', 'Audit', 'On-call', 'Batch jobs', 'Payments']);
  });

  // The modal checked the id when the page was named; a save is what writes
  // it, so the check is made again then. A row stored under the id since —
  // disabled, or someone else's page — must not be written into.
  it.each([
    ['a disabled row', alertRow('payments', { id: 'payments', title: 'Payments', pinnedLayers: ['GENERAL'] }, true)],
    ['another page', alertRow('payments', { id: 'payments', title: 'Theirs', pinnedLayers: ['MESH'] })],
  ])('refuses at save time an id stored since it was named — %s — and keeps the page unsaved', async (_, taken) => {
    const w = await mountView();
    await newPage(w, 'payments', 'Payments');
    rows.push(taken);
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(saves).toEqual([]);
    expect(statusLine(w)).toMatch(/already stored on OAP/);
    expect(rowTag(w, 'Payments')).toBe('not saved');
    expect(w.findAll('.aps__btn').some((b) => b.text() === 'discard')).toBe(true);
  });

  // An id is looked up per page; one that names an Object member must still be
  // just a page.
  it('edits and saves a page whose id is also a member of every object', async () => {
    const w = await mountView();
    await w.find('.apl__new').trigger('click');
    expect(await typeId(w, 'constructor', 'Ctor')).toEqual([]);
    await chooseLayer(w, 'GENERAL');
    await clickButton(w, '.apin__btn', 'Add pin');
    await w.find('.aps__btn--primary').trigger('click');
    await flushPromises();
    expect(saves).toEqual([
      { name: 'horizon.alert.constructor', content: { id: 'constructor', title: 'Ctor', pinnedLayers: ['GENERAL'] } },
    ]);
  });
});

describe('Alarm pages admin — pins', () => {
  it('builds a pin from a layer and its service groups, the ungrouped services as "-"', async () => {
    const w = await mountView();
    await chooseLayer(w, 'GENERAL');
    expect(w.findAll('.apin__group').map((g) => g.text())).toEqual(['payments', 'risk', 'no group']);

    await clickButton(w, '.apin__group', 'payments');
    await clickButton(w, '.apin__group', 'no group');
    expect(w.find('.apin__candidate').text()).toBe('GENERAL[payments, -]');
    await clickButton(w, '.apin__btn', 'Add pin');

    expect(pinnedCodes(w)).toEqual(['GENERAL', 'GENERAL[payments, -]']);
    expect(w.findAll('.apin__pin .apin__label').map((l) => l.text())).toEqual(['General', 'payments, no group · General']);
  });

  it('keeps a typed group no service has now, with a warning', async () => {
    const w = await mountView();
    await chooseLayer(w, 'GENERAL');
    await w.find('.apin__in').setValue('billing');
    await w.find('.apin__in').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(w.find('.apin__candidate').text()).toBe('GENERAL[billing]');
    expect(w.findAll('.apin__note--warn')).toHaveLength(1);
    await clickButton(w, '.apin__btn', 'Add pin');
    expect(pinnedCodes(w)).toEqual(['GENERAL', 'GENERAL[billing]']);
  });

  it('does not add the same pin twice', async () => {
    const w = await mountView();
    await chooseLayer(w, 'GENERAL');
    const add = w.findAll('.apin__btn').find((b) => b.text() === 'Add pin')!;
    expect(add.attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('Already pinned.');
  });
});

describe('Alarm pages admin — save', () => {
  it('saves the default page as horizon.alert.default with its three fields', async () => {
    const w = await mountView();
    await chooseLayer(w, 'MESH');
    await clickButton(w, '.apin__btn', 'Add pin');
    await w.find('.aps__btn--primary').trigger('click');
    await flushPromises();
    expect(saves).toEqual([
      {
        name: 'horizon.alert.default',
        content: { pinnedLayers: ['GENERAL', 'MESH'], defaultWindowMs: 1_200_000, overviewAlarmsLimit: 200 },
      },
    ]);
  });

  it('saves a named page under its own row, leaving an inherited window out', async () => {
    const w = await mountView();
    await clickRow(w, 'On-call');
    await w.find('.ape__field--grow input').setValue('Payments on-call');
    await w.find('.aps__btn--primary').trigger('click');
    await flushPromises();
    expect(saves).toEqual([
      {
        name: 'horizon.alert.oncall',
        content: { id: 'oncall', title: 'Payments on-call', order: 10, pinnedLayers: ['GENERAL[payments]'] },
      },
    ]);
    expect(listLabels(w)).toContain('Payments on-call');
  });

  it('lets the "saved" note expire, so a later edit shows as unsaved', async () => {
    const w = await mountView();
    await clickRow(w, 'On-call');
    await w.find('.ape__field--grow input').setValue('Payments on-call');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await w.find('.aps__btn--primary').trigger('click');
      await flushPromises();
      expect(w.text()).toContain('saved');
      vi.advanceTimersByTime(4_000);
      await w.find('.ape__field--grow input').setValue('Payments on-call, again');
      await flushPromises();
      expect(w.find('.aps__dirty').exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps edits per page while switching between them', async () => {
    const w = await mountView();
    await clickRow(w, 'Audit');
    await w.find('.ape__field--grow input').setValue('Audit trail');
    await clickRow(w, 'Alarms (default)');
    await clickRow(w, 'Audit');
    expect((w.find('.ape__field--grow input').element as HTMLInputElement).value).toBe('Audit trail');
    expect(w.find('.aps__dirty').text()).toBe('unsaved changes');
  });
});

describe('Alarm pages admin — a save that cannot be read back', () => {
  it('keeps the default page\'s edits, and says so, when its stored settings cannot be read again', async () => {
    const w = await mountView();
    await chooseLayer(w, 'MESH');
    await clickButton(w, '.apin__btn', 'Add pin');
    readsFail = true;
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(saves).toHaveLength(1);
    expect(pinnedCodes(w)).toEqual(['GENERAL', 'MESH']);
    expect(statusLine(w)).toMatch(/^Saved, but the stored page could not be read back/);
  });

  it('reads a named page back from the save\'s own answer', async () => {
    const w = await mountView();
    await clickRow(w, 'On-call');
    await w.find('.ape__field--grow input').setValue('Payments on-call');
    readsFail = true;
    await saveButton(w).trigger('click');
    await flushPromises();
    expect((w.find('.ape__field--grow input').element as HTMLInputElement).value).toBe('Payments on-call');
    expect(listLabels(w)).toContain('Payments on-call');
    expect(statusLine(w)).toBe('saved · Payments on-call · 1 pinned');
  });

  it('drops a deleted page from the list by the delete\'s own answer', async () => {
    const w = await mountView();
    await clickRow(w, 'On-call');
    await w.find('.aps__btn--danger').trigger('click');
    await flushPromises();
    readsFail = true;
    await w.find('.dap__in').setValue('oncall');
    await w.find('.dap__danger').trigger('click');
    await flushPromises();
    expect(listLabels(w)).not.toContain('On-call');
  });

  it('says a reset could not be read back, rather than that it took', async () => {
    const w = await mountView();
    readsFail = true;
    w.findComponent(TemplateDiffModal).vm.$emit('reset');
    await flushPromises();
    expect(statusLine(w)).toMatch(/^Reset, but the stored page could not be read back/);
  });
});

describe('Alarm pages admin — pins a group name cannot spell', () => {
  it('shows a group whose name a pin cannot write, but does not let it be picked', async () => {
    roster = [
      { id: 'a', name: 'a,b::api', normal: true, group: 'a,b' },
      { id: 'b', name: '-::api', normal: true, group: '-' },
      { id: 'c', name: 'x]::api', normal: true, group: 'x]' },
      { id: 'd', name: 'x[::api', normal: true, group: 'x[' },
      { id: 'e', name: 'payments::api', normal: true, group: 'payments' },
    ];
    const w = await mountView();
    await chooseLayer(w, 'MESH');
    const chip = (text: string) => w.findAll('.apin__group').find((g) => g.text() === text)!;
    for (const g of ['a,b', '-', 'x]', 'x[']) {
      expect(chip(g).attributes('disabled')).toBeDefined();
      expect(chip(g).attributes('title')).toMatch(/cannot be written in a pin/);
      await chip(g).trigger('click');
    }
    expect(w.find('.apin__candidate').text()).toBe('MESH');
    expect(chip('payments').attributes('disabled')).toBeUndefined();
    await chip('payments').trigger('click');
    expect(w.find('.apin__candidate').text()).toBe('MESH[payments]');
  });

  it('does not offer "Add pin" for a pin that would not read back as what was picked', async () => {
    menuLayers = [...menuLayers, layer('odd.layer', 1)];
    const w = await mountView();
    await chooseLayer(w, 'ODD.LAYER');
    const add = w.findAll('.apin__btn').find((b) => b.text() === 'Add pin')!;
    expect(add.attributes('disabled')).toBeDefined();
  });
});

describe('Alarm pages admin — a stored page the BFF does not serve', () => {
  it('tags a page a save would write differently "not served", and lets it be saved as it is', async () => {
    rows.push(alertRow('team', { id: 'team', title: 'Team', pinnedLayers: ['GENERAL'], order: '10' }));
    const w = await mountView();
    expect(rowTag(w, 'Team')).toBe('not served');
    expect(rowTag(w, 'On-call')).toBeNull();
    await clickRow(w, 'Team');
    expect(statusLine(w)).toBe('not served');
    expect(saveButton(w).attributes('disabled')).toBeUndefined();
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(saves).toEqual([{ name: 'horizon.alert.team', content: { id: 'team', title: 'Team', pinnedLayers: ['GENERAL'] } }]);
    expect(rowTag(w, 'Team')).toBeNull();
  });

  it('marks a stored pin that repeats another, and saves once it is removed', async () => {
    rows.push(alertRow('team', { id: 'team', title: 'Team', pinnedLayers: ['GENERAL', 'MESH', 'general'] }));
    const w = await mountView();
    expect(rowTag(w, 'Team')).toBe('not served');
    await clickRow(w, 'Team');
    expect(w.find('.ape__err--block').text()).toBe('The same pin is listed twice. Remove one of them.');
    expect(w.findAll('.apin__pin').map((p) => p.classes('apin__pin--bad'))).toEqual([false, false, true]);
    expect(saveButton(w).attributes('disabled')).toBeDefined();
    await w.findAll('.apin__del')[2]!.trigger('click');
    await flushPromises();
    expect(pinnedCodes(w)).toEqual(['GENERAL', 'MESH']);
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(saves).toEqual([{ name: 'horizon.alert.team', content: { id: 'team', title: 'Team', pinnedLayers: ['GENERAL', 'MESH'] } }]);
  });

  it('moves and removes each of two identical stored pins on its own', async () => {
    rows.push(alertRow('team', { id: 'team', title: 'Team', pinnedLayers: ['GENERAL', 'GENERAL', 'MESH'] }));
    const w = await mountView();
    await clickRow(w, 'Team');
    // MESH one place left, between the two.
    await w.findAll('.apin__pin')[2]!.findAll('.apin__arrow')[0]!.trigger('click');
    await flushPromises();
    expect(pinnedCodes(w)).toEqual(['GENERAL', 'MESH', 'GENERAL']);
    await w.findAll('.apin__del')[2]!.trigger('click');
    await flushPromises();
    expect(pinnedCodes(w)).toEqual(['GENERAL', 'MESH']);
  });
});

describe('Alarm pages admin — a save in flight or timed out', () => {
  it('holds the form still while a save is in flight, so nothing typed then is lost', async () => {
    const w = await mountView();
    await clickRow(w, 'On-call');
    const title = () => w.find('.ape__field--grow input');
    await title().setValue('Payments on-call');
    const gate = deferred();
    hold.save = gate.promise;
    await saveButton(w).trigger('click');
    await flushPromises();

    expect(saveButton(w).text()).toBe('saving…');
    expect(title().attributes('disabled')).toBeDefined();
    expect(w.findAll('.apin__layer').every((b) => b.attributes('disabled') !== undefined)).toBe(true);
    expect(w.findAll('.apin__del').every((b) => b.attributes('disabled') !== undefined)).toBe(true);
    expect(w.find('.aps__btn--danger').attributes('disabled')).toBeDefined();
    // An edit that reaches the editor anyway is refused, not kept and then dropped.
    w.findComponent(AlertPageEditor).vm.$emit('update', { title: 'Late edit' });
    await flushPromises();
    expect((title().element as HTMLInputElement).value).toBe('Payments on-call');

    gate.resolve();
    await flushPromises();
    expect(saves).toHaveLength(1);
    expect(statusLine(w)).toBe('saved · Payments on-call · 1 pinned');
    expect(title().attributes('disabled')).toBeUndefined();
  });

  it('settles a new page OAP stored after all, so the next save updates it', async () => {
    const w = await mountView();
    await newPage(w, 'payments', 'Payments');
    saveReply = 'timeout-landed';
    await saveButton(w).trigger('click');
    await flushPromises();

    expect(statusLine(w)).toBe('Refetched after timeout — the push may have completed; please verify.');
    expect(listLabels(w).filter((l) => l === 'Payments')).toHaveLength(1);
    expect(rowTag(w, 'Payments')).toBeNull();
    expect(w.findAll('.aps__btn').some((b) => b.text() === 'discard')).toBe(false);

    saveReply = 'ok';
    await w.find('.ape__field--grow input').setValue('Payments team');
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(saves[1]).toEqual({
      name: 'horizon.alert.payments',
      content: { id: 'payments', title: 'Payments team', pinnedLayers: ['GENERAL'] },
    });
    expect(statusLine(w)).toBe('saved · Payments team · 1 pinned');
  });

  it('keeps a new page OAP has not shown yet unsaved, and a retry finds that page rather than a taken id', async () => {
    const w = await mountView();
    await newPage(w, 'payments', 'Payments');
    saveReply = 'timeout-unseen';
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(statusLine(w)).toBe('Refetched after timeout — the push may have completed; please verify.');
    expect(rowTag(w, 'Payments')).toBe('not saved');

    // OAP shows the page it took, a moment late.
    rows.push(alertRow('payments', saves[0]!.content));
    saveReply = 'ok';
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(saves).toHaveLength(2);
    expect(statusLine(w)).toBe('saved · Payments · 1 pinned');
    expect(listLabels(w).filter((l) => l === 'Payments')).toHaveLength(1);
    expect(rowTag(w, 'Payments')).toBeNull();
  });

  it('lists a timed-out new page once when OAP shows it on a later read', async () => {
    const w = await mountView();
    await newPage(w, 'payments', 'Payments');
    saveReply = 'timeout-unseen';
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(rowTag(w, 'Payments')).toBe('not saved');

    rows.push(alertRow('payments', saves[0]!.content));
    await queryClient.invalidateQueries({ queryKey: ALERT_ROWS_QUERY_KEY });
    await flushPromises();
    expect(listLabels(w).filter((l) => l === 'Payments')).toHaveLength(1);
    expect(rowTag(w, 'Payments')).toBeNull();
    expect(selectedLabel(w)).toBe('Payments');
  });

  it('saves over a timed-out new page that OAP shows late, even after it was edited again', async () => {
    const w = await mountView();
    await newPage(w, 'payments', 'Payments');
    saveReply = 'timeout-unseen';
    await saveButton(w).trigger('click');
    await flushPromises();
    await w.find('.ape__field--grow input').setValue('Payments team');

    rows.push(alertRow('payments', saves[0]!.content));
    saveReply = 'ok';
    await saveButton(w).trigger('click');
    await flushPromises();
    expect(saves[1]).toEqual({
      name: 'horizon.alert.payments',
      content: { id: 'payments', title: 'Payments team', pinnedLayers: ['GENERAL'] },
    });
    expect(statusLine(w)).toBe('saved · Payments team · 1 pinned');
  });
});

describe('Alarm pages admin — delete', () => {
  async function openDelete(w: VueWrapper, label: string): Promise<void> {
    await clickRow(w, label);
    await w.find('.aps__btn--danger').trigger('click');
    await flushPromises();
  }
  async function confirmDelete(w: VueWrapper, id: string): Promise<void> {
    await w.find('.dap__in').setValue(id);
    await w.find('.dap__danger').trigger('click');
    await flushPromises();
  }

  it('disables the row, falls back to the default page and says so', async () => {
    const w = await mountView();
    await openDelete(w, 'On-call');
    await confirmDelete(w, 'oncall');
    expect(disables).toEqual(['horizon.alert.oncall']);
    expect(listLabels(w)).not.toContain('On-call');
    expect(selectedLabel(w)).toBe('Alarms (default)');
    expect(w.find('.dap__in').exists()).toBe(false);
    expect(statusLine(w)).toBe('deleted · On-call');
    // The default page cannot be deleted.
    expect(w.find('.aps__btn--danger').exists()).toBe(false);
  });

  it('keeps naming the page it was opened for while the delete finishes', async () => {
    const w = await mountView();
    await openDelete(w, 'On-call');
    const gate = deferred();
    hold.resync = gate.promise;
    await confirmDelete(w, 'oncall');
    expect(disables).toEqual(['horizon.alert.oncall']);
    expect(w.find('.dap__msg').text()).toContain('“On-call” (oncall)');
    expect(w.find('.dap__confirm code').text()).toBe('oncall');
    expect(w.find('.dap__danger').text()).toBe('Deleting…');
    gate.resolve();
    await flushPromises();
    expect(w.find('.dap__in').exists()).toBe(false);
  });

  it('keeps the page and the dialog when OAP refuses the delete', async () => {
    disableStatus = 409;
    const w = await mountView();
    await openDelete(w, 'On-call');
    await confirmDelete(w, 'oncall');
    expect(disables).toEqual(['horizon.alert.oncall']);
    expect(selectedLabel(w)).toBe('On-call');
    expect(listLabels(w)).toContain('On-call');
    expect(statusLine(w)).toMatch(/^error: /);
    expect(w.find('.dap__in').exists()).toBe(true);
  });
});

describe('Alarm pages admin — reset to bundled', () => {
  it('refreshes every reader of the default page, as a save does, and drops its edits here', async () => {
    const w = await mountView();
    queryClient.setQueryData(ALARM_PAGES_QUERY_KEY, { pages: [] });
    await chooseLayer(w, 'MESH');
    await clickButton(w, '.apin__btn', 'Add pin');
    expect(pinnedCodes(w)).toEqual(['GENERAL', 'MESH']);
    const before = resyncs;

    w.findComponent(TemplateDiffModal).vm.$emit('reset');
    await flushPromises();

    expect(resyncs).toBe(before + 1);
    expect(queryClient.getQueryState(ALARM_PAGES_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(pinnedCodes(w)).toEqual(['GENERAL']);
    expect(statusLine(w)).toBe('OAP reset to bundled · reload to see header changes');
  });
});
