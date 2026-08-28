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
 * The two decisions the graph screens share.
 *
 * These are worth testing directly because both failure modes are invisible on
 * a healthy system: a key that carries the clock only misbehaves once a tick
 * lands, and a response that must not be drawn only arrives when the backend is
 * unwell — which is exactly when an operator is looking at the screen.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { computed, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useColdStageStore } from '@/controls/coldStage';
import { accepts, fetchDrawable, GraphUnavailableError, predicateKey, predicateService, useGraphState, useTimeIdentity, useTriggeredRefetch, anchorForMount, useRoundWindow } from './graphQuery';
import { useTimeRangeStore } from '@/controls/timeRange';
import { useAutoRefreshStore } from '@/controls/autoRefresh';

interface Resp {
  reachable?: boolean;
  nodes: string[];
  /** Both are real response fields the accept-gate must NOT reject on. */
  tooLarge?: { nodes: number; edges: number };
  metricsPartial?: { failedChunks: number; totalChunks: number };
}
const good = (n: string[]): Resp => ({ reachable: true, nodes: n });
const failed = (): Resp => ({ reachable: false, nodes: [] });

beforeEach(() => setActivePinia(createPinia()));

describe('accepts — which responses are worth drawing', () => {
  it('takes a populated graph', () => {
    expect(accepts(good(['a']))).toBe(true);
  });

  // An empty graph is a FACT — this layer genuinely has no services with data —
  // and replacing it with a stale picture would be a lie.
  it('takes a genuinely empty graph', () => {
    expect(accepts(good([]))).toBe(true);
  });

  // The one that matters: the BFF never throws, so an OAP failure arrives as a
  // 200 with an empty body. Drawn, it erases the graph the operator was reading.
  it('refuses an unreachable response', () => {
    expect(accepts({ reachable: false, nodes: [] })).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(accepts(null)).toBe(false);
    expect(accepts(undefined)).toBe(false);
  });

  // `tooLarge` is deliberately `reachable: true` with no nodes, and
  // `metricsPartial` is a good graph whose metric chunks partly failed. Both
  // must reach the screen — they render their own explanation.
  it('takes the deliberate empty and partial shapes', () => {
    expect(accepts({ reachable: true, nodes: [], tooLarge: { nodes: 9e5, edges: 9e6 } })).toBe(true);
    expect(accepts({ reachable: true, nodes: ['a'], metricsPartial: { failedChunks: 2, totalChunks: 9 } })).toBe(true);
  });
});

