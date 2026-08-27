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

import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { LayerDef, LayerMenuRow } from '@skywalking-horizon-ui/api-client';
import {
  firstLayerMenuRow,
  isSingleFeatureLayer,
  resolveLayerMenuRows,
} from '@skywalking-horizon-ui/api-client';

// Re-exported from its old home so call sites are unchanged. It moved to
// the shared package because the bundled-layer regression test runs in the
// BFF, where a UI import does not resolve — restating the formula there is
// what let it drift.
export { isSingleFeatureLayer };
import { bffClient } from '@/api/client';
import { usePreviewMode, getPreviewSource } from '@/controls/previewMode';
import { usePreviewOverride } from '@/controls/previewOverride';
import { useLocalTemplateEdits, layerEditName } from '@/controls/localTemplateEdits';
import { layerContentToDef, overlayLayerDef, type LayerTemplateContent } from '@/shell/layerFromTemplate';

/**
 * Live OAP-driven layer + menu state. Fed by `GET /api/menu`. Refetches on
 * window focus + every 60s.
 *
 * `data.value` is `null` while loading. `oapReachable` is false when the
 * BFF returned a soft-fail body (OAP down); the UI should render a banner
 * but otherwise keep the empty layer list rendered without crashing.
 */
export function useLayers() {
  const q = useQuery({
    queryKey: ['menu'],
    queryFn: () => bffClient.menu.get(),
    staleTime: 30_000,
    // Runs on its own clock, deliberately — it is chrome, not page data, and
    // the operator approved these four keeping their own poll. Flagged so the
    // refresh coordinator does not mistake that poll for the page being busy:
    // a 30s poller against a 30s cadence would postpone every round for ever.
    meta: { independentPoll: true },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const previewMode = usePreviewMode();
  const previewOverride = usePreviewOverride();
  const localEdits = useLocalTemplateEdits();

  /** Preview content for a layer key. `source=local` reads the live local
   *  draft; `bundled`/`remote` read the override snapshot. */
  function previewContent(key: string): LayerTemplateContent | null {
    const name = layerEditName(key);
    const src = getPreviewSource();
    if (src === 'local') return localEdits.get<LayerTemplateContent>(name) ?? null;
    if (src === 'bundled' || src === 'remote') return previewOverride.get<LayerTemplateContent>(name) ?? null;
    return (
      previewOverride.get<LayerTemplateContent>(name) ??
      localEdits.get<LayerTemplateContent>(name) ??
      null
    );
  }

  // In preview mode the per-layer tab set must reflect the previewed
  // template (its `components`/`slots`), so the sidebar overlays caps/slots
  // from the draft — and injects a previewed layer OAP doesn't list (no
  // live data) so the operator can navigate its tabs. Nothing is pushed to
  // OAP; this is browser-side only.
  const layers = computed<LayerDef[]>(() => {
    const base = q.data.value?.layers ?? [];
    if (!previewMode.value) return base;
    const seen = new Set(base.map((L) => L.key.toUpperCase()));
    const overlaid = base.map((L) => {
      const content = previewContent(L.key);
      return content ? overlayLayerDef(L, content) : L;
    });
    // Inject previewed layers absent from the live menu.
    const injected: LayerDef[] = [];
    for (const name of [...previewOverride.names(), ...localEdits.names()]) {
      if (!name.startsWith('horizon.layer.')) continue;
      const key = name.slice('horizon.layer.'.length);
      if (seen.has(key.toUpperCase())) continue;
      const content = previewContent(key);
      if (content) {
        injected.push(layerContentToDef(content));
        seen.add(key.toUpperCase());
      }
    }
    return [...overlaid, ...injected];
  });
  /**
   * Layers known to OAP (returned by `listLayers`). May include stale
   * registry entries — receivers that ever ingested but currently have no
   * services. Use this for the Setup page; users want to see and configure
   * every layer they could enable.
   */
  const activeLayers = computed<LayerDef[]>(() => layers.value.filter((L) => L.active));
  /**
   * Layers with at least one currently-reporting service (`listServices`
   * count > 0). The sidebar uses this so the user doesn't see ghost
   * entries that no longer carry data.
   */
  const availableLayers = computed<LayerDef[]>(() =>
    layers.value.filter((L) => L.serviceCount > 0),
  );
  const oapReachable = computed<boolean>(() => q.data.value?.oap.reachable ?? false);
  const oapError = computed<string | undefined>(() => q.data.value?.oap.error);

  function findLayer(key: string | undefined): LayerDef | undefined {
    if (!key) return undefined;
    return layers.value.find((L) => L.key === key);
  }

  /**
   * `caps.serviceMap || caps.instanceTopology || caps.processTopology`.
   * Pulled out of `layers.ts` so the sidebar can stay UI-only.
   */
  function hasTopology(L: LayerDef | undefined): boolean {
    if (!L) return false;
    return Boolean(L.caps.serviceMap || L.caps.instanceTopology || L.caps.processTopology);
  }

  return {
    isLoading: q.isLoading,
    isError: q.isError,
    layers,
    activeLayers,
    availableLayers,
    oapReachable,
    oapError,
    findLayer,
    hasTopology,
    refetch: q.refetch,
  };
}

/**
 * The layer's sub-page rows, in sidebar order. Prefers the list the BFF
 * resolved and served; falls back to resolving locally so a layer built
 * in the browser from an unpushed draft (preview) behaves identically.
 */
export function layerMenuRows(L: LayerDef | undefined | null): LayerMenuRow[] {
  if (!L) return [];
  return L.menuRows ?? resolveLayerMenuRows(L);
}

/**
 * The sub-route a layer lands on — its first row. Some layers turn the
 * service page off entirely (`mesh_dp` sidecar-only, `so11y_*_agent`
 * per-JVM), so this is not always `service`.
 */
export function firstLayerTab(L: LayerDef | undefined): string {
  return firstLayerMenuRow(L);
}
