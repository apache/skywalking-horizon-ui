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

import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MatchedPeer, PairingsResponse } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';

const openTrace = vi.hoisted(() => vi.fn());
vi.mock('@/layer/traces/useTracePopout', () => ({ useTracePopout: () => ({ openTrace }) }));

const { default: PairingRoundView } = await import('./PairingRoundView.vue');

const peer = (i: number): MatchedPeer => ({
  peer: `svc-${String(i).padStart(4, '0')}:8080`,
  server: `svc-${String(i).padStart(4, '0')}`,
  callers: ['frontend'],
  address: `frontend->svc-${String(i).padStart(4, '0')}:8080`,
  count: 1,
  outcomes: { registered: 1 },
  firstTime: 1_700_000_000_000,
  lastTime: 1_700_000_000_000,
  nodes: ['10.0.0.5:17129'],
});

const found = (n: number): PairingsResponse => ({
  state: 'capturing',
  roundId: 'r1',
  startTime: 1_700_000_000_000,
  lastReadTime: 1_700_000_060_000,
  idleMillis: 60_000,
  received: { caller: n, callee: n },
  matched: n,
  unmatched: {},
  matchedPeers: Array.from({ length: n }, (_, i) => peer(i)),
  unmatchedPeers: [],
  unmatchedServers: [],
  nodes: [{ peer: '10.0.0.5:17129', status: 'ok', state: 'capturing', roundId: 'r1', matched: n }],
});

/** Each shown row's peer: the column after its kind. */
const peersShown = (view: ReturnType<typeof mount>): string[] =>
  view.findAll('tbody tr').map((row) => row.findAll('td')[1]!.text());

