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
 * The tiles and list tabs of an alarm page, from its pins and the incidents in
 * the window.
 *
 * Every surface names what it narrows to by one CHIP KEY, which is also the
 * `?layer=` URL value: a pin key (`GENERAL`, `GENERAL[payments, -]`), a plain
 * layer key for an unpinned layer, or `OTHER`. A pin key keeps its groups as
 * written — OAP service groups are case-sensitive.
 *
 * Counts are ACTIVE incidents. An incident counts under every tile it
 * matches, so the tiles can add up to more than Active; Other is the active
 * incidents no pin matches. A named page lists only what its pins cover, so it
 * has neither Other nor a tab for an unpinned layer.
 */

import { computed, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { alarmPinKey, alarmPinMatches, formatAlarmPin, parseAlarmPin, type AlarmPin } from '@skywalking-horizon-ui/api-client';
import { canonicalLayerKey } from '@/state/verbGrammar';
import type { AlarmIncident } from '@/utils/alarmIncidents';

export const OTHER_CHIP = 'OTHER';

export interface AlarmChip {
  key: string;
  label: string;
  count: number;
}

export interface PinnedTile extends AlarmChip {
  pin: AlarmPin;
  /** The pin's groups as shown, `null` for a whole-layer pin. */
  groupsLabel: string | null;
  layerLabel: string;
}

/** Anything the pins can be matched against: an incident, or a raw alarm row. */
export interface PinMatchable {
  layerKeys: readonly string[];
  ownerKeys?: readonly string[];
}

/** `VIRTUAL_DATABASE` → `Virtual Database`. */
export function prettyLayer(k: string): string {
  return k
    .toLowerCase()
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

/** A pin with its layer canonical, as the rows' `layerKeys` are; `null` for a
 *  malformed one. */
export function canonicalPin(text: string): AlarmPin | null {
  const pin = parseAlarmPin(text);
  return pin ? { ...pin, layer: canonicalLayerKey(pin.layer) } : null;
}

/** The chip key a `?layer=` value names; `''` for none, or one that is not a
 *  pin at all. */
export function chipKeyOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '';
  const pin = canonicalPin(raw);
  return pin ? formatAlarmPin(pin) : '';
}

export function useAlarmPins(opts: {
  pinnedLayers: Ref<readonly string[]>;
  /** Range-scoped incidents, recovered ones included. */
  incidents: Ref<readonly AlarmIncident[]>;
  chip: Ref<string>;
  /** The page lists only the alarms its pins cover: a named page. */
  pinsOnly: Ref<boolean>;
}) {
  const { t } = useI18n();

  const pins = computed<Array<{ key: string; pin: AlarmPin }>>(() => {
    // One tile per pin identity: groups in another order are the same pin.
    const out = new Map<string, { key: string; pin: AlarmPin }>();
    for (const text of opts.pinnedLayers.value) {
      const pin = canonicalPin(text);
      if (pin && !out.has(alarmPinKey(pin))) out.set(alarmPinKey(pin), { key: formatAlarmPin(pin), pin });
    }
    return [...out.values()];
  });
  const pinnedLayers = computed<Set<string>>(() => new Set(pins.value.map((p) => p.pin.layer)));
  function inAnyPin(row: PinMatchable): boolean {
    return pins.value.some((p) => alarmPinMatches(p.pin, row));
  }

  const active = computed<AlarmIncident[]>(() => opts.incidents.value.filter((i) => i.state !== 'recovered'));
  const totalCount = computed<number>(() => active.value.length);

  const pinnedTiles = computed<PinnedTile[]>(() =>
    pins.value.map(({ key, pin }) => {
      const groupsLabel = pin.groups ? pin.groups.map((g) => (g === '' ? t('no group') : g)).join(', ') : null;
      const layerLabel = prettyLayer(pin.layer);
      return {
        key,
        pin,
        groupsLabel,
        layerLabel,
        label: groupsLabel ? `${groupsLabel} · ${layerLabel}` : layerLabel,
        count: active.value.filter((i) => alarmPinMatches(pin, i)).length,
      };
    }),
  );
  const otherCount = computed<number>(() => active.value.filter((i) => !inAnyPin(i)).length);

  /** A tab for every layer with an active incident that no pin names, most
   *  incidents first. A layer a pin names — whole or for some groups — gets
   *  none: its alarms outside the pinned groups count under Other. */
  const layerTabs = computed<AlarmChip[]>(() => {
    const counts = new Map<string, number>();
    for (const inc of active.value) for (const k of inc.layerKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
    const out: AlarmChip[] = [];
    for (const [k, n] of counts) if (!pinnedLayers.value.has(k)) out.push({ key: k, label: prettyLayer(k), count: n });
    out.sort((a, b) => b.count - a.count);
    return out;
  });

  const chipPin = computed<AlarmPin | null>(() => {
    const c = opts.chip.value;
    return c && c !== OTHER_CHIP ? canonicalPin(c) : null;
  });
  /** Does a row pass the selected tile, chip or tab? */
  function inChip(row: PinMatchable): boolean {
    const c = opts.chip.value;
    if (!c) return true;
    if (c === OTHER_CHIP) return !inAnyPin(row);
    return chipPin.value ? alarmPinMatches(chipPin.value, row) : true;
  }

  const tabs = computed<AlarmChip[]>(() => {
    const out: AlarmChip[] = [{ key: '', label: t('All'), count: totalCount.value }];
    for (const tile of pinnedTiles.value) out.push({ key: tile.key, label: tile.label, count: tile.count });
    if (opts.pinsOnly.value) return out;
    out.push(...layerTabs.value);
    if (otherCount.value > 0) out.push({ key: OTHER_CHIP, label: t('Other'), count: otherCount.value });
    return out;
  });

  return { totalCount, pinnedTiles, otherCount, tabs, inChip };
}
