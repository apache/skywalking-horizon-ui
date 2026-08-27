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
 * What every graph screen needs from its query, and none of them can express
 * alone: a cache key that identifies the QUESTION rather than the clock, and a
 * snapshot that survives an answer not worth drawing.
 *
 * The four graph screens (service map, deployment, endpoint dependency,
 * instance relationship) each own their own fetch, layout and render. Only
 * these two decisions are shared, and they are shared because getting either
 * wrong empties the canvas in front of an operator mid-incident.
 */

import { computed, ref, watch } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { useTimeRangeStore } from '@/controls/timeRange';
import { useColdStageStore } from '@/controls/coldStage';
import { useAutoRefreshStore } from '@/controls/autoRefresh';

/** Anything the graph routes return. They all carry this flag; see `accepts`. */
export interface GraphResponse {
  reachable?: boolean;
  /** Why the route served nothing, when it is not a failure to reach OAP.
   *  `layer-disabled` is authoritative and clears the graph; anything else is
   *  transient and keeps it. */
  blocked?: 'store-unreachable' | 'layer-disabled';
}

/**
 * Is this response worth DRAWING?
 *
 * The BFF's graph builders never throw: an OAP failure comes back as HTTP 200
 * with `{ nodes: [], reachable: false }`. To a query library that is a resolved
 * success, so the cached graph is replaced by the empty one and the canvas goes
 * blank — with nothing pending to wait on and no error to retry.
 *
 * `reachable` is the only thing that separates "the graph is empty" from "we
 * could not read the graph", and the two must not be conflated: an empty graph
 * is a fact worth showing, a failed read is not. Everything else is accepted on
 * purpose — a `tooLarge` response is deliberately `reachable: true` with no
 * nodes, and `metricsPartial` is a perfectly good graph whose metric chunks
 * partly failed.
 */
export function accepts<T extends GraphResponse>(resp: T | null | undefined): boolean {
  return resp != null && resp.reachable !== false;
}

/**
 * A response that arrived but must not be drawn.
 *
 * Thrown from the query function rather than returned, and that is the whole
 * mechanism: a query library keeps the last SUCCESSFUL data when a fetch
 * fails, so throwing here makes the last good graph survive both a failed
 * round and a remount — it lives in the query cache, not in a ref that dies
 * with the component. Returning the empty body instead replaced the cached
 * graph with it, which is how a backend failure erased the picture.
 *
 * It carries the response so the banner can still say what happened.
 */
export class GraphUnavailableError extends Error {
  constructor(readonly response: GraphResponse) {
    // A sentence, not a code. This message is what the failure history shows
    // an operator, and "graph unavailable" beside a blank canvas says only
    // what they can already see.
    super('OAP could not be reached, so the graph was left as it was.');
    this.name = 'GraphUnavailableError';
  }
}

/**
 * Wrap a graph fetch so an unacceptable answer becomes a failure.
 *
 * Every graph route answers HTTP 200 even when OAP could not be reached, so
 * without this the "success" path receives `{nodes: [], reachable: false}` and
 * has no way to refuse it.
 */
export async function fetchDrawable<T extends GraphResponse>(
  fetch: () => Promise<T>,
  /** The window this request asked about, remembered WITH the response. */
  window?: { step: string; startMs: number; endMs: number },
): Promise<T> {
  const resp = await fetch();
  if (!accepts(resp)) throw new GraphUnavailableError(resp);
  if (window) windowByResponse.set(resp as object, { ...window });
  return resp;
}

/**
 * The window each response was fetched with, keyed by the response itself.
 *
 * A snapshot outlives the window that produced it — that is the whole point of
 * keeping the last good one — so anything merged INTO a snapshot has to ask
 * about the window that snapshot was read with, not whatever the clock says.
 * Deriving it from a ref could not work: on a remount the accepted snapshot
 * comes from the cache, possibly minutes old, while every ref has just been
 * initialised from the current window. Keyed by object identity, the two
 * cannot drift apart. A WeakMap, so a response that falls out of the cache
 * takes its entry with it.
 */
const windowByResponse = new WeakMap<object, { step: string; startMs: number; endMs: number }>();

/** The window a response was fetched with, or null if it was not recorded. */
export function windowOf(
  resp: unknown,
): { step: string; startMs: number; endMs: number } | null {
  if (!resp || typeof resp !== 'object') return null;
  return windowByResponse.get(resp as object) ?? null;
}

