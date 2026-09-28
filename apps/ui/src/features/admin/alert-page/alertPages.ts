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
 * The Alarm pages admin's model: the stored `horizon.alert.*` rows read as
 * pages, the editor's draft of one page, and the content a save writes.
 * Pure, so the rules the editor enforces are testable without mounting it.
 */

import {
  ALERT_DEFAULT_PAGE_ID,
  alarmPinKey,
  parseAlarmPin,
  type AlarmPin,
} from '@skywalking-horizon-ui/api-client';
import { ALARMS_WINDOW_OPTIONS, OVERVIEW_ALARMS_LIMIT_MAX, OVERVIEW_ALARMS_LIMIT_MIN, type AlarmsConfig } from '@/api/client';
import type { TemplateSyncRow } from '@/api/scopes/template-sync';
import { canonicalLayerKey } from '@/state/verbGrammar';

/** The retired singleton's key: never a page, and never offered as an id. */
const LEGACY_PAGE_SETUP_KEY = 'page-setup';
const RESERVED_PAGE_IDS: readonly string[] = [ALERT_DEFAULT_PAGE_ID, LEGACY_PAGE_SETUP_KEY];

export const PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_PINS = 8;
export const TITLE_MAX = 64;
export const ORDER_MIN = 0;
export const ORDER_MAX = 1_000_000;
/** What a page without `order` sorts as. */
export const ORDER_DEFAULT = 1000;

export function alertRowName(id: string): string {
  return `horizon.alert.${id}`;
}

export interface NamedAlertPage {
  id: string;
  title: string;
  /** `null` when the row carries no `order`. */
  order: number | null;
  pinnedLayers: string[];
  /** `null` = the default page's window. */
  defaultWindowMs: number | null;
  /** The row's content names another page than the row it sits in, so
   *  nothing serves it until it is saved again from here. */
  mismatched: boolean;
  /** The stored content is not what a save from here writes — a field the
   *  editor does not hold, a value it reads as absent, a title too long as
   *  stored — so the BFF may refuse it, and saving it again is the repair. */
  needsRewrite: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function envelopeContent(configuration: string): unknown {
  try {
    const env: unknown = JSON.parse(configuration);
    return isRecord(env) ? env.content : null;
  } catch {
    return null;
  }
}

function isAlertSourceRow(r: TemplateSyncRow): boolean {
  return r.kind === 'alert' && r.locale === undefined;
}

/** Deep equality of two JSON values, key order aside. */
export function sameContent(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameContent(v, b[i]));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameContent(a[k], b[k]))
    );
  }
  return a === b;
}

/** Read leniently: a malformed row still opens in the editor, where saving it
 *  is the repair. */
function pageFromRow(key: string, configuration: string): NamedAlertPage {
  const raw = envelopeContent(configuration);
  const c = isRecord(raw) ? raw : {};
  const win = c.defaultWindowMs;
  const page: NamedAlertPage = {
    id: key,
    title: typeof c.title === 'string' ? c.title : '',
    order: typeof c.order === 'number' && Number.isInteger(c.order) ? c.order : null,
    pinnedLayers: Array.isArray(c.pinnedLayers)
      ? c.pinnedLayers.filter((p): p is string => typeof p === 'string')
      : [],
    defaultWindowMs:
      typeof win === 'number' && (ALARMS_WINDOW_OPTIONS as readonly number[]).includes(win) ? win : null,
    mismatched: c.id !== key,
    needsRewrite: false,
  };
  // A save trims the title, but a stored one with spaces around it is still
  // served — as long as it is not over the limit as stored.
  const rewritten = { ...namedContent(key, draftFromNamed(page)), title: page.title };
  page.needsRewrite = page.title.length > TITLE_MAX || !sameContent(raw, rewritten);
  return page;
}

/** The content of the enabled `alert` row stored under `id`, if there is one. */
export function storedPageContent(rows: readonly TemplateSyncRow[], id: string): unknown {
  const row = rows.find((r) => isAlertSourceRow(r) && r.key === id && r.remote && !r.remote.disabled);
  return row?.remote ? envelopeContent(row.remote.configuration) : undefined;
}

