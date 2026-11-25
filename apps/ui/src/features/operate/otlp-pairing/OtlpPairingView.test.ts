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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import type { PairingsResponse } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';

const pairings = vi.fn();
const stop = vi.fn();
vi.mock('@/api/client', () => ({
  bff: {
    otlpPairing: {
      pairings: (...args: unknown[]) => pairings(...args),
      start: vi.fn(),
      stop: (...args: unknown[]) => stop(...args),
    },
  },
  describeApiError: (err: unknown) => String(err),
  BffApiError: class BffApiError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  },
}));
vi.mock('@/shell/useAdminFeatures', () => ({
  useAdminFeatures: () => ({ result: ref({}), adminReachable: ref(true), adminError: ref(null) }),
}));
vi.mock('@/layer/traces/useTracePopout', () => ({ useTracePopout: () => ({ openTrace: vi.fn() }) }));

const { default: OtlpPairingView } = await import('./OtlpPairingView.vue');
const { resetPairingRoundsCache } = await import('./pairingRounds');

const round = (matched: number): PairingsResponse => ({
  state: 'capturing',
  roundId: 'r1',
  startTime: 1_700_000_000_000,
  lastReadTime: 1_700_000_060_000,
  idleMillis: 60_000,
  received: { caller: matched, callee: matched },
  matched,
  unmatched: {},
  matchedPeers: [
    {
      peer: 'backend:8080',
      server: 'backend',
      callers: ['frontend'],
      address: 'frontend->backend:8080',
      count: matched,
      outcomes: { registered: matched },
      firstTime: 1_700_000_001_000,
      lastTime: 1_700_000_059_000,
      nodes: ['10.0.0.5:17129', '10.0.0.6:17129'],
    },
  ],
  unmatchedPeers: [],
  unmatchedServers: [],
  nodes: [{ peer: '10.0.0.5:17129', status: 'ok', state: 'capturing', roundId: 'r1', matched }],
});
const off: PairingsResponse = { ...round(0), state: 'off', roundId: '', startTime: 0, lastReadTime: 0, matchedPeers: [], nodes: [] };

