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
 * Imperative per-node expansion-fetch engine for the API-dependency graph,
 * plus the merged graph it produces. `getEndpointDependencies` returns a
 * node's WHOLE neighbourhood (both directions in ONE response — OAP has no
 * directional endpoint query), so there is ONE expand per node, not a
 * left/right pair. New callers land left, callees right via the BFS layout.
 *
 * The composable owns the expansion-fetch lifecycle: it keyes a per-node
 * response cache, tracks in-flight + exhausted nodes, flashes an explicit
 * "nothing more" banner when an expand surfaces no new neighbour, and tears
 * the banner timer down on unmount. The merged `nodes` / `calls` it exposes
 * are the base focus response ∪ every expansion response, deduplicated.
 *
 * A new focus endpoint discards the whole expansion graph; the view clears
 * its own per-graph view-state (drag offsets, selection) through the
 * `onFocusReset` callback.
 */

import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type {
  EndpointDependencyCall,
  EndpointDependencyNode,
  EndpointDependencyResponse,
} from '@/api/client';
import { bffClient } from '@/api/client';
import { accepts, GraphUnavailableError } from '@/layer/graphQuery';
import { reportActionFailure } from '@/controls/errorCenter';
import { serviceRef } from '@/utils/serviceRef';

interface ExpansionOptions {
  layerKey: Ref<string>;
  baseNodes: Ref<EndpointDependencyNode[]>;
  baseCalls: Ref<EndpointDependencyCall[]>;
  selectedEndpoint: Ref<string | null>;
  /**
   * The question the BASE graph is answering.
   *
   * An expansion is drawn on top of a base, so it is only meaningful for the
   * base it was fetched against. When the question changes — a different
   * endpoint, window, preview or stage — the expansions are answers to a
   * question nobody is asking any more.
   */
  predicateGeneration: Ref<number>;
  /** The unpublished draft the BASE graph renders against, in admin preview.
   *  An expansion must be resolved against the same one. */
  previewConfig: Ref<string | undefined> | { value: string | undefined };
  /** The window the base graph on screen was read with. */
  baseWindow: Ref<{ step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number }> | {
    value: { step: 'MINUTE' | 'HOUR' | 'DAY'; startMs: number; endMs: number };
  };
  /**
   * Which base snapshot is on screen, as a version that advances whenever a
   * new one is committed.
   *
   * A base REFRESH is not a new question, but it is a new answer: the
   * expansions hanging off the previous one describe nodes that may no longer
   * be there, so they are dropped as the new base commits rather than merged
   * into it. A refresh that FAILED commits nothing, and the expansions stay.
   */
  baseSnapshotVersion: Ref<number>;
  /** Cascade-clear the view's per-graph state when the focus endpoint changes. */
  onFocusReset: () => void;
}

/** True when the call carries at least one resolved metric value. */
function callHasMetrics(c: EndpointDependencyCall): boolean {
  for (const v of Object.values(c.metrics ?? {})) if (v !== null) return true;
  return false;
}