export interface AlertPageListItem {
  id: string;
  label: string;
  /** Where the page is read; `null` while it is not on OAP yet. */
  path: string | null;
  tag: string | null;
  dirty: boolean;
}

export function comparePages(
  a: Pick<NamedAlertPage, 'id' | 'title' | 'order'>,
  b: Pick<NamedAlertPage, 'id' | 'title' | 'order'>,
): number {
  const byOrder = (a.order ?? ORDER_DEFAULT) - (b.order ?? ORDER_DEFAULT);
  if (byOrder !== 0) return byOrder;
  const byTitle = a.title.localeCompare(b.title, 'en');
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The named pages OAP holds and serves: enabled `alert` rows other than the
 *  default page and the retired page-setup row, in page order. */
export function namedPagesFromRows(rows: readonly TemplateSyncRow[]): NamedAlertPage[] {
  return rows
    .filter((r) => isAlertSourceRow(r) && !RESERVED_PAGE_IDS.includes(r.key) && r.remote && !r.remote.disabled)
    .map((r) => pageFromRow(r.key, r.remote!.configuration))
    .sort(comparePages);
}

/** Every key an `alert` row holds, disabled ones included: a disabled row
 *  keeps its name on OAP, and a save under that name would land in it and
 *  stay hidden. */
export function takenPageIds(rows: readonly TemplateSyncRow[]): Set<string> {
  return new Set(rows.filter(isAlertSourceRow).map((r) => r.key));
}

export type PageIdProblem = 'format' | 'reserved' | 'taken';

export function pageIdProblem(id: string, taken: ReadonlySet<string>): PageIdProblem | null {
  if (RESERVED_PAGE_IDS.includes(id)) return 'reserved';
  if (!PAGE_ID_PATTERN.test(id)) return 'format';
  if (taken.has(id)) return 'taken';
  return null;
}

export type TitleProblem = 'blank' | 'long';

export function titleProblem(title: string): TitleProblem | null {
  const trimmed = title.trim();
  if (trimmed === '') return 'blank';
  if (trimmed.length > TITLE_MAX) return 'long';
  return null;
}

/** One page as the editor holds it. Numbers typed by the operator stay text
 *  until they are validated, so an emptied field is not read as `0`. */
export interface PageDraft {
  title: string;
  orderText: string;
  pinnedLayers: string[];
  /** `null` = the default page's window (named pages only). */
  windowMs: number | null;
  limitText: string;
}

export function draftFromDefault(cfg: AlarmsConfig): PageDraft {
  return {
    title: '',
    orderText: '',
    pinnedLayers: [...cfg.pinnedLayers],
    windowMs: cfg.defaultWindowMs,
    limitText: String(cfg.overviewAlarmsLimit),
  };
}

export function draftFromNamed(page: Pick<NamedAlertPage, 'title' | 'order' | 'pinnedLayers' | 'defaultWindowMs'>): PageDraft {
  return {
    title: page.title,
    orderText: page.order === null ? '' : String(page.order),
    pinnedLayers: [...page.pinnedLayers],
    windowMs: page.defaultWindowMs,
    limitText: '',
  };
}

export function draftsEqual(a: PageDraft, b: PageDraft): boolean {
  return (
    a.title === b.title &&
    a.orderText.trim() === b.orderText.trim() &&
    a.windowMs === b.windowMs &&
    a.limitText.trim() === b.limitText.trim() &&
    a.pinnedLayers.length === b.pinnedLayers.length &&
    a.pinnedLayers.every((p, i) => p === b.pinnedLayers[i])
  );
}

export interface DraftProblems {
  title?: TitleProblem;
  order?: 'integer' | 'range';
  pins?: 'invalid' | 'duplicate' | 'many' | 'none';
  limit?: 'integer' | 'range';
}

function integerProblem(text: string, min: number, max: number): 'integer' | 'range' | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return 'integer';
  const v = Number(trimmed);
  return v < min || v > max ? 'range' : null;
}

