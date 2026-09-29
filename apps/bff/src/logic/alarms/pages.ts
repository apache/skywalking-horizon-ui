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
 * The alarm pages one reader is served: the default page
 * (`horizon.alert.default`, the `/alarms` page) and the named ones
 * (`horizon.alert.<id>`), read from the template store and fitted to the
 * reader.
 *
 * A page is a view, never a permission. Which alarms a reader may see is
 * decided by their `alarms:read` grant alone; a page arranges tiles over those
 * alarms, and a named page shows only the ones its pins cover. So a pin the
 * reader cannot reach is left out and counted, and a pin is narrowed to the
 * service groups the reader reaches in its layer.
 *
 * Remote-only, like every other template read: in live mode only enabled,
 * readable OAP rows count, and an unreachable store serves no page at all —
 * never the disk bundle. Readonly mode presents the bundle as the stored rows,
 * so there the default page is the bundled one and there are no named pages.
 */

import {
  ALERT_DEFAULT_PAGE_ID,
  alarmPinKey,
  formatAlarmPin,
  type AlarmPageView,
  type AlarmPagesResponse,
  type AlarmPin,
  type UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import type { ZodError } from 'zod';
import { ambiguousConflicts, getSyncStatus, type SyncStatus } from '../templates/sync.js';
import { iterateBundledTemplates } from '../templates/aggregator.js';
import { ALERT_DEFAULT_KEY, formatName, parseEnvelope } from '../templates/names.js';
import {
  ALARMS_WINDOW_CHOICES_MS,
  ALERT_PAGE_DEFAULT_ORDER,
  alertDefaultTemplateSchema,
  alertPageTemplateSchema,
  parseCanonicalAlarmPin,
} from '../templates/bundled-schema.js';
import type { LayerReach } from '../../rbac/layer-access.js';
import type { RequestAccess } from '../../rbac/request-access.js';
import { logger } from '../../logger.js';

/** A page as stored, its pins canonical. */
export interface StoredAlarmPage {
  id: string;
  /** `null` on the default page. */
  title: string | null;
  order: number;
  pins: AlarmPin[];
  /** Absent on a named page that follows the default page's window. */
  defaultWindowMs?: number;
}

export interface StoredAlarmPages {
  unreachable: boolean;
  default: StoredAlarmPage | null;
  /** In page order: `order`, then title, then id. */
  pages: StoredAlarmPage[];
}

/** What a reader reaches of one canonical layer with `alarms:read`. */
export type PinReach = (layer: string) => LayerReach | null;

const WHOLE: LayerReach = { whole: true, groups: new Set() };

/** The caller's reach. No access object means no scope gate is wired (unit
 *  tests): no layer restriction, as before layer grants existed. */
export function pinReachOf(access: RequestAccess | undefined): PinReach {
  return access ? (layer) => access.onLayer(['alarms:read'], layer) : () => WHOLE;
}

/** The window a page with none of its own opens on when the default page
 *  cannot be read either — the first choice, as the UI's in-code default. */
const FALLBACK_WINDOW_MS = ALARMS_WINDOW_CHOICES_MS[0];

const EMPTY_UNREACHABLE: StoredAlarmPages = { unreachable: true, default: null, pages: [] };

export async function readStoredAlarmPages(
  uiTemplateClient: (() => UITemplateClient) | undefined,
): Promise<StoredAlarmPages> {
  if (!uiTemplateClient) return EMPTY_UNREACHABLE;
  let sync: SyncStatus;
  try {
    sync = await getSyncStatus({
      client: uiTemplateClient(),
      bundled: () => iterateBundledTemplates(),
      logger,
    });
  } catch (err) {
    logger.warn({ err }, 'alarm pages resolve failed — serving no page, not the bundle');
    return EMPTY_UNREACHABLE;
  }
  return storedAlarmPages(sync);
}

interface InvalidPage {
  name: string;
  issues: string[];
}

/** The pages a sync status holds. `unreachable` status rows are the last good
 *  read, kept for the admin surface; a page is not served from them. */
export function storedAlarmPages(sync: SyncStatus): StoredAlarmPages {
  if (sync.unreachable) return EMPTY_UNREACHABLE;
  const defaultName = formatName('alert', ALERT_DEFAULT_KEY);
  // A named page on several differing enabled rows has no one definition,
  // so it is left out as the menu leaves out such a layer. The default page
  // is read as the settings route reads it, so its tiles and the badge agree.
  const ambiguous = new Set(ambiguousConflicts(sync, 'alert').map((c) => c.name));
  let defaultPage: StoredAlarmPage | null = null;
  const pages: StoredAlarmPage[] = [];
  const invalid: InvalidPage[] = [];
  for (const row of sync.rows) {
    if (row.kind !== 'alert' || row.locale !== undefined || row.effective !== 'remote' || !row.remote) continue;
    const content = parseEnvelope(row.remote.configuration)?.content;
    if (row.name === defaultName) {
      const v = alertDefaultTemplateSchema.safeParse(content);
      if (!v.success) {
        invalid.push({ name: row.name, issues: issuesOf(v.error) });
        continue;
      }
      defaultPage = {
        id: ALERT_DEFAULT_PAGE_ID,
        title: null,
        order: 0,
        pins: canonicalPins(v.data.pinnedLayers),
        defaultWindowMs: v.data.defaultWindowMs,
      };
      continue;
    }
    if (ambiguous.has(row.name)) continue;
    const v = alertPageTemplateSchema.safeParse(content);
    if (!v.success) {
      invalid.push({ name: row.name, issues: issuesOf(v.error) });
      continue;
    }
    pages.push({
      id: v.data.id,
      title: v.data.title,
      order: v.data.order ?? ALERT_PAGE_DEFAULT_ORDER,
      pins: canonicalPins(v.data.pinnedLayers),
      ...(v.data.defaultWindowMs !== undefined ? { defaultWindowMs: v.data.defaultWindowMs } : {}),
    });
  }
  pages.sort(comparePages);
  warnInvalid(sync, invalid);
  return { unreachable: false, default: defaultPage, pages };
}

/** Page order: `order`, then title, then id — the id breaks every tie, so
 *  two readers never see the same pages in two orders. */
export function comparePages(a: StoredAlarmPage, b: StoredAlarmPage): number {
  if (a.order !== b.order) return a.order - b.order;
  const byTitle = (a.title ?? '').localeCompare(b.title ?? '', 'en');
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The schema has already refused a pin that does not parse. */
function canonicalPins(texts: readonly string[]): AlarmPin[] {
  return texts.map((t) => parseCanonicalAlarmPin(t)).filter((p): p is AlarmPin => p !== null);
}

function issuesOf(err: ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

/** `getSyncStatus` hands every caller the same object for ~30s, so keying on
 *  it logs an invalid page once per store read rather than once per page view. */
const warnedFor = new WeakSet<SyncStatus>();

function warnInvalid(sync: SyncStatus, invalid: InvalidPage[]): void {
  if (invalid.length === 0 || warnedFor.has(sync)) return;
  warnedFor.add(sync);
  logger.warn(
    { rows: invalid },
    'Alarm pages not served: their stored content is not a valid alarm page. Every other page is served as usual. ' +
      'Save each one again under Alarm pages, or retire its record on OAP; Horizon changes nothing on its own.',
  );
}

/**
 * The pin as this reader may see it, or `null` when they reach nothing of it.
 * A reach limited to groups narrows the pin to those groups — a whole-layer
 * pin becomes the groups reached — so a tile never names services the reader
 * was not given.
 */
export function narrowPin(pin: AlarmPin, reach: LayerReach | null): AlarmPin | null {
  if (!reach) return null;
  if (reach.whole) return pin;
  const groups = pin.groups
    ? pin.groups.filter((g) => reach.groups.has(g))
    : [...reach.groups].sort();
  return groups.length > 0 ? { layer: pin.layer, groups } : null;
}

/** A page's pins as one reader is served them, and how many they reach
 *  nothing of. */
function servedPins(page: StoredAlarmPage, reach: PinReach): { pins: AlarmPin[]; hidden: number } {
  const pins: AlarmPin[] = [];
  const seen = new Set<string>();
  let hidden = 0;
  for (const pin of page.pins) {
    const served = narrowPin(pin, reach(pin.layer));
    if (!served) {
      hidden++;
      continue;
    }
    // Narrowing can fold two pins into one (`GENERAL` and `GENERAL[payments]`
    // for a reader who reaches only payments): one tile, not two alike.
    const key = alarmPinKey(served);
    if (seen.has(key)) continue;
    seen.add(key);
    pins.push(served);
  }
  return { pins, hidden };
}

function viewOf(page: StoredAlarmPage, reach: PinReach, fallbackWindowMs: number): AlarmPageView {
  const { pins, hidden } = servedPins(page, reach);
  return {
    id: page.id,
    title: page.title,
    pinnedLayers: pins.map(formatAlarmPin),
    hiddenPins: hidden,
    defaultWindowMs: page.defaultWindowMs ?? fallbackWindowMs,
  };
}

/**
 * The pages one reader is served. The default page is served to every
 * `alarms:read` holder whenever its row is readable, however few of its pins
 * they reach; a named page only when they reach at least one of its pins.
 */
export function alarmPagesFor(stored: StoredAlarmPages, reach: PinReach): AlarmPagesResponse {
  const fallbackWindowMs = stored.default?.defaultWindowMs ?? FALLBACK_WINDOW_MS;
  const pages: AlarmPageView[] = [];
  for (const page of stored.pages) {
    const view = viewOf(page, reach, fallbackWindowMs);
    if (view.pinnedLayers.length > 0) pages.push(view);
  }
  return {
    unreachable: stored.unreachable,
    default: stored.default ? viewOf(stored.default, reach, fallbackWindowMs) : null,
    pages,
  };
}

/**
 * The pins of the named page `id` as this reader is served them — the same
 * page and pins {@link alarmPagesFor} lists — or `null` when it is not served
 * to them: no such page, or none of its pins reached. The default page is not
 * a named page.
 */
export function namedPagePins(stored: StoredAlarmPages, id: string, reach: PinReach): AlarmPin[] | null {
  const page = stored.pages.find((p) => p.id === id);
  if (!page) return null;
  const { pins } = servedPins(page, reach);
  return pins.length > 0 ? pins : null;
}