/**
 * What the screen is doing, as one value.
 *
 * Derived rather than stored, so a view cannot read half of it from a snapshot
 * and half from the attempt that failed:
 *
 * - `disabled`   — nothing is coming; the query is gated off.
 * - `loading`    — nothing to draw for THIS predicate yet.
 * - `failed`     — the first attempt for this predicate failed. Distinct from
 *                  `loading`, which it used to be indistinguishable from: an
 *                  empty drawable was read as "still waiting" and the canvas
 *                  showed "Reading data…" for ever.
 * - `refreshing` — a graph is on screen and a new round is out.
 * - `ready`      — a graph is on screen and nothing is in flight.
 */
export type GraphPhase = 'disabled' | 'loading' | 'failed' | 'refreshing' | 'ready';

export interface GraphState<T extends GraphResponse> {
  /**
   * The last response worth drawing FOR THE CURRENT PREDICATE.
   *
   * From the query cache, so it survives a failed round and a remount — but
   * gated on the predicate it belongs to, so a question the operator asked a
   * moment ago cannot answer the one they are asking now.
   */
  acceptedSnapshot: ComputedRef<T | null>;
  /** Whatever came back last, drawable or not. Drives the banners. */
  latestAttempt: ComputedRef<T | null>;
  phase: ComputedRef<GraphPhase>;
  /** Increments on every predicate change. A late response, an expansion, or
   *  anything else built on a snapshot can compare against this to know
   *  whether it still belongs to the question on screen. */
  predicateGeneration: ComputedRef<number>;
}

/**
 * Assemble the state a graph screen renders from.
 *
 * `replay` short-circuits everything: a captured block renders its payload and
 * fires no query, so its phase is `ready` from the first frame rather than the
 * permanent `pending` a disabled query reports.
 */
export function useGraphState<T extends GraphResponse>(opts: {
  data: Ref<T | undefined> | ComputedRef<T | undefined>;
  error: Ref<Error | null> | ComputedRef<Error | null>;
  isFetching: Ref<boolean> | ComputedRef<boolean>;
  /** When the cached data was last FETCHED. The gate below is built on it. */
  dataUpdatedAt: Ref<number> | ComputedRef<number>;
  /** Identity of the question. A change starts a new generation. */
  predicateKey: ComputedRef<string>;
  enabled: ComputedRef<boolean>;
  replay: ComputedRef<boolean>;
  replayData?: Ref<T | null>;
}): GraphState<T> {
  const generation = ref(0);
  /**
   * When the operator last CHANGED the question — zero until they do.
   *
   * Two rules pull in opposite directions here and both matter:
   *
   * - Switching to a service visited a minute ago must not draw that
   *   minute-old graph instantly under the new heading with no loading state,
   *   only to swap it when the real answer lands. So after a change, a cache
   *   entry older than the change is refused until it has been re-read.
   * - Re-MOUNTING the same question must keep showing its last good graph —
   *   that is the whole reason the snapshot lives in the query cache rather
   *   than in a ref that dies with the component.
   *
   * Zero is what separates them. A component that has not yet seen the
   * question change accepts whatever the cache holds for it, because that IS
   * its last good answer; only a change during its life sets a floor.
   */
  const askedAt = ref(0);
  watch(
    opts.predicateKey,
    () => {
      generation.value += 1;
      askedAt.value = Date.now();
    },
    // SYNC: the render that follows a predicate change must already see the
    // canvas cleared, not clear it a tick later.
    { flush: 'sync' },
  );

  const failedResponse = computed<T | null>(() => {
    const e = opts.error.value;
    return e instanceof GraphUnavailableError ? (e.response as T) : null;
  });
  /**
   * An administrator's decision, not a transient failure.
   *
   * A store that could not be read is a fact about right now, so the previous
   * graph is still the best thing on screen. A DISABLED layer is authoritative:
   * continuing to draw its map states that the layer is live when the operator
   * in charge has said it is not.
   */
  const layerDisabled = computed(() => failedResponse.value?.blocked === 'layer-disabled');

  const acceptedSnapshot = computed<T | null>(() => {
    if (opts.replay.value) return opts.replayData?.value ?? null;
    if (layerDisabled.value) return null;
    const data = opts.data.value;
    if (data === undefined) return null;
    // Fetched before this predicate was asked ⇒ it answers the previous one.
    return opts.dataUpdatedAt.value >= askedAt.value ? data : null;
  });
  const latestAttempt = computed<T | null>(() => failedResponse.value ?? acceptedSnapshot.value);
  const phase = computed<GraphPhase>(() => {
    if (opts.replay.value) return 'ready';
    if (!opts.enabled.value) return 'disabled';
    if (acceptedSnapshot.value === null) return opts.error.value ? 'failed' : 'loading';
    return opts.isFetching.value ? 'refreshing' : 'ready';
  });
  return {
    acceptedSnapshot,
    latestAttempt,
    phase,
    predicateGeneration: computed(() => generation.value),
  };
}

