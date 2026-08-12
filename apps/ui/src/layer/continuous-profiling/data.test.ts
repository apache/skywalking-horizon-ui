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

import { describe, expect, it } from 'vitest';
import type { ContinuousProfilingTargetType } from '@skywalking-horizon-ui/api-client';
import {
  autoPickDecision,
  isForeignSeed,
  matchRoster,
  modeOf,
  newCheckItem,
  pageOf,
  pickDefaultService,
  policyErrors,
  rosterReachable,
  shouldReseedAfterSave,
  shouldReseedUriMode,
  thresholdError,
} from './data';

const inst = (name: string, procs: string[]) => ({ name, processes: procs.map((p) => ({ name: p })) });

describe('matchRoster', () => {
  const rows = [inst('pod-a', ['envoy', 'app']), inst('pod-b', ['app']), inst('other', ['sidecar'])];

  it('returns everything for an empty query', () => {
    expect(matchRoster(rows, '   ')).toHaveLength(3);
  });

  it('matches an instance name', () => {
    expect(matchRoster(rows, 'POD-').map((r) => r.name)).toEqual(['pod-a', 'pod-b']);
  });

  it('finds the instance holding a named process', () => {
    expect(matchRoster(rows, 'envoy').map((r) => r.name)).toEqual(['pod-a']);
  });
});

describe('pageOf', () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1);

  it('reports 1-based inclusive bounds on a full page', () => {
    expect(pageOf(items, 1, 20)).toMatchObject({ page: 1, pages: 3, from: 1, to: 20 });
  });

  it('reports a short last page correctly', () => {
    const p = pageOf(items, 3, 20);
    expect(p).toMatchObject({ page: 3, pages: 3, from: 41, to: 45 });
    expect(p.rows).toHaveLength(5);
  });

  it('clamps a page beyond the end instead of stranding on an empty one', () => {
    expect(pageOf(items, 99, 20)).toMatchObject({ page: 3, from: 41, to: 45 });
    // the case that matters: a search narrows 45 rows to 3 while on page 3
    expect(pageOf(items.slice(0, 3), 3, 20)).toMatchObject({ page: 1, pages: 1, from: 1, to: 3 });
  });

  it('has no rows and no bounds when empty', () => {
    expect(pageOf([], 1, 20)).toMatchObject({ pages: 1, from: 0, to: -1, rows: [] });
  });
});

describe('thresholdError mirrors OAP validatePolicyItem', () => {
  it('rejects decimals for every monitor type', () => {
    for (const type of ['PROCESS_CPU', 'SYSTEM_LOAD', 'HTTP_ERROR_RATE', 'HTTP_AVG_RESPONSE_TIME'] as const) {
      expect(thresholdError(type, '4.5')?.key).toBe('Whole numbers only — OAP rejects anything else.');
    }
  });

  it('rejects zero and enforces the percentage ceiling', () => {
    expect(thresholdError('PROCESS_CPU', '0')?.key).toBe('Must be greater than 0.');
    expect(thresholdError('HTTP_ERROR_RATE', '101')).toMatchObject({ params: { max: 100 } });
    expect(thresholdError('HTTP_AVG_RESPONSE_TIME', '5000')).toBeNull();
  });
});

describe('newCheckItem', () => {
  it('picks a measurement the target is not already using', () => {
    expect(newCheckItem(['PROCESS_CPU']).type).toBe('PROCESS_THREAD_COUNT');
    expect(newCheckItem([]).type).toBe('PROCESS_CPU');
  });
});

describe('pickDefaultService', () => {
  const svcs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const map = (e: Array<[string, ContinuousProfilingTargetType[] | null]>) => new Map(e);

  it('prefers the first service that already has rules', () => {
    expect(pickDefaultService(svcs, map([['a', []], ['b', ['ON_CPU']], ['c', ['NETWORK']]]))?.id).toBe('b');
  });

  it('falls back to the first service when none is armed', () => {
    expect(pickDefaultService(svcs, map([['a', []], ['b', []], ['c', []]]))?.id).toBe('a');
  });

  it('treats an unanswered service as un-armed rather than armed', () => {
    // `null` = OAP would not tell us. Landing there shows an empty editor while
    // 'c' actually has rules.
    expect(pickDefaultService(svcs, map([['a', null], ['b', null], ['c', ['OFF_CPU']]]))?.id).toBe('c');
  });

  it('falls back to the first when the summary knows nothing at all', () => {
    expect(pickDefaultService(svcs, map([]))?.id).toBe('a');
  });

  it('has nothing to pick from an empty layer', () => {
    expect(pickDefaultService([], map([]))).toBeNull();
  });
});