describe('OtlpPairingView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetPairingRoundsCache();
    pairings.mockReset();
    stop.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the round on the live tab once it stops, and opens it again from History', async () => {
    pairings.mockResolvedValueOnce(round(12_345));
    const page = mount(OtlpPairingView, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(page.text()).toContain('capturing round, since');
    expect(page.text(), 'the matched list shows calls, not their outcomes').not.toContain('registered');
    expect(page.text()).toContain('12k');
    expect(page.findAll('.otp__nodeline').map((n) => n.text()), 'the OAP nodes that hold the row, one a line').toEqual(['10.0.0.5:17129', '10.0.0.6:17129']);

    // Stop: one more read saves the round as it ended, then OAP releases it.
    pairings.mockResolvedValueOnce(round(12_400)).mockResolvedValue(off);
    stop.mockResolvedValueOnce({ nodes: [{ status: 'ok', capture: { state: 'off' } }] });
    await page.findAll('button').find((b) => b.text().includes('stop'))!.trigger('click');
    await flushPromises();
    expect(page.text(), 'the round just captured stays on screen').toContain('captured round');
    expect(page.text()).toContain('12k');

    await page.findAll('button[role="tab"]').find((b) => b.text().includes('History'))!.trigger('click');
    await flushPromises();
    expect(page.findAll('tbody tr').length).toBeGreaterThan(0);
    expect(page.find('.otp__roundpanel').exists(), 'rounds start folded').toBe(false);

    // Open: the round reads in a panel right under its row. Fold: it is gone again.
    const toggle = page.find('.otp__roundopen');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const panel = page.find('.otp__roundpanel');
    expect(panel.text()).toContain('captured round');
    expect(panel.find('.otp__alias').attributes('title'), 'the alias the saved round matched').toBe('frontend->backend:8080');
    expect(panel.element.closest('tr')!.previousElementSibling!.classList.contains('otp__roundrow--on'), 'under its own row').toBe(true);
    await toggle.trigger('click');
    expect(page.find('.otp__roundpanel').exists()).toBe(false);
    expect(toggle.attributes('aria-expanded')).toBe('false');
    page.unmount();
  });

  it('deletes the saved rounds that ended only once the operator confirms', async () => {
    pairings.mockResolvedValueOnce(round(9));
    const page = mount(OtlpPairingView, { global: { plugins: [i18n] } });
    await flushPromises();
    pairings.mockResolvedValueOnce(round(9)).mockResolvedValue(off);
    stop.mockResolvedValueOnce({ nodes: [{ status: 'ok', capture: { state: 'off' } }] });
    await page.findAll('button').find((b) => b.text().includes('stop'))!.trigger('click');
    await flushPromises();
    await page.findAll('button[role="tab"]').find((b) => b.text().includes('History'))!.trigger('click');
    await flushPromises();
    const button = (text: string) => page.findAll('button').find((b) => b.text() === text);
    const clear = () => button('clear saved rounds')!;

    // A round's ✕ turns into delete and cancel, in its row.
    await page.find('.otp__roundx').trigger('click');
    expect(page.find('.otp__roundrow .otp__confirm').exists()).toBe(true);
    await page.find('.otp__roundrow .otp__confirm').findAll('button').find((b) => b.text() === 'cancel')!.trigger('click');
    expect(page.findAll('.otp__roundrow'), 'cancelled: kept').toHaveLength(1);
    expect(page.find('.otp__roundx').exists(), 'the ✕ is back').toBe(true);

    // The clear asks in place, naming how many it deletes.
    await clear().trigger('click');
    expect(page.text()).toContain('Delete the 1 saved rounds that ended?');
    await button('cancel')!.trigger('click');
    expect(page.findAll('.otp__roundrow'), 'cancelled: nothing deleted').toHaveLength(1);
    await clear().trigger('click');
    await button('delete')!.trigger('click');
    await flushPromises();
    expect(page.findAll('.otp__roundrow')).toHaveLength(0);

    // A round that may still run, saved by another tab: nothing to clear; its ✕ still deletes it once confirmed.
    const { usePairingRounds } = await import('./pairingRounds');
    usePairingRounds().save({ ...round(5), roundId: 'r2', nodes: [{ status: 'ok', state: 'capturing', roundId: 'r2' }] });
    await flushPromises();
    expect(page.findAll('.otp__roundrow')).toHaveLength(1);
    expect(clear().attributes('disabled'), 'no saved round has ended').toBeDefined();
    await page.find('.otp__roundx').trigger('click');
    await page.find('.otp__roundrow .otp__confirm').findAll('button').find((b) => b.text() === 'delete')!.trigger('click');
    expect(page.findAll('.otp__roundrow'), 'confirmed: that one round deleted').toHaveLength(0);
    page.unmount();
  });

  it('keeps History open when OAP does not serve the capture, and the live tab on the round it ran', async () => {
    const { BffApiError } = (await import('@/api/client')) as unknown as { BffApiError: new (status: number) => Error };
    // A round this page ran, then another tab's newer round saved later.
    pairings.mockResolvedValueOnce(round(9));
    const page = mount(OtlpPairingView, { global: { plugins: [i18n] } });
    await flushPromises();
    pairings.mockResolvedValueOnce(round(9)).mockResolvedValue(off);
    stop.mockResolvedValueOnce({ nodes: [{ status: 'ok', capture: { state: 'off' } }] });
    await page.findAll('button').find((b) => b.text().includes('stop'))!.trigger('click');
    await flushPromises();
    const { usePairingRounds } = await import('./pairingRounds');
    usePairingRounds().save({ ...round(83), roundId: 'r2', startTime: 1_800_000_000_000, lastReadTime: 1_800_000_000_500,
      nodes: [{ status: 'ok', state: 'capturing', roundId: 'r2' }] });
    await flushPromises();
    expect(page.text(), 'the round this page ran, not the newer one').toContain('pairings received: 9 caller');
    expect(page.text()).not.toContain('pairings received: 83 caller');
    page.unmount();

    // OAP answers 404 now: the live tab says so, History still opens the saved rounds.
    pairings.mockReset();
    pairings.mockRejectedValue(new BffApiError(404));
    const later = mount(OtlpPairingView, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(later.text()).toContain('Needs Apache SkyWalking 11.2 or higher');
    expect(later.findAll('button').some((b) => b.text().includes('start capture')), 'nothing to start').toBe(false);
    await later.findAll('button[role="tab"]').find((b) => b.text().includes('History'))!.trigger('click');
    await flushPromises();
    expect(later.findAll('tbody tr').length).toBeGreaterThan(0);
    later.unmount();
  });

  it('lists the round it was reading in History once OAP stops serving the capture', async () => {
    const { BffApiError } = (await import('@/api/client')) as unknown as { BffApiError: new (status: number) => Error };
    pairings.mockResolvedValueOnce(round(9)).mockRejectedValue(new BffApiError(404));
    const page = mount(OtlpPairingView, { global: { plugins: [i18n] } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(page.text()).toContain('Needs Apache SkyWalking 11.2 or higher');
    await page.findAll('button[role="tab"]').find((b) => b.text().includes('History'))!.trigger('click');
    await flushPromises();
    expect(page.findAll('tbody tr').length, 'the round read before the 404').toBeGreaterThan(0);
    page.unmount();
  });

  it('shows no saved round on the live tab of a page just opened: the rounds from before are in History', async () => {
    const { usePairingRounds } = await import('./pairingRounds');
    usePairingRounds().save(round(9), true);
    pairings.mockResolvedValue(off);
    const page = mount(OtlpPairingView, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(page.text()).toContain('Start the capture to see how OAP pairs the calls it receives.');
    expect(page.text()).not.toContain('captured round');
    expect(page.find('.otp__pagecount').text()).toBe('1');
    page.unmount();
  });

  it('names a node that does not answer while the capture is off; while a round runs, its node count does', async () => {
    const unreachable = { peer: '10.0.0.7:17129', status: 'unreachable' as const };
    pairings.mockResolvedValue({ ...off, nodes: [{ peer: '10.0.0.5:17129', status: 'ok', state: 'off' }, unreachable] });
    const page = mount(OtlpPairingView, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(page.find('.otp__controls .otp__warn').text()).toBe('not answering: 10.0.0.7:17129 (unreachable)');
    page.unmount();

    localStorage.clear();
    resetPairingRoundsCache();
    const running = { ...round(3), nodes: [...round(3).nodes, unreachable] };
    pairings.mockResolvedValue(running);
    const live = mount(OtlpPairingView, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(live.find('.otp__nodestat').text(), 'the round counts it').toContain('OAP nodes: 1 of 2 in this round');
    expect(live.find('.otp__controls .otp__warn').exists(), 'and no second line names it').toBe(false);
    live.unmount();
  });

  it('asks one delete question at a time, and drops it on leaving History', async () => {
    const { usePairingRounds } = await import('./pairingRounds');
    usePairingRounds().save(round(9), true);
    usePairingRounds().markEnded('r1');
    pairings.mockResolvedValue(off);
    const page = mount(OtlpPairingView, { global: { plugins: [i18n] } });
    await flushPromises();
    const tab = (name: string) => page.findAll('button[role="tab"]').find((b) => b.text().includes(name))!;
    await tab('History').trigger('click');
    const clearAsked = () => page.text().includes('Delete the 1 saved rounds that ended?');

    await page.findAll('button').find((b) => b.text() === 'clear saved rounds')!.trigger('click');
    expect(clearAsked()).toBe(true);
    await page.find('.otp__roundx').trigger('click');
    expect(clearAsked(), 'the row’s question replaced the clear’s').toBe(false);
    expect(page.find('.otp__roundrow .otp__confirm').exists()).toBe(true);

    await tab('Live capture').trigger('click');
    await tab('History').trigger('click');
    expect(page.find('.otp__confirm').exists(), 'nothing left asking').toBe(false);
    expect(page.find('.otp__roundx').exists()).toBe(true);
    page.unmount();
  });
});