/**
 * One SERVICE as a predicate names it. Normalized so two spellings of the same
 * selection cannot produce two keys.
 */
export interface PredicateService {
  id: string;
  name: string;
  normal: boolean | null;
}

/**
 * WHAT is being asked — every input that changes the answer, and nothing that
 * merely changes when it is asked.
 *
 * One object, so the query key, the reset watcher and the request parameters
 * are all derived from the same value rather than assembled separately. They
 * were assembled separately once, and the focus list went into the key through
 * `Array.join`, which stringifies an object to `[object Object]` — so every
 * multi-service selection produced an IDENTICAL key and switching services
 * cleared no placements, refit nothing, and left the previous graph drawn
 * under the new heading.
 */
export interface GraphPredicate {
  layer: string;
  /** Order-insensitive: a selection is a SET, so it is sorted before keying. */
  focus?: readonly PredicateService[];
  service?: PredicateService | null;
  endpoint?: string | null;
  clientServiceId?: string | null;
  serverServiceId?: string | null;
  depth?: number | null;
  /** From `useTimeIdentity` — a preset, a custom window, or a frozen one. */
  time: string;
  /** The unpublished draft this view renders, if any. */
  preview?: unknown;
  /**
   * Cold stage REPLACES the hot read rather than widening it, so it is part of
   * the question, not a header that rides along. A Cold tab showing Hot data
   * because the key did not move is the failure this prevents.
   */
  cold: boolean;
}

/** A `ServiceRef`-shaped value reduced to what identifies it. */
export function predicateService(
  s: { id: string; name: string; normal?: boolean | null } | null | undefined,
): PredicateService | null {
  if (!s) return null;
  return { id: s.id, name: s.name, normal: s.normal ?? null };
}

/**
 * The predicate as one comparable string.
 *
 * Written by hand rather than `JSON.stringify(predicate)`, because that is
 * key-order sensitive: two objects describing the same question serialise
 * differently depending on how they were built, and the watcher then fires on
 * a change that did not happen.
 */
export function predicateKey(p: GraphPredicate): string {
  const svc = (s: PredicateService | null | undefined): string =>
    s ? `${s.id}~${s.name}~${s.normal === null ? '' : String(s.normal)}` : '';
  const focus = [...(p.focus ?? [])]
    .map(svc)
    .sort()
    .join('+');
  return [
    `l=${p.layer}`,
    `f=${focus}`,
    `s=${svc(p.service)}`,
    `e=${p.endpoint ?? ''}`,
    `c=${p.clientServiceId ?? ''}`,
    `S=${p.serverServiceId ?? ''}`,
    `d=${p.depth ?? ''}`,
    `t=${p.time}`,
    `p=${p.preview === undefined || p.preview === null ? '' : JSON.stringify(p.preview)}`,
    `k=${p.cold ? '1' : '0'}`,
  ].join('|');
}

/**
 * The time part of a query key — an IDENTITY, not an instant.
 *
 * A rolling window's bounds move on every tick. Putting them in the key makes
 * every tick a cache miss, which is what empties these canvases; putting the
 * PRESET in instead keys the question ("the last hour") rather than the answer
 * ("10:04:03 to 11:04:03"). The bounds still travel as the request argument,
 * re-read at the moment the request is made.
 *
 * Three forms, and collapsing them is a bug in each direction:
 *
 * - **rolling** — the preset id plus the step. The bounds are derived and move.
 * - **custom** — the explicit bounds ARE the predicate here, and they do not
 *   move, so they belong in the key. Keying a custom range by "custom" alone
 *   would serve one custom window's answer for another's question.
 * - **owned** — an embedded block froze its own window at mount. Its bounds go
 *   in the key so two captured blocks on one page cannot share a cache entry.
 */