export function useEndpointDependencyExpansion(opts: ExpansionOptions) {
  const {
    layerKey,
    baseNodes,
    baseCalls,
    selectedEndpoint,
    predicateGeneration,
    previewConfig,
    baseWindow,
    baseSnapshotVersion,
    onFocusReset,
  } = opts;

  // Keyed by node id so a repeat click is a no-op; a click that surfaces
  // nothing new marks the node exhausted, fading the handle.
  const expansions = ref<Map<string, EndpointDependencyResponse>>(new Map());
  const expansionsLoading = ref<Set<string>>(new Set());
  const exhausted = ref<Set<string>>(new Set());
  /**
   * Which focus the state below belongs to.
   *
   * Plain, not a ref: nothing renders it, and it must be read at exactly the
   * moment a request is made and compared at exactly the moment it returns —
   * reactivity would only invite a stale read.
   */
  let epoch = 0;
  /** The expansion now out, so leaving the screen can stop it. */
  let inFlight: AbortController | null = null;
  /**
   * The last expansion that could not be read.
   *
   * A signal rather than a message: the view owns how it is shown, and the
   * timestamp makes a repeat failure on the same endpoint a NEW event rather
   * than a no-op the view would ignore.
   */
  const expansionFailed = ref<{ at: number; endpoint: string } | null>(null);
  function hasExpansion(node: EndpointDependencyNode): boolean {
    return expansions.value.has(node.id);
  }
  function isExhausted(node: EndpointDependencyNode): boolean {
    return exhausted.value.has(node.id);
  }
  function isLoadingExpansion(node: EndpointDependencyNode): boolean {
    return expansionsLoading.value.has(node.id);
  }
  // Transient banner when an expand returns no NEW neighbour, so a leaf-node
  // expand gives explicit feedback ("loaded, but nothing more") instead of
  // the easily-missed handle fade. Auto-clears after a few seconds.
  const noDepFlash = ref<string | null>(null);
  let noDepFlashTimer: ReturnType<typeof setTimeout> | null = null;
  function flashNoDep(name: string): void {
    noDepFlash.value = name;
    if (noDepFlashTimer) clearTimeout(noDepFlashTimer);
    noDepFlashTimer = setTimeout(() => {
      noDepFlash.value = null;
      noDepFlashTimer = null;
    }, 3200);
  }
  async function expandNode(node: EndpointDependencyNode): Promise<void> {
    const key = node.id;
    if (expansions.value.has(key) || expansionsLoading.value.has(key)) return;
    // The graph node carries its owning service whole — id, name, and (as
    // `isReal`) the normal flag OAP tagged it with, which is what the builder
    // scopes the expanded node's own endpoint MQE by.
    const owner = serviceRef(node.serviceId, node.serviceName, node.isReal);
    if (!owner) return;
    const loading = new Set(expansionsLoading.value);
    loading.add(key);
    expansionsLoading.value = loading;
    // The focus this request belongs to. An endpoint-dependency build is an
    // MQE fan-out on the BFF, so the wait is seconds — long enough to pick a
    // different endpoint in the meantime. Without this, that reply lands
    // AFTER the focus watcher has cleared, and repopulates the new graph with
    // the old focus's branches.
    const mine = epoch;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const before = new Set(nodes.value.map((n) => n.id));
      const resp = await bffClient.layer.endpointDependency(
        layerKey.value,
        owner,
        node.name,
        // The window the BASE on screen was read with, not whatever the clock
        // says now. An expansion is merged INTO that base, so asking about a
        // different window would put two windows' answers in one graph — and
        // the base can legitimately be older than the clock, since a failed
        // round leaves the previous one in place.
        { step: baseWindow.value.step, startMs: baseWindow.value.startMs, endMs: baseWindow.value.endMs },
        // The draft the base graph is being rendered against. Omitting it made
        // an expansion resolve against the PUBLISHED template while the rest of
        // the graph showed the operator's unpublished edit — one picture built
        // from two different configurations, with nothing on screen to say so.
        previewConfig.value,
        controller.signal,
      );
      if (mine !== epoch) return;
      // A response that could not be read is NOT an answer about dependencies.
      // The route replies 200 with an empty body when OAP is unreachable, and
      // treating that as "no new nodes" marked the branch EXHAUSTED and told
      // the operator this endpoint has no further callers or callees — a claim
      // about their system, made from a failure to read it. Nothing is written,
      // nothing is marked, the graph is untouched, and the handle stays live so
      // the click can simply be repeated.
      if (!accepts(resp)) {
        expansionFailed.value = { at: Date.now(), endpoint: node.name };
        // The operator clicked, so they get an answer where they are looking.
        // The refresh history is for what the timer did unasked; this is not
        // that, and burying a click's outcome there would lose it.
        reportActionFailure(new GraphUnavailableError(resp), 'Endpoint dependency', 'expanding an endpoint');
        return;
      }
      const next = new Map(expansions.value);
      next.set(key, resp);
      expansions.value = next;
      // Only now, on a read that genuinely succeeded, does "no new nodes" mean
      // there are none.
      if (!resp.nodes.some((n) => !before.has(n.id))) {
        const e = new Set(exhausted.value);
        e.add(key);
        exhausted.value = e;
        flashNoDep(node.name);
      }
    } catch (err) {
      // Transport failure — same rule: report it, change nothing, stay
      // clickable. Guarded on the epoch so a reply that outlived its focus
      // cannot raise an error against the graph that replaced it.
      if (mine === epoch) {
        expansionFailed.value = { at: Date.now(), endpoint: node.name };
        reportActionFailure(err, 'Endpoint dependency', 'expanding an endpoint');
      }
    } finally {
      if (inFlight === controller) inFlight = null;
      // Only if this request is still the current one. `clearExpansions` has
      // already emptied the set for a superseded request, and the operator may
      // have re-expanded the SAME node since — deleting its key here would take
      // the spinner off a request that is still out.
      if (mine === epoch) {
        const done = new Set(expansionsLoading.value);
        done.delete(key);
        expansionsLoading.value = done;
      }
    }
  }
  /** Everything an expansion is built on. Any of it moving invalidates them. */
  function clearExpansions(): void {
    epoch += 1;
    expansions.value = new Map();
    expansionsLoading.value = new Set();
    exhausted.value = new Set();
  }
  // A NEW BASE, atomically: the expansions go in the same update that puts the
  // new base on screen, rather than being merged onto it and then noticed as
  // wrong. A failed refresh does not advance the version, so nothing is lost
  // to a round that could not be read.
  watch(baseSnapshotVersion, () => clearExpansions());
  // A different QUESTION — endpoint, window, preview, cold stage. Same rule,
  // and it fires before the new base has even arrived.
  watch(predicateGeneration, () => clearExpansions());
  watch(selectedEndpoint, () => {
    // Everything in flight belongs to the focus being left. The epoch bump
    // inside is what stops it landing here after the clear — see `expand`.
    clearExpansions();
    noDepFlash.value = null;
    // Endpoint ids are stable across focuses, so without this cascade-clear a
    // selection under the old focus keeps the detail sidebar open on the new graph.
    onFocusReset();
  });

  // Merged graph = focus response ∪ all expansion responses, deduped by node
  // id (first-seen wins, keeping the snapshot stable while the operator browses).
  const nodes = computed<EndpointDependencyNode[]>(() => {
    const map = new Map<string, EndpointDependencyNode>();
    for (const n of baseNodes.value) map.set(n.id, n);
    for (const exp of expansions.value.values()) {
      for (const n of exp.nodes) if (!map.has(n.id)) map.set(n.id, n);
    }
    return [...map.values()];
  });
  const calls = computed<EndpointDependencyCall[]>(() => {
    // Merge with "prefer-metrics-populated" semantics: a later
    // expansion's view of the same edge wins when it has actual
    // metric values while the earlier copy was a null shell. Without
    // this, the very first fetch (which might have been served before
    // the BFF's virtual-source filter relaxation) keeps null-metric
    // edges in place even after the operator expanded a neighbour
    // that returns the correctly-populated row.
    const map = new Map<string, EndpointDependencyCall>();
    function consider(c: EndpointDependencyCall): void {
      const existing = map.get(c.id);
      if (!existing) {
        map.set(c.id, c);
        return;
      }
      if (!callHasMetrics(existing) && callHasMetrics(c)) {
        map.set(c.id, c);
      }
    }
    for (const c of baseCalls.value) consider(c);
    for (const exp of expansions.value.values()) {
      for (const c of exp.calls) consider(c);
    }
    return [...map.values()];
  });

  onBeforeUnmount(() => {
    if (noDepFlashTimer) clearTimeout(noDepFlashTimer);
    // Navigating away while an expansion is out. The request outlives this
    // screen — nothing cancels it — so without advancing the epoch its reply
    // still passes the guard and raises a toast about an endpoint graph the
    // operator left, on whatever page they went to. Bumping it discards the
    // reply the same way a focus change does. It also aborts the request, so
    // an abandoned expansion stops costing OAP work.
    inFlight?.abort();
    epoch += 1;
  });

  /**
   * Is an expansion out right now?
   *
   * While one is, the graph accepts no other query: the endpoint picker and the
   * other expand handles are disabled. That closes the stale-reply race at its
   * SOURCE — there is no "switch to B while A is loading" if B cannot be
   * clicked — and it makes a wait that used to be silent visible. The epoch
   * guard stays as defence in depth, for the paths a disabled control cannot
   * close: a route change, a time-range change, a programmatic refresh.
   */
  const expanding = computed(() => expansionsLoading.value.size > 0);

  return {
    expanding,
    expansionFailed,
    nodes,
    calls,
    noDepFlash,
    hasExpansion,
    isExhausted,
    isLoadingExpansion,
    expandNode,
  };
}
