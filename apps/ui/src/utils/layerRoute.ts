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
 * A layer's sidebar entries and their URLs.
 *
 * A layer whose template sets `splitByServiceGroup` has one entry per OAP
 * service group. A group's pages carry the group as its own path segment,
 * `/layer/general/payments/topology`, and the services with no group take the
 * layer's own URLs, `/layer/general/topology` — the URL follows the service
 * name. Any other layer has one entry, at `/layer/<layer>/…`. A sub page of an
 * entity component is `<component>/page/<id>`, so the group, the tab and the
 * page each sit in a position of their own and no name is reserved.
 *
 * The menu sends an entry as its layer's key and, apart, its group. In the
 * browser an entry is keyed by its path form, `general/payments` — the group
 * percent-encoded as in its URL, `general/` for the services with no group;
 * this module and the api client, which turns it into `?group=`, are the only
 * code that reads it.
 */

import type { RouteLocationNormalizedLoaded } from 'vue-router';
import { UNGROUPED_PIN, formatAlarmPin, parseAlarmPin, type LayerDef } from '@skywalking-horizon-ui/api-client';

export interface LayerEntryRef {
  /** Lower-cased, as URLs spell it. */
  layer: string;
  /** The OAP service group of a split layer's entry; `''` is the services with
   *  no group. Absent on a layer that is not split. */
  group?: string;
}

export function entryKey(ref: LayerEntryRef): string {
  return ref.group === undefined ? ref.layer : `${ref.layer}/${encodeURIComponent(ref.group)}`;
}

/** The group is percent-encoded, so the first `/` ends the layer. */
export function parseEntryKey(key: string): LayerEntryRef {
  const cut = key.indexOf('/');
  if (cut < 0) return { layer: key.toLowerCase() };
  const raw = key.slice(cut + 1);
  let group = raw;
  try {
    group = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded as an entry key is; kept as written.
  }
  return { layer: key.slice(0, cut).toLowerCase(), group };
}

export function entryOf(L: Pick<LayerDef, 'key'>): LayerEntryRef {
  return parseEntryKey(L.key);
}

/** A view's menu entry from the key it reads with: that entry exactly — a
 *  group keeps its case, as OAP does — or, for a whole layer's key on a split
 *  layer, any of its entries, which all share the layer's components. */
export function findEntry<T extends Pick<LayerDef, 'key'>>(menu: readonly T[], key: string): T | null {
  const ref = parseEntryKey(key);
  const want = entryKey(ref);
  const exact = menu.find((L) => entryKey(entryOf(L)) === want);
  if (exact) return exact;
  return ref.group === undefined ? (menu.find((L) => entryOf(L).layer === ref.layer) ?? null) : null;
}

/** The layer's own name, from any of its entries: a group entry's name leads
 *  with its group, `payments · General Service`. */
export function entryLayerName(L: Pick<LayerDef, 'name' | 'serviceGroup'>): string {
  return L.serviceGroup ? L.name.replace(`${L.serviceGroup} · `, '') : L.name;
}

/** One item per layer of a menu, where a split layer has one per group. */
export function menuLayers<T extends Pick<LayerDef, 'key' | 'name' | 'serviceGroup'>>(
  menu: readonly T[],
): Array<{ layer: string; name: string; def: T }> {
  const out = new Map<string, { layer: string; name: string; def: T }>();
  for (const L of menu) {
    const layer = entryOf(L).layer;
    if (!out.has(layer)) out.set(layer, { layer, name: entryLayerName(L), def: L });
  }
  return [...out.values()];
}

/** The URL of one of an entry's rows — a tab (`topology`), or a sub page,
 *  which the menu names `<component>/<id>`. Always with a row: a group's bare
 *  URL, `/layer/general/topology`, would be read as the tab of that name. */
export function layerPath(ref: LayerEntryRef, row: string): string {
  const base = `/layer/${encodeURIComponent(ref.layer)}${ref.group ? `/${encodeURIComponent(groupSegment(ref.group))}` : ''}`;
  return `${base}/${rowPath(row)}`;
}

// A path segment of only dots is a relative step to a browser — `..` climbs a
// level, even percent-encoded — so a group of only dots is written with two
// more, which no browser moves, and read back without them.
const DOTS = /^\.+$/;

function groupSegment(group: string): string {
  return DOTS.test(group) ? `${group}..` : group;
}