/** The pins after the first that name the same tile as an earlier one
 *  (by index). */
export function duplicatePinIndexes(pins: readonly string[]): Set<number> {
  const seen = new Set<string>();
  const out = new Set<number>();
  pins.forEach((p, i) => {
    const id = pinIdentity(p);
    if (seen.has(id)) out.add(i);
    seen.add(id);
  });
  return out;
}

function pinsProblem(pins: readonly string[]): DraftProblems['pins'] | null {
  if (pins.some((p) => parseAlarmPin(p) === null)) return 'invalid';
  if (duplicatePinIndexes(pins).size > 0) return 'duplicate';
  if (pins.length > MAX_PINS) return 'many';
  return null;
}

export function draftProblems(draft: PageDraft, isDefault: boolean): DraftProblems {
  const out: DraftProblems = {};
  const pins = pinsProblem(draft.pinnedLayers);
  if (pins) out.pins = pins;
  if (isDefault) {
    const limit = integerProblem(draft.limitText, OVERVIEW_ALARMS_LIMIT_MIN, OVERVIEW_ALARMS_LIMIT_MAX);
    if (limit) out.limit = limit;
    return out;
  }
  const title = titleProblem(draft.title);
  if (title) out.title = title;
  if (draft.orderText.trim() !== '') {
    const order = integerProblem(draft.orderText, ORDER_MIN, ORDER_MAX);
    if (order) out.order = order;
  }
  if (draft.pinnedLayers.length === 0) out.pins = 'none';
  return out;
}

export function hasProblems(p: DraftProblems): boolean {
  return Object.keys(p).length > 0;
}

/** The stored named page is one the BFF does not serve as it stands: it
 *  names another page, needs rewriting, or breaks a rule the editor holds a
 *  page to. */
export function pageNotServed(page: NamedAlertPage): boolean {
  return page.mismatched || page.needsRewrite || hasProblems(draftProblems(draftFromNamed(page), false));
}

/** The default page's stored content — its three fields, as today. */
export function defaultContent(draft: PageDraft): AlarmsConfig {
  return {
    pinnedLayers: [...draft.pinnedLayers],
    defaultWindowMs: draft.windowMs ?? ALARMS_WINDOW_OPTIONS[0],
    overviewAlarmsLimit: Number(draft.limitText.trim()),
  };
}

export interface NamedPageContent {
  id: string;
  title: string;
  order?: number;
  pinnedLayers: string[];
  defaultWindowMs?: number;
}

/** A named page's stored content. The optional fields are left out rather
 *  than written as their defaults, so "inherit" keeps inheriting. */
export function namedContent(id: string, draft: PageDraft): NamedPageContent {
  const out: NamedPageContent = { id, title: draft.title.trim(), pinnedLayers: [...draft.pinnedLayers] };
  const order = draft.orderText.trim();
  if (order !== '') out.order = Number(order);
  if (draft.windowMs !== null) out.defaultWindowMs = draft.windowMs;
  return out;
}

/** Identity of a pin for the duplicate check: `GENERAL[a, b]` and
 *  `general[b, a]` name the same tile, and so do `CACHE` and `VIRTUAL_CACHE`. */
export function pinIdentity(text: string): string {
  const pin = parseAlarmPin(text);
  if (!pin) return text.trim();
  return alarmPinKey({ ...pin, layer: canonicalLayerKey(pin.layer) });
}

/** `GENERAL` -> `General`, `K8S_SERVICE` -> `K8s Service` — the page tiles'
 *  spelling of a layer. */
export function prettyLayer(k: string): string {
  return k
    .toLowerCase()
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

/** A pin as its tile reads it: `payments · General`, `payments, no group ·
 *  General`, or just `General` for the whole layer. */
export function pinLabel(pin: AlarmPin, ungroupedLabel: string): string {
  const layer = prettyLayer(pin.layer);
  if (!pin.groups) return layer;
  return `${pin.groups.map((g) => (g === '' ? ungroupedLabel : g)).join(', ')} · ${layer}`;
}
