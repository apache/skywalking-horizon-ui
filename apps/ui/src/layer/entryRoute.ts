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
 * What the layer shell does with the entry its URL names: which roster it
 * reads, and where it sends a URL the entry cannot show.
 */

import { isBuiltInLayerRow, type LayerDef } from '@skywalking-horizon-ui/api-client';
import { firstLayerTab, layerMenuRows } from '@/shell/useLayers';
import { entryOf, layerPath, type ResolvedEntry } from '@/utils/layerRoute';

/**
 * The key the entry's service roster is read with; `''` reads nothing. It
 * waits for the menu to say whether the layer is split, so a URL without a
 * group segment is not first read as the whole layer. A layer key is letters,
 * digits and `_`: a segment with anything else names no layer, and neither
 * does a group segment on a layer the menu shows unsplit.
 */
export function rosterReadKey(
  layerParam: string,
  groupParam: string | undefined,
  entry: ResolvedEntry,
  menuLoading: boolean,
): string {
  if (!/^[A-Za-z0-9_]+$/.test(layerParam)) return '';
  if (entry.split === null && menuLoading) return '';
  if (entry.split === false && groupParam !== undefined) return '';
  return entry.key;
}

export interface EntryRouteState {
  menu: readonly LayerDef[];
  entry: ResolvedEntry;
  /** The URL's group segment; absent on a URL without one. */
  groupParam: string | undefined;
  /** The menu row the route shows; absent on the entry's bare URL. */
  row: string | undefined;
  /** The URL names a service to show. */
  namesService: boolean;
  /** The entry's layer, once known. */
  layer: LayerDef | null;
}

/**
 * The path a layer URL is replaced with, or null when it stays:
 *
 * - A split layer's URL without a group segment is its services with no
 *   group. A reader with no such entry — the layer has none, or the grant
 *   does not reach it — goes to their first entry of the layer, on the same
 *   row, unless the URL names a service, which the page then says it cannot
 *   show.
 * - An entry's bare URL opens its first tab. The router cannot answer this:
 *   the first tab is per layer, and only the menu knows it.
 * - A built-in tab the layer does not offer opens its first tab instead of an
 *   empty page. The layer's resolved rows decide, the list the sidebar
 *   renders, so a tab the sidebar offers is never left.
 *
 * An entry the menu does not know keeps its address, and the page shows its
 * not-found card there.
 */
export function entryRedirect(s: EntryRouteState): string | null {
  const { split, def, ref } = s.entry;
  if (split === true && s.groupParam === undefined && !def && !s.namesService) {
    const first = s.menu.find((L) => entryOf(L).layer === ref.layer);
    if (first) return layerPath(entryOf(first), s.row ?? firstLayerTab(first));
  }
  const L = s.layer;
  if (!L) return null;
  if (s.row === undefined) return layerPath(entryOf(L), firstLayerTab(L));
  const scope = s.row.split('/', 1)[0]!;
  if (layerMenuRows(L).some((r) => r.path === scope)) return null;
  if (!isBuiltInLayerRow(scope)) return null;
  // `zipkin-trace` is reachable without being a row: a layer whose traces are
  // Zipkin only shows one Traces row that embeds the explorer, and the
  // standalone URL still opens it in full, with its own toolbar.
  if (scope === 'zipkin-trace' && L.caps?.traces) return null;
  const fallback = firstLayerTab(L);
  return fallback === scope ? null : layerPath(entryOf(L), fallback);
}