/** A group from its URL segment, as the router decoded it. */
export function groupOfSegment(segment: string): string {
  return DOTS.test(segment) && segment.length > 2 ? segment.slice(0, -2) : segment;
}

export function rowPath(row: string): string {
  const cut = row.indexOf('/');
  return cut < 0 ? row : `${row.slice(0, cut)}/page/${row.slice(cut + 1)}`;
}

/** The menu row a layer route shows — a tab, or `<component>/<id>` for a sub
 *  page — read from the route, never from the path, whose segments mean
 *  something only by position. Undefined on the entry's bare URL. */
export function routeRow(route: Pick<RouteLocationNormalizedLoaded, 'meta' | 'params'>): string | undefined {
  const row = route.meta.layerRow;
  if (typeof row !== 'string') return undefined;
  const page = route.params.pageId;
  return typeof page === 'string' ? `${row}/${page}` : row;
}

export interface ResolvedEntry {
  ref: LayerEntryRef;
  key: string;
  /** The reader's menu entry; null while the menu loads, or when the reader
   *  has none — no access, or no such layer or group. */
  def: LayerDef | null;
  /** Whether the menu splits this layer; null when the reader's menu has no
   *  entry of it to tell. */
  split: boolean | null;
}

/**
 * The entry a URL's layer and group segments name. On a split layer a URL
 * with no group segment is the services with no group; a group segment on a
 * layer that is not split names no entry (`def` null, `split` false), which
 * the layer page shows as not found.
 */
export function resolveEntry(menu: readonly LayerDef[], layerParam: string, groupSegmentParam?: string): ResolvedEntry {
  const layer = layerParam.toLowerCase();
  const groupParam = groupSegmentParam === undefined ? undefined : groupOfSegment(groupSegmentParam);
  const entries = menu.filter((L) => entryOf(L).layer === layer);
  const split = entries.length === 0 ? null : entries.some((L) => entryOf(L).group !== undefined);
  if (split === true) {
    const ref = { layer, group: groupParam ?? '' };
    return { ref, key: entryKey(ref), def: entries.find((L) => entryOf(L).group === ref.group) ?? null, split };
  }
  const ref = groupParam === undefined ? { layer } : { layer, group: groupParam };
  const def = split === false && groupParam === undefined ? entries[0]! : null;
  return { ref, key: entryKey(ref), def, split };
}

/**
 * The entry a service of `layer` opens under: on a split layer, its group's —
 * OAP's group is the name before `::` — even when this reader has no such
 * entry, so the page says why.
 */
export function entryForService(menu: readonly LayerDef[], layer: string, group: string | null): LayerEntryRef {
  const key = layer.toLowerCase();
  const split = menu.some((L) => {
    const e = entryOf(L);
    return e.layer === key && e.group !== undefined;
  });
  return split ? { layer: key, group: group ?? '' } : { layer: key };
}

/**
 * How an overview widget stores its layer: the layer, or one service group of
 * a split layer written the way a grant and an alarm pin qualify a layer —
 * `GENERAL[payments]`, `GENERAL[-]` for the services with no group. The group
 * is kept as written: OAP compares groups exactly.
 */
export function widgetLayerOf(ref: LayerEntryRef): string | null {
  const layer = ref.layer.toUpperCase();
  if (ref.group === undefined) return layer;
  return writableGroup(ref.group) ? formatAlarmPin({ layer, groups: [ref.group] }) : null;
}

/** Can a pin name this group? The notation reserves `,`, `[` and `]`, `-` is
 *  its word for "no group", and a name reads back trimmed, so a padded name
 *  would name another group. */
function writableGroup(group: string): boolean {
  return group === '' || (group !== UNGROUPED_PIN && group === group.trim() && !/[,[\]]/.test(group));
}

/** The entry an overview widget's layer names; null when it names none. */
export function widgetLayerEntry(stored: string): LayerEntryRef | null {
  const pin = parseAlarmPin(stored);
  if (!pin) return null;
  if (!pin.groups) return { layer: pin.layer.toLowerCase() };
  return pin.groups.length === 1 ? { layer: pin.layer.toLowerCase(), group: pin.groups[0]! } : null;
}

/** The entry key an overview widget's layer reads with; `''` when it names no
 *  entry, which reads nothing. */
export function widgetEntryKey(stored: string): string {
  const ref = widgetLayerEntry(stored);
  return ref ? entryKey(ref) : '';
}