export function useTimeIdentity(
  ownsWindow?: ComputedRef<boolean>,
  /** Required only when `ownsWindow` can be true. A screen that always reads
   *  the topbar's window — an overview, a layer dashboard — passes neither. */
  ownWindow?: ComputedRef<{ startMs: number; endMs: number; step: string }>,
): ComputedRef<string> {
  const timeRange = useTimeRangeStore();
  const cold = useColdStageStore();
  // The STAGE is part of the question, not a header that rides along with it.
  // Cold replaces the hot read rather than widening it, so an answer from one
  // stage is not an answer to the other's question — and a key that ignored it
  // let a Cold tab keep showing Hot data until something else moved the key.
  const stage = computed(() => (cold.enabled ? ':cold' : ''));
  return computed(() => {
    if (ownsWindow?.value && ownWindow) {
      const w = ownWindow.value;
      return `own:${w.step}:${w.startMs}:${w.endMs}${stage.value}`;
    }
    if (timeRange.presetId === 'custom') {
      return `custom:${timeRange.step}:${timeRange.customStartMs}:${timeRange.customEndMs}${stage.value}`;
    }
    return `preset:${timeRange.presetId}:${timeRange.step}${stage.value}`;
  });
}

/**
 * The window a request should ask about, right now.
 *
 * While a round is out this is the ROUND's window, frozen when the round
 * started. Outside a round it is the topbar's own. Reading the store directly
 * was correct only by accident: it happened to hold the round's values because
 * the round re-anchors once and nothing else moves it mid-round — a property
 * of today's code rather than a guarantee, and one that a picker, a preset
 * change or a second re-anchor would quietly break. A round is supposed to be
 * ONE question asked of every screen; taking the window from the round itself
 * is what makes that structural.
 */
export function useRoundWindow(): ComputedRef<{
  step: 'MINUTE' | 'HOUR' | 'DAY';
  startMs: number;
  endMs: number;
}> {
  const timeRange = useTimeRangeStore();
  const auto = useAutoRefreshStore();
  return computed(() => {
    const live = {
      step: timeRange.step,
      startMs: timeRange.range.startMs,
      endMs: timeRange.range.endMs,
    };
    const round = auto.currentRound;
    if (!round) return live;
    // The round's window, but ONLY while it still describes what is being
    // asked about. An operator can change the range mid-round — the picker
    // stays live — and the cache key follows them immediately. Handing the
    // request the round's older window then files an answer about W1 under the
    // key that says W2, which nothing downstream can detect and no later read
    // corrects. When the two disagree the operator's is the real question; the
    // round that follows re-establishes one window for everybody.
    if (round.step !== live.step || round.startMs !== live.startMs || round.endMs !== live.endMs) {
      return live;
    }
    return {
      step: round.step as 'MINUTE' | 'HOUR' | 'DAY',
      startMs: round.startMs,
      endMs: round.endMs,
    };
  });
}

/**
 * Anchor a rolling window to NOW, before the query that will read it is built.
 *
 * MUST be called ahead of `useQuery`. The query fetches on mount, reading the
 * window as it stands at that moment; with auto-refresh off nothing had moved
 * the anchor since the page was opened, so a remount ten minutes later
 * re-requested the ten-minute-old window and drew it as current. Anchoring
 * afterwards does not help — by then the request is already built.
 *
 * A frozen window (an embedded capture) and a custom absolute range are the
 * operator's own and never move. During a round the round has already
 * anchored, once, for everybody.
 */
export function anchorForMount(ownsWindow: ComputedRef<boolean>): void {
  const timeRange = useTimeRangeStore();
  const auto = useAutoRefreshStore();
  if (!ownsWindow.value && timeRange.presetId !== 'custom' && !auto.roundRunning) {
    timeRange.reanchor();
  }
}

/**
 * Re-anchor a rolling window, then refetch — in that order.
 *
 * Once the key stops carrying the bounds, `refetch()` alone re-requests the
 * window the query already holds: rolling bounds advance only when the store
 * re-anchors, and nothing in the refetch path does that. So a manual refresh
 * would return the same answer and look broken.
 *
 * A rolling window is anchored at the moment the request is TRIGGERED. "Last
 * hour" means the hour ending when you asked, never the hour ending when the
 * cache entry happened to be created.
 *
 * NOT inside a round, though. A round anchors ONCE, before it calls anybody,
 * and every screen in it must ask about that same window — re-anchoring here
 * as well would move the window between one subscriber and the next, so a
 * topology and the dashboard beside it would answer about windows a few
 * milliseconds apart and quietly disagree at their edges.
 */
export function useTriggeredRefetch(
  refetch: () => Promise<unknown>,
  ownsWindow: ComputedRef<boolean>,
): () => Promise<unknown> {
  const timeRange = useTimeRangeStore();
  const auto = useAutoRefreshStore();
  return async () => {
    // An owned window is frozen by definition, and a custom range's bounds are
    // the operator's own — neither re-anchors.
    const mine = !auto.roundRunning;
    if (mine && !ownsWindow.value && timeRange.presetId !== 'custom') timeRange.reanchor();
    return refetch();
  };
}

