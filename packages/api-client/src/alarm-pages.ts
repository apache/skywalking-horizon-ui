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
 * Alarm pages: the default Alarms page and any number of named ones, each a
 * set of pinned tiles over the alarms the reader may read.
 *
 * A pin names a layer and, optionally, OAP service groups in it, spelled the
 * way a grant qualifies a verb — `GENERAL`, `GENERAL[payments, risk]`, with
 * `-` for the services that have no group — so a page pin and the grant that
 * reaches it read alike: `alarms:read@GENERAL[payments]` reaches the pin
 * `GENERAL[payments]`.
 */

/** The key of the default page's stored row, `horizon.alert.default`. */
export const ALERT_DEFAULT_PAGE_ID = 'default';

/** How a pin spells the services that have no group. */
export const UNGROUPED_PIN = '-';

export interface AlarmPin {
  /** Upper-cased as written; callers canonicalise aliases. */
  layer: string;
  /** Absent = the whole layer. `''` is the ungrouped services. */
  groups?: readonly string[];
}

const PIN = /^([A-Za-z0-9_]+)(?:\[([^\]]*)\])?$/;

/** `null` for a malformed pin (`GENERAL[]`, `GENERAL[a,,b]`, anything after
 *  the `]`): a typo must not widen a tile to the whole layer. */
export function parseAlarmPin(text: string): AlarmPin | null {
  const m = PIN.exec(text.trim());
  if (!m) return null;
  const layer = m[1]!.toUpperCase();
  if (m[2] === undefined) return { layer };
  const groups = m[2].split(',').map((g) => g.trim());
  if (groups.some((g) => g === '')) return null;
  return { layer, groups: groups.map((g) => (g === UNGROUPED_PIN ? '' : g)) };
}

export function formatAlarmPin(pin: AlarmPin): string {
  if (!pin.groups) return pin.layer;
  return `${pin.layer}[${pin.groups.map((g) => (g === '' ? UNGROUPED_PIN : g)).join(', ')}]`;
}

/** A pin's identity: `GENERAL[a, b]` and `GENERAL[b, a]` select the same
 *  services, so they are one pin. The pin's layer must already be canonical. */
export function alarmPinKey(pin: AlarmPin): string {
  return pin.groups ? `${pin.layer}[${[...pin.groups].sort().join(',')}]` : pin.layer;
}

/** The pin a layer filter names — a layer, or service groups of it written
 *  as a pin, `GENERAL[payments]` — with its layer canonicalised; a group is
 *  matched exactly as written. `null` when the text names no pin, which a
 *  caller must not read as "every layer". */
export function layerFilterPin(text: string, canonicalLayer: (layer: string) => string): AlarmPin | null {
  const pin = parseAlarmPin(text);
  return pin ? { ...pin, layer: canonicalLayer(pin.layer) } : null;
}

/** A layer and service group a service an alarm concerns is in; `group` is
 *  `''` for a service with none. */
export interface AlarmOwner {
  layer: string;
  group: string;
}

/** Does an alarm count under `pin`? A whole-layer pin reads the row's layers;
 *  a pin with groups reads the layer-and-group pairs of the services the
 *  alarm concerns, so a relation between two groups counts under each. The
 *  pin's layer must already be canonical. */
export function alarmPinMatches(
  pin: AlarmPin,
  row: { layerKeys: readonly string[]; owners?: readonly AlarmOwner[] },
): boolean {
  if (!pin.groups) return row.layerKeys.includes(pin.layer);
  const groups = pin.groups;
  return (row.owners ?? []).some((o) => o.layer === pin.layer && groups.includes(o.group));
}

/** A page as one reader sees it: the pins they cannot reach are left out, and
 *  a pin's groups are narrowed to the ones they reach. */
export interface AlarmPageView {
  id: string;
  /** Operator text, shown verbatim. `null` on the default page, which is
   *  called "Alarms". */
  title: string | null;
  pinnedLayers: string[];
  /** Pins configured on the page that this reader cannot reach. */
  hiddenPins: number;
  defaultWindowMs: number;
}

export interface AlarmPagesResponse {
  /** The template store could not be read: no page is served. */
  unreachable: boolean;
  /** `null` when the default page's row cannot be read. */
  default: AlarmPageView | null;
  /** The named pages this reader reaches, in page order. */
  pages: AlarmPageView[];
}