describe('policyErrors gates Apply on what OAP would refuse', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    type: 'PROCESS_CPU' as const, threshold: '75', period: 60, count: 3, ...over,
  });
  const target = (items: ReturnType<typeof item>[]) => [{ type: 'ON_CPU' as const, checkItems: items }];

  it('passes a valid draft', () => {
    expect(policyErrors(target([item()]))).toEqual([]);
  });

  it('catches a fractional period and count rather than letting the BFF round them', () => {
    expect(policyErrors(target([item({ period: 1.5 })]))).not.toHaveLength(0);
    expect(policyErrors(target([item({ count: 2.4 })]))).not.toHaveLength(0);
  });

  it('catches zero and negative', () => {
    expect(policyErrors(target([item({ period: 0 })]))).not.toHaveLength(0);
    expect(policyErrors(target([item({ count: -1 })]))).not.toHaveLength(0);
  });

  it('catches count larger than period, which OAP rejects', () => {
    expect(policyErrors(target([item({ period: 10, count: 20 })]))).not.toHaveLength(0);
  });

  it('catches a decimal threshold, which OAP Integer.parseInts', () => {
    expect(policyErrors(target([item({ threshold: '4.5' })]))).not.toHaveLength(0);
  });

  it('catches two conditions on the same measurement in one target', () => {
    expect(policyErrors(target([item(), item()]))).not.toHaveLength(0);
  });

  it('catches a target with no conditions at all', () => {
    expect(policyErrors([{ type: 'ON_CPU', checkItems: [] }])).not.toHaveLength(0);
  });
});

describe('isForeignSeed', () => {
  const services = [{ id: 'a' }, { id: 'b' }];

  it('is false with no selection', () => {
    expect(isForeignSeed(null, services, false)).toBe(false);
  });

  it('is false for a selection present in the roster', () => {
    expect(isForeignSeed('a', services, false)).toBe(false);
  });

  it('is true for a selection absent from a LOADED roster', () => {
    expect(isForeignSeed('zzz', services, false)).toBe(true);
  });

  it('is false while the roster is still loading, even if the id is not (yet) in it', () => {
    // The dangerous default would be `true` here — it would flash the "Pick a
    // service" placeholder on every mount, before the roster has had a chance
    // to say whether the id belongs.
    expect(isForeignSeed('zzz', [], true)).toBe(false);
  });

  it('is true for a genuinely empty, LOADED layer', () => {
    expect(isForeignSeed('zzz', [], false)).toBe(true);
  });
});

describe('rosterReachable', () => {
  it('is true when the BFF answered reachable and the request itself succeeded', () => {
    expect(rosterReachable(true, false)).toBe(true);
  });

  it('is false when the BFF answered reachable:false', () => {
    expect(rosterReachable(false, false)).toBe(false);
  });

  it('is false when the REQUEST failed, even though data.reachable defaults true', () => {
    // The bug this guards: a transport failure (BFF down, network error) never
    // reaches the BFF's softErr, so `data` stays undefined and a bare
    // `data?.reachable ?? true` default would call an unreachable BFF reachable.
    expect(rosterReachable(undefined, true)).toBe(false);
  });

  it('defaults to true while still loading (no data yet, no error yet)', () => {
    expect(rosterReachable(undefined, false)).toBe(true);
  });
});

describe('autoPickDecision', () => {
  const base = {
    key: 'A',
    prevKey: null as string | null,
    hasServiceId: false,
    seedIsForeign: false,
    servicesLoading: false,
    summaryFetching: false,
    autoPickedFor: null as string | null,
  };

  it('picks on first arrival with nothing selected', () => {
    expect(autoPickDecision(base)).toEqual({ resetMarker: false, shouldPick: true });
  });

  it('does not reset or pick on the very first watcher tick (prevKey null)', () => {
    expect(autoPickDecision({ ...base, prevKey: null })).toMatchObject({ resetMarker: false });
  });

  it('does not pick when a real selection is already present', () => {
    expect(autoPickDecision({ ...base, hasServiceId: true })).toMatchObject({ shouldPick: false });
  });

  it('does not pick again once already picked for this layer', () => {
    expect(autoPickDecision({ ...base, autoPickedFor: 'A' })).toMatchObject({ shouldPick: false });
  });

  it('waits for the roster before picking', () => {
    expect(autoPickDecision({ ...base, servicesLoading: true })).toMatchObject({ shouldPick: false });
  });

  it('waits for the policy summary before picking, so it never guesses at "no policy"', () => {
    expect(autoPickDecision({ ...base, summaryFetching: true })).toMatchObject({ shouldPick: false });
  });

  it('re-picks despite an existing id when that id is foreign to this layer', () => {
    expect(autoPickDecision({ ...base, hasServiceId: true, seedIsForeign: true })).toMatchObject({ shouldPick: true });
  });

  // The exact regression: A -> B (zero services, never records a pick) -> A.
  // autoPickedFor is still 'A' from the FIRST visit, and without resetting on
  // a genuine layer change, layer A would be permanently skipped.
  it('resets a stale marker on a genuine layer change and re-picks', () => {
    const backOnA = { ...base, key: 'A', prevKey: 'B', autoPickedFor: 'A' };
    expect(autoPickDecision(backOnA)).toEqual({ resetMarker: true, shouldPick: true });
  });

  it('does not reset when the layer key is unchanged', () => {
    expect(autoPickDecision({ ...base, key: 'A', prevKey: 'A', autoPickedFor: 'A' })).toMatchObject({
      resetMarker: false,
      shouldPick: false,
    });
  });
});