describe('PairingRoundView', () => {
  it('reads a long list a page at a time, the filter searching all of it first', async () => {
    const view = mount(PairingRoundView, { props: { found: found(1200), title: 'round' }, global: { plugins: [i18n] } });
    expect(peersShown(view)).toHaveLength(50);
    expect(peersShown(view)[0]).toBe('svc-0000:8080');
    expect(view.find('.otp__pager').text()).toContain('page 1 of 24 · 1200 rows');

    const next = view.findAll('.otp__pagebtn').find((b) => b.text() === 'Next')!;
    await next.trigger('click');
    expect(peersShown(view)[0]).toBe('svc-0050:8080');

    // The filter finds rows on every page, and starts again on the first.
    await view.find('input.otp__filter').setValue('svc-11');
    expect(peersShown(view)[0], 'from page 2, back on page 1').toBe('svc-1100:8080');
    expect(view.find('.otp__pager').text()).toContain('page 1 of 2 · 100 rows');
    await view.find('input.otp__filter').setValue('svc-1199');
    expect(peersShown(view)).toEqual(['svc-1199:8080']);
    expect(view.find('.otp__pager').exists(), 'one page needs no pager').toBe(false);
  });

  it('keeps the page in range when a live list shrinks under it', async () => {
    const view = mount(PairingRoundView, { props: { found: found(200), title: 'round' }, global: { plugins: [i18n] } });
    const next = () => view.findAll('.otp__pagebtn').find((b) => b.text() === 'Next')!;
    await next().trigger('click');
    await next().trigger('click');
    await next().trigger('click');
    expect(view.find('.otp__pager').text()).toContain('page 4 of 4');
    await view.setProps({ found: found(120) });
    expect(view.find('.otp__pager').text()).toContain('page 3 of 3');
    expect(peersShown(view)[0]).toBe('svc-0100:8080');
  });

  it('lists what the round found in one list, the most recent first, each kind narrowed by its chip', async () => {
    const round: PairingsResponse = {
      ...found(1),
      matchedPeers: [{ ...peer(1), lastTime: 3_000 }],
      unmatchedPeers: [{ peer: 'pay:9090', callers: ['checkout'], count: 41, causes: { expired: 41 }, firstTime: 1, lastTime: 5_000, traceIds: ['4bf9'], nodes: ['10.0.0.6:17129'] }],
      unmatchedServers: [{ server: 'stock', rules: ['otlp-general'], count: 3, causes: { expired: 3 }, firstTime: 1, lastTime: 4_000, traceIds: ['4bf92f3577b34da6a3ce929d0e0e4736'], nodes: ['10.0.0.5:17129'] }],
    };
    const view = mount(PairingRoundView, { props: { found: round, title: 'round' }, global: { plugins: [i18n] } });
    const kinds = () => view.findAll('tbody tr').map((row) => row.findAll('td')[0]!.text());
    expect(kinds(), 'newest first, every kind').toEqual(['unmatched caller', 'unmatched callee', 'matched']);
    expect(view.findAll('tbody tr')[0]!.text()).toContain('expired 41');
    const traces = view.findAll('tbody tr')[1]!.find('select.otp__traces');
    expect(traces.findAll('option').map((o) => o.text()), 'a prompt, then each trace id whole').toEqual([
      'open a trace (1)', '4bf92f3577b34da6a3ce929d0e0e4736',
    ]);
    await traces.setValue('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(openTrace, 'the picked trace opens through TraceQL, around when it was seen')
      .toHaveBeenCalledWith('4bf92f3577b34da6a3ce929d0e0e4736', 'traceql-otlp', { at: 4_000 });
    expect((traces.element as HTMLSelectElement).value, 'the list is back on its prompt').toBe('');
    expect(view.findAll('tbody tr')[2]!.find('select').exists(), 'a match lists no traces').toBe(false);
    const alias = view.findAll('tbody tr')[2]!.find('.otp__alias');
    expect(alias.find('.otp__aliasdialed').text(), 'the address the alias names').toBe('svc-0001:8080');
    expect(alias.find('.otp__aliasserver').text(), 'the server it represents').toBe('svc-0001');
    expect(alias.attributes('title'), 'the address as composed').toBe('frontend->svc-0001:8080');

    const chip = (label: string) => view.findAll('button[aria-pressed]').find((b) => b.text().startsWith(label))!;
    await chip('unmatched callees').trigger('click');
    expect(kinds()).toEqual(['unmatched callee']);
    await chip('all').trigger('click');
    await view.find('input.otp__filter').setValue('checkout');
    expect(kinds(), 'the search reaches every kind').toEqual(['unmatched caller']);
    await view.find('input.otp__filter').setValue('expired');
    expect(kinds(), 'and why pairings left').toEqual(['unmatched caller', 'unmatched callee']);
  });

  it('counts the OAP nodes in the round, and lists each with its calls matched or why it is not counted', () => {
    const round: PairingsResponse = {
      ...found(3),
      nodes: [
        { peer: '10.0.0.5:17129', status: 'ok', state: 'capturing', roundId: 'r1', matched: 2 },
        { peer: '10.0.0.6:17129', status: 'ok', state: 'capturing', roundId: 'r1', matched: 1 },
        { peer: '10.0.0.7:17129', status: 'unreachable' },
      ],
    };
    const view = mount(PairingRoundView, { props: { found: round, title: 'round' }, global: { plugins: [i18n] } });
    const stat = view.find('.otp__nodestat');
    expect(stat.text()).toContain('OAP nodes: 2 of 3 in this round');
    const cells = stat.findAll('.otp__nodepop > span:not(.otp__nodepoph)').map((c) => c.text());
    expect(cells, 'each node with its calls matched, or why it is not counted').toEqual([
      '10.0.0.5:17129', '2', '10.0.0.6:17129', '1', '10.0.0.7:17129', 'unreachable',
    ]);
    expect(stat.attributes('aria-label')).toBe('10.0.0.5:17129 · 2\n10.0.0.6:17129 · 1\n10.0.0.7:17129 · unreachable');
  });

  it('reads an alias as the peer it names only when the rule composed it as caller->peer, else whole', () => {
    const round = (address: string, at: string): PairingsResponse => ({
      ...found(1),
      matchedPeers: [{ ...peer(1), peer: at, server: 'pay', callers: ['front->end'], address }],
    });
    const shown = (address: string, at: string) =>
      mount(PairingRoundView, { props: { found: round(address, at), title: 'round' }, global: { plugins: [i18n] } })
        .find('.otp__aliasdialed').text();
    expect(shown('front->end->pay:443', 'pay:443'), 'a caller whose name holds an arrow').toBe('pay:443');
    expect(shown('east->tenant/pay:443', 'pay:443'), 'a rule\u2019s own composition').toBe('east->tenant/pay:443');
    expect(shown('pay:443', 'pay:443'), 'an address with no caller').toBe('pay:443');
  });

  it('says an alias none of whose calls registered was not registered, and why, rather than what it represents', () => {
    const long = `frontend->${'a'.repeat(210)}:8080`;
    const detail = (outcomes: MatchedPeer['outcomes']) =>
      mount(PairingRoundView, {
        props: { found: { ...found(1), matchedPeers: [{ ...peer(1), address: long, outcomes }] }, title: 'round' },
        global: { plugins: [i18n] },
      }).findAll('tbody td')[5]!;
    const rejected = detail({ tooLong: 3 });
    expect(rejected.text()).toContain('not registered: tooLong 3');
    expect(rejected.text(), 'the address OAP rejected, whole').toContain(long);
    expect(rejected.find('.otp__aliasserver').exists(), 'no server it represents').toBe(false);
    expect(detail({ tooLong: 12_001 }).find('.otp__warn').attributes('title'), 'the exact count on hover').toBe('tooLong 12001');

    const mixed = detail({ registered: 1, tooLong: 2 });
    expect(mixed.find('.otp__aliasserver').text(), 'a call registered it').toBe('svc-0001');
    expect(mixed.text()).not.toContain('not registered');
  });
});