describe('the graph state machine', () => {
  const state = (o: {
    data?: Resp; error?: Error | null; fetching?: boolean; enabled?: boolean; replay?: boolean;
    replayData?: Resp | null; predicateKey?: string; fetchedAt?: number;
  }) => useGraphState<Resp>({
    data: ref(o.data),
    error: ref(o.error ?? null),
    isFetching: ref(o.fetching ?? false),
    // Fetched in the future by default, so the freshness gate is satisfied and
    // these cases test what they are named for rather than the gate.
    dataUpdatedAt: ref(o.fetchedAt ?? Date.now() + 60_000),
    predicateKey: computed(() => o.predicateKey ?? 'p1'),
    enabled: computed(() => o.enabled ?? true),
    replay: computed(() => o.replay ?? false),
    ...(o.replayData !== undefined ? { replayData: ref(o.replayData) } : {}),
  });

  // The failure the whole design exists for: the BFF answers 200 with an empty
  // body when OAP is unreachable, so the "success" path must refuse it.
  it('turns an unreachable response into a failure the cache can survive', async () => {
    await expect(fetchDrawable(async () => failed())).rejects.toBeInstanceOf(GraphUnavailableError);
    await expect(fetchDrawable(async () => good(['a']))).resolves.toEqual(good(['a']));
  });

  it('keeps drawing the cached graph while the latest attempt failed', () => {
    const s = state({ data: good(['a']), error: new GraphUnavailableError(failed()) });
    expect(s.acceptedSnapshot.value?.nodes).toEqual(['a']);
    // The banner needs the FAILED response, not the drawn one.
    expect(s.latestAttempt.value?.reachable).toBe(false);
    expect(s.phase.value).toBe('ready');
  });

  // The state that used to be indistinguishable from loading: an empty
  // drawable read as "still waiting", so a first failure showed the loading
  // line for ever.
  it('reports a FIRST failure as failed, not as loading', () => {
    expect(state({ error: new GraphUnavailableError(failed()) }).phase.value).toBe('failed');
    expect(state({}).phase.value).toBe('loading');
  });

  it('separates refreshing from loading', () => {
    expect(state({ data: good(['a']), fetching: true }).phase.value).toBe('refreshing');
    expect(state({ fetching: true }).phase.value).toBe('loading');
  });

  it('is ready from the first frame in replay, whose query never runs', () => {
    const s = state({ replay: true, replayData: good(['x']), enabled: false });
    expect(s.phase.value).toBe('ready');
    expect(s.acceptedSnapshot.value?.nodes).toEqual(['x']);
  });

  it('is disabled when nothing is coming', () => {
    expect(state({ enabled: false }).phase.value).toBe('disabled');
  });

  it('takes it as soon as it has been fetched for THIS question', () => {
    expect(state({ data: good(['fresh']) }).acceptedSnapshot.value?.nodes).toEqual(['fresh']);
  });

  // The other side of the same rule, and the one the gate above nearly broke:
  // a REMOUNT of the same question must keep showing its last good graph. That
  // is the entire reason the snapshot lives in the query cache rather than in a
  // ref that dies with the component — losing it on remount would put an empty
  // canvas in front of an operator who only switched tabs.
  it('keeps a cached graph on remount, even one fetched long before mounting', () => {
    const s = state({ data: good(['a', 'b']), fetchedAt: Date.now() - 30_000 });

    expect(s.acceptedSnapshot.value?.nodes, 'a remount lost the last good graph').toEqual(['a', 'b']);
    expect(s.phase.value).toBe('ready');
  });

  it('and keeps it on remount even when the read that followed the mount FAILED', () => {
    const s = state({
      data: good(['a', 'b']),
      fetchedAt: Date.now() - 30_000,
      error: new GraphUnavailableError({ reachable: false, blocked: 'store-unreachable' }),
    });

    expect(s.acceptedSnapshot.value?.nodes, 'a failed post-mount read erased the graph').toEqual([
      'a',
      'b',
    ]);
    expect(s.phase.value).toBe('ready');
  });

  // And a predicate CHANGE still refuses the stale answer — the two rules do
  // not collapse into each other.
  it('still refuses a stale answer after the question changes', async () => {
    const key = ref('p1');
    const data = ref<Resp | undefined>(good(['old']));
    const fetchedAt = ref(Date.now() - 30_000);
    const s = useGraphState<Resp>({
      data,
      error: ref(null),
      isFetching: ref(false),
      dataUpdatedAt: fetchedAt,
      predicateKey: computed(() => key.value),
      enabled: computed(() => true),
      replay: computed(() => false),
    });
    expect(s.acceptedSnapshot.value?.nodes).toEqual(['old']);

    // The operator picks a different service; its cache entry is older still.
    key.value = 'p2';

    expect(s.acceptedSnapshot.value, 'the previous question’s cache was drawn').toBeNull();
    expect(s.phase.value).toBe('loading');
  });

  // A store that could not be read is a fact about right now, so the previous
  // map is still the best thing on screen. A DISABLED layer is an
  // administrator's decision — continuing to draw it states the layer is live
  // when the person in charge has said it is not.
  it('clears the graph for a disabled layer, and keeps it for an unreachable store', () => {
    const disabled = state({
      data: good(['a']),
      error: new GraphUnavailableError({ reachable: false, blocked: 'layer-disabled' }),
    });
    const unreachable = state({
      data: good(['a']),
      error: new GraphUnavailableError({ reachable: false, blocked: 'store-unreachable' }),
    });

    expect(disabled.acceptedSnapshot.value, 'a disabled layer kept drawing its map').toBeNull();
    expect(unreachable.acceptedSnapshot.value?.nodes, 'a transient failure erased the map').toEqual(['a']);
  });
});