describe('shouldReseedAfterSave', () => {
  const A = JSON.stringify([{ type: 'ON_CPU' }]);
  const B = JSON.stringify([{ type: 'OFF_CPU' }]);

  it('reseeds when the confirm read succeeded, the draft is unchanged, and the service is unchanged', () => {
    expect(shouldReseedAfterSave({ succeeded: true, reachable: true }, A, A, 'svc-1', 'svc-1')).toBe(true);
  });

  // The bug: an unchecked `await q.refetch()` reseeds from vue-query's STALE
  // pre-save cache when the confirm read itself fails, presenting the OLD
  // policy as "applied" while OAP already holds the new one.
  it('does not reseed when the confirm read failed outright', () => {
    expect(shouldReseedAfterSave({ succeeded: false, reachable: undefined }, A, A, 'svc-1', 'svc-1')).toBe(false);
  });

  it('does not reseed when the confirm read answered but could not reach OAP', () => {
    expect(shouldReseedAfterSave({ succeeded: true, reachable: false }, A, A, 'svc-1', 'svc-1')).toBe(false);
  });

  // The second bug: nothing disables the form during a save, so an edit made
  // while the request is in flight must not be clobbered by reseeding with
  // the OLDER snapshot that request actually submitted.
  it('does not reseed when the draft changed since this request was submitted', () => {
    expect(shouldReseedAfterSave({ succeeded: true, reachable: true }, B, A, 'svc-1', 'svc-1')).toBe(false);
  });

  // The third bug: nothing disables the SERVICE PICKER either, so `draft` at
  // confirm time can belong to a DIFFERENT service than the one this save
  // targeted — reseeding it then would overwrite that other service's edits
  // with the wrong policy.
  it('does not reseed when the operator switched to a different service mid-save', () => {
    expect(shouldReseedAfterSave({ succeeded: true, reachable: true }, A, A, 'svc-2', 'svc-1')).toBe(false);
  });

  it('does not reseed when nothing is selected any more (picker cleared mid-save)', () => {
    expect(shouldReseedAfterSave({ succeeded: true, reachable: true }, A, A, null, 'svc-1')).toBe(false);
  });
});

describe('modeOf', () => {
  it('is none for an item with neither field', () => {
    expect(modeOf({})).toBe('none');
  });

  it('is list when uriList is non-empty', () => {
    expect(modeOf({ uriList: ['/api/*'] })).toBe('list');
  });

  it('is none for an empty uriList array (not list)', () => {
    expect(modeOf({ uriList: [] })).toBe('none');
  });

  it('is regex when uriRegex is set', () => {
    expect(modeOf({ uriRegex: '/api/.*' })).toBe('regex');
  });

  it('prefers list when a rule (written outside Horizon) carries both', () => {
    expect(modeOf({ uriList: ['/x'], uriRegex: '/y/.*' })).toBe('list');
  });
});

describe('shouldReseedUriMode', () => {
  it('reseeds on a genuinely different, non-empty incoming mode', () => {
    expect(shouldReseedUriMode('regex', 'list')).toBe(true);
  });

  it('does not reseed when incoming matches the current mode', () => {
    expect(shouldReseedUriMode('list', 'list')).toBe(false);
  });

  // The operator's OWN edit can legitimately clear a field down to "none" —
  // that must not be mistaken for an identity swap and fight the edit.
  it('does not reseed on incoming "none", even if current differs', () => {
    expect(shouldReseedUriMode('none', 'list')).toBe(false);
  });
});
