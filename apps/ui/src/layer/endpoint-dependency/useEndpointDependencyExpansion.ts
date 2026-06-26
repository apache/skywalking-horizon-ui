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
import { useTimeRangeStore } from '@/controls/timeRange';

interface ExpansionOptions {
  layerKey: Ref<string>;
  baseNodes: Ref<EndpointDependencyNode[]>;
  baseCalls: Ref<EndpointDependencyCall[]>;
  selectedEndpoint: Ref<string | null>;
  /** Cascade-clear the view's per-graph state when the focus endpoint changes. */
  onFocusReset: () => void;
}

/** True when the call carries at least one resolved metric value. */
function callHasMetrics(c: EndpointDependencyCall): boolean {
  for (const v of Object.values(c.metrics ?? {})) if (v !== null) return true;
  return false;
}

export function useEndpointDependencyExpansion(opts: ExpansionOptions) {
  const { layerKey, baseNodes, baseCalls, selectedEndpoint, onFocusReset } = opts;
  const timeRange = useTimeRangeStore();

  // Keyed by node id so a repeat click is a no-op; a click that surfaces
  // nothing new marks the node exhausted, fading the handle.
  const expansions = ref<Map<string, EndpointDependencyResponse>>(new Map());
  const expansionsLoading = ref<Set<string>>(new Set());
  const exhausted = ref<Set<string>>(new Set());
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
    const loading = new Set(expansionsLoading.value);
    loading.add(key);
    expansionsLoading.value = loading;
    try {
      const before = new Set(nodes.value.map((n) => n.id));
      const resp = await bffClient.layer.endpointDependency(
        layerKey.value,
        node.serviceName,
        node.name,
        { step: timeRange.step, startMs: timeRange.range.startMs, endMs: timeRange.range.endMs },
      );
      const next = new Map(expansions.value);
      next.set(key, resp);
      expansions.value = next;
      if (!resp.nodes.some((n) => !before.has(n.id))) {
        const e = new Set(exhausted.value);
        e.add(key);
        exhausted.value = e;
        flashNoDep(node.name);
      }
    } catch {
      // Soft-fail — the operator can click again to retry.
    } finally {
      const done = new Set(expansionsLoading.value);
      done.delete(key);
      expansionsLoading.value = done;
    }
  }
  watch(selectedEndpoint, () => {
    expansions.value = new Map();
    expansionsLoading.value = new Set();
    exhausted.value = new Set();
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
  });

  return {
    nodes,
    calls,
    noDepFlash,
    hasExpansion,
    isExhausted,
    isLoadingExpansion,
    expandNode,
  };
}