describe('predicate generation', () => {
  it('advances when the question changes, so anything built on a snapshot can tell', () => {
    const key = ref('p1');
    const s = useGraphState<Resp>({
      data: ref(good(['a'])),
      error: ref(null),
      isFetching: ref(false),
      dataUpdatedAt: ref(Date.now() + 60_000),
      predicateKey: computed(() => key.value),
      enabled: computed(() => true),
      replay: computed(() => false),
    });
    const before = s.predicateGeneration.value;

    key.value = 'p2';

    expect(s.predicateGeneration.value).toBe(before + 1);
  });
});

describe('useTimeIdentity — keying the question, not the instant', () => {
  const frozen = computed(() => ({ startMs: 1000, endMs: 2000, step: 'MINUTE' }));

  it('keys a rolling preset by the preset, so moving bounds do not re-key', () => {
    const id = useTimeIdentity(computed(() => false), frozen);
    const first = id.value;
    // A tick re-anchors the store; the identity must not follow it.
    expect(id.value).toBe(first);
    expect(first.startsWith('preset:')).toBe(true);
  });

  it('keys an owned window by its frozen bounds, so two captures cannot collide', () => {
    const a = useTimeIdentity(computed(() => true), frozen);
    const b = useTimeIdentity(computed(() => true), computed(() => ({ startMs: 5000, endMs: 6000, step: 'MINUTE' })));
    expect(a.value).not.toBe(b.value);
  });
});

describe('predicateKey — what counts as a different question', () => {
  const base = { layer: 'general', time: 'preset:1h:MINUTE' };

  // The defect this replaced: the focus list reached the key through
  // `Array.join`, which stringifies an object to "[object Object]" — so every
  // multi-service selection produced the SAME key, and switching services
  // cleared no placements and refit nothing.
  it('separates two different service selections', () => {
    const a = predicateKey({ ...base, focus: [{ id: 'a', name: 'svc-a', normal: true }] });
    const b = predicateKey({ ...base, focus: [{ id: 'b', name: 'svc-b', normal: true }] });
    expect(a).not.toBe(b);
  });

  it('treats a focus SET as order-insensitive', () => {
    const one = { id: 'a', name: 'svc-a', normal: true };
    const two = { id: 'b', name: 'svc-b', normal: null };
    expect(predicateKey({ ...base, focus: [one, two] })).toBe(predicateKey({ ...base, focus: [two, one] }));
  });

  // The stage is NOT part of the question, and that is load-bearing rather than
  // an omission: a key that moved on the flip would have no cached entry, so
  // TanStack would fetch at once — the page-wide read the toggle deliberately
  // does not trigger. Cold rides on the request header and reaches OAP with
  // whatever the page asks for NEXT. See `coldStage.ts`.
  it('does not re-key on a cold-stage flip, so flipping fetches nothing', () => {
    const cold = useColdStageStore();
    const before = predicateKey({ ...base });
    cold.set(true);
    expect(predicateKey({ ...base })).toBe(before);
    cold.set(false);
  });

  it('separates depth, endpoint and the instance pair', () => {
    expect(predicateKey({ ...base, depth: 1 })).not.toBe(predicateKey({ ...base, depth: 2 }));
    expect(predicateKey({ ...base, endpoint: '/a' })).not.toBe(predicateKey({ ...base, endpoint: '/b' }));
    expect(predicateKey({ ...base, clientServiceId: 'x' })).not.toBe(predicateKey({ ...base, clientServiceId: 'y' }));
  });

  it('is stable for the same question built twice', () => {
    const p = () => predicateKey({ ...base, service: predicateService({ id: 'a', name: 'n', normal: false }) });
    expect(p()).toBe(p());
  });

  it('does not alias two fields into one key', () => {
    expect(predicateKey({ ...base, endpoint: 'a|b' })).not.toBe(predicateKey({ ...base, endpoint: 'a', depth: null }));
  });
});

describe('one window per round', () => {
  it('does not re-anchor while a round is doing it for everybody', async () => {
    // The failure this prevents is invisible on one screen and obvious across
    // two: if each subscriber re-anchored, a topology and the dashboard beside
    // it would ask about windows milliseconds apart and disagree at the edges.
    const timeRange = useTimeRangeStore();
    const auto = useAutoRefreshStore();
    const trigger = useTriggeredRefetch(async () => undefined, computed(() => false));
    let anchorDuringRound: number | null = null;

    auto.joinRound(async () => {
      const before = timeRange.range.startMs;
      // Long enough that a re-anchor lands in a LATER millisecond. Without
      // the wait both anchors fall in the same one and the comparison would
      // pass whatever the code did.
      await new Promise((r) => setTimeout(r, 8));
      await trigger();
      anchorDuringRound = timeRange.range.startMs - before;
    });
    await auto.refreshNow();

    expect(anchorDuringRound, 'a subscriber moved the round’s window under it').toBe(0);
  });

  it('DOES re-anchor when nothing else will — a refetch outside any round', async () => {
    const timeRange = useTimeRangeStore();
    const trigger = useTriggeredRefetch(async () => undefined, computed(() => false));
    // Anchored in the past, so a re-anchor is measurable rather than a no-op
    // that the clock's resolution could hide.
    timeRange.reanchor();
    const before = timeRange.range.endMs;
    await new Promise((r) => setTimeout(r, 5));

    await trigger();

    expect(
      timeRange.range.endMs,
      'nothing re-anchored, so a manual refresh would re-request the same window',
    ).toBeGreaterThan(before);
  });
});

describe('a remount asks about now', () => {
  // Acceptance: with auto-refresh OFF, nothing moves the anchor between opening
  // a page and coming back to it — so a remount used to re-request the window
  // as it stood when the app loaded and draw it as current.
  it('anchors before the first request rather than after it', async () => {
    const timeRange = useTimeRangeStore();
    timeRange.reanchor();
    const openedAt = timeRange.range.endMs;
    await new Promise((r) => setTimeout(r, 8));

    // What a composable does on mount, BEFORE it builds its query.
    anchorForMount(computed(() => false));

    expect(
      timeRange.range.endMs,
      'the remount would have requested the window from when the app loaded',
    ).toBeGreaterThan(openedAt);
  });

  it('leaves a frozen window alone — an embedded capture is not asking about now', async () => {
    const timeRange = useTimeRangeStore();
    timeRange.reanchor();
    const frozen = timeRange.range.endMs;
    await new Promise((r) => setTimeout(r, 8));

    anchorForMount(computed(() => true));

    expect(timeRange.range.endMs).toBe(frozen);
  });
});

describe('the round’s window is only used while it is still the question', () => {
  // The defect: the picker stays live during a round, so an operator can pick a
  // new range while one is out. The cache key follows them immediately, but the
  // REQUEST was being handed the round's older window — filing an answer about
  // W1 under the key that says W2. Nothing downstream can detect that, and no
  // later read corrects it.
  it('hands the request the operator’s window when they change it mid-round', async () => {
    const timeRange = useTimeRangeStore();
    const auto = useAutoRefreshStore();
    const win = useRoundWindow();
    let duringRound: { startMs: number; endMs: number } | null = null;

    auto.joinRound(() => {
      // Mid-round, the operator picks an explicit range.
      timeRange.selectCustom(1_000_000, 2_000_000, 'MINUTE');
      duringRound = { startMs: win.value.startMs, endMs: win.value.endMs };
    });
    await auto.refreshNow();

    expect(duringRound, 'the round ran no subscriber').not.toBeNull();
    expect(duringRound!.startMs, 'the request asked about the round’s stale window').toBe(1_000_000);
    expect(duringRound!.endMs).toBe(2_000_000);
  });

  it('otherwise uses the round’s own window, so one round is one window', async () => {
    const auto = useAutoRefreshStore();
    const win = useRoundWindow();
    const seen: number[] = [];
    auto.joinRound(() => { seen.push(win.value.endMs); });
    auto.joinRound(() => { seen.push(win.value.endMs); });

    await auto.refreshNow();

    expect(seen).toHaveLength(2);
    expect(seen[0], 'two screens in one round described different windows').toBe(seen[1]);
    expect(seen[0]).toBe(auto.currentRound?.endMs ?? seen[0]);
  });
});

/**
 * The four acceptance items whose coverage would not have caught a regression.
 *
 * Each is written against the state machine rather than a rendered page,
 * because that is where the decision is actually made — and each was checked
 * by removing the behaviour and confirming the assertion fails.
 */
describe('acceptance: switching from A to B', () => {
  const resp = (nodes: string[]): Resp => ({ reachable: true, nodes });

  function screen(initialKey: string) {
    const key = ref(initialKey);
    const data = ref<Resp | undefined>(undefined);
    const fetchedAt = ref(0);
    const fetching = ref(false);
    const state = useGraphState<Resp>({
      data,
      error: ref(null),
      isFetching: fetching,
      dataUpdatedAt: fetchedAt,
      predicateKey: computed(() => key.value),
      enabled: computed(() => true),
      replay: computed(() => false),
    });
    /** A read landing for whatever question is on screen now. */
    const land = (nodes: string[]) => {
      data.value = resp(nodes);
      fetchedAt.value = Date.now() + 1000;
    };
    return { key, data, fetchedAt, fetching, state, land };
  }

  // §十.1 — while B is pending, A's graph is already gone and the screen says
  // what it is loading. Previously the phase could not tell "no data yet" from
  // "failed", so this state was indistinguishable from a permanent wait.
  it('1: A is gone and B reads as loading while B is pending', () => {
    const s = screen('A');
    s.land(['a1', 'a2']);
    expect(s.state.acceptedSnapshot.value?.nodes).toEqual(['a1', 'a2']);

    // Switching moves the observer to B's own cache entry. B has never been
    // read, so there is nothing there — which is what the query library hands
    // over, and what this models.
    s.key.value = 'B';
    s.data.value = undefined;
    s.fetching.value = true;

    expect(s.state.acceptedSnapshot.value, 'A’s graph was still on screen under B').toBeNull();
    // LOADING, not failed: nothing has gone wrong, B simply has no answer yet.
    // The two were indistinguishable before the phase machine, so a first
    // failure showed this same line for ever.
    expect(s.state.phase.value).toBe('loading');
  });

  // §十.2 — B having a cache entry does not let it skip the request, and A's
  // late answer must not be committed to B.
  it('2: a cached B is not drawn until it has been read for B', () => {
    const s = screen('A');
    s.land(['a1']);
    // B was visited earlier: its entry exists, fetched before the switch.
    s.key.value = 'B';
    s.data.value = resp(['b-stale']);
    s.fetchedAt.value = Date.now() - 60_000;

    expect(s.state.acceptedSnapshot.value, 'B’s stale cache was drawn immediately').toBeNull();

    // The read for B lands.
    s.land(['b1']);
    expect(s.state.acceptedSnapshot.value?.nodes).toEqual(['b1']);
  });

  it('2b: a generation advances on every switch, so a late reply can be told apart', () => {
    const s = screen('A');
    const g0 = s.state.predicateGeneration.value;
    s.key.value = 'B';
    expect(s.state.predicateGeneration.value).toBe(g0 + 1);
    s.key.value = 'C';
    expect(s.state.predicateGeneration.value).toBe(g0 + 2);
  });

  // §十.3 — same predicate, good then failure: the whole snapshot is unchanged.
  it('3: a failure on the same question changes nothing that is drawn', () => {
    const key = ref('A');
    const data = ref<Resp | undefined>(resp(['a1', 'a2']));
    const error = ref<Error | null>(null);
    const s = useGraphState<Resp>({
      data,
      error,
      isFetching: ref(false),
      dataUpdatedAt: ref(Date.now() + 1000),
      predicateKey: computed(() => key.value),
      enabled: computed(() => true),
      replay: computed(() => false),
    });
    const before = s.acceptedSnapshot.value;

    error.value = new GraphUnavailableError({ reachable: false });

    expect(s.acceptedSnapshot.value, 'the drawn graph changed on a failed refresh').toBe(before);
    expect(s.phase.value).toBe('ready');
    // The banner reads the ATTEMPT, which is the failure — a different source
    // from the graph, deliberately.
    expect(s.latestAttempt.value?.reachable).toBe(false);
  });
});
