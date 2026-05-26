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
 * Reserved-name convention for Horizon templates stored on OAP via
 * `/ui-management/templates*`. The OAP `configuration` field is opaque
 * to OAP — Horizon wraps each bundled template in a small envelope so
 * the BFF can read the name without parsing the inner content.
 *
 *   { "name": "horizon.<kind>.<key>", "kind": "...", "version": 1, "content": {...} }
 *
 * Source rows:
 *   - `horizon.overview.<id>`        — overview dashboards (e.g. `services`, `mesh`)
 *   - `horizon.layer.<KEY>`          — layer dashboards (e.g. `GENERAL`, `K8S`)
 *   - `horizon.alert.page-setup`     — alert page setup (singleton)
 *   - `horizon.theme.active`         — org-default theme selection (singleton)
 *   - `horizon.time-defaults.global` — global time-picker default window (singleton)
 *
 * Per-locale translation overlay rows (NEW — see CLAUDE.md →
 * Internationalization). The `i18n.<locale>` suffix marks the row as
 * carrying only the translation map for that locale, sibling to the
 * source row above it:
 *   - `horizon.layer.MESH.i18n.zh-CN`     — zh-CN overlay for the MESH layer
 *   - `horizon.overview.services.i18n.es` — es overlay for the services overview
 *
 * The `horizon.` prefix keeps Horizon's templates cleanly separated from
 * any other UI (notably booster-ui) that may share the same OAP. Names
 * that don't match the pattern are ignored — the BFF logs them at debug
 * level on each sync but never deletes or rewrites them.
 *
 * Equality for sync purposes is byte-exact on the *envelope* serialized
 * by `serializeEnvelope` below. Both ends MUST use this serializer so
 * key order is stable.
 */

export type TemplateKind = 'overview' | 'layer' | 'alert' | 'theme' | 'time-defaults';

export const TEMPLATE_KINDS: readonly TemplateKind[] = [
  'overview',
  'layer',
  'alert',
  'theme',
  'time-defaults',
] as const;

/** Single alert template key — alert page-setup is a singleton. */
export const ALERT_PAGE_SETUP_KEY = 'page-setup' as const;
/** Singleton key for the active theme selection. */
export const THEME_ACTIVE_KEY = 'active' as const;
/** Singleton key for the global time-defaults setup. */
export const TIME_DEFAULTS_KEY = 'global' as const;

// Source-row name (no `.i18n.` segment). Layer / overview keys are
// `[A-Za-z0-9_-]+` — no dots, so the `.i18n.` discriminator can't
// collide with a real key.
const SOURCE_NAME_RE = /^horizon\.(overview|layer|alert|theme|time-defaults)\.([A-Za-z0-9_-]+)$/;
// Per-locale overlay row. Locale segment matches BCP-47 forms shipped
// by Horizon today: `zh-CN`, `es`, `pt`, `ja`, `ko` (`en` has no row).
const OVERLAY_NAME_RE = /^horizon\.(overview|layer|alert|theme|time-defaults)\.([A-Za-z0-9_-]+)\.i18n\.([A-Za-z][A-Za-z0-9-]*)$/;

export interface ParsedName {
  kind: TemplateKind;
  key: string;
  /** Set on per-locale overlay rows (`…i18n.<locale>`). When set, the
   *  envelope's content is a translation overlay for {@link kind} +
   *  {@link key}; when unset, the envelope carries the source. */
  locale?: string;
}

export function formatName(kind: TemplateKind, key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error(`invalid template key for kind=${kind}: ${JSON.stringify(key)}`);
  }
  return `horizon.${kind}.${key}`;
}

/** Per-locale overlay name — sibling of the source row, e.g.
 *  `horizon.layer.MESH.i18n.zh-CN`. Locale is the BCP-47 tag the UI
 *  uses (`zh-CN`, `es`, …); English has no overlay row. */
export function formatOverlayName(kind: TemplateKind, key: string, locale: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error(`invalid template key for kind=${kind}: ${JSON.stringify(key)}`);
  }
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(locale)) {
    throw new Error(`invalid locale for overlay name: ${JSON.stringify(locale)}`);
  }
  return `horizon.${kind}.${key}.i18n.${locale}`;
}

export function parseName(name: string): ParsedName | null {
  // Try the overlay shape FIRST — its pattern is a strict superset
  // of the source pattern except for the `.i18n.<locale>` tail, so
  // matching it first is unambiguous.
  const overlay = OVERLAY_NAME_RE.exec(name);
  if (overlay) {
    return {
      kind: overlay[1] as TemplateKind,
      key: overlay[2]!,
      locale: overlay[3]!,
    };
  }
  const source = SOURCE_NAME_RE.exec(name);
  if (!source) return null;
  return { kind: source[1] as TemplateKind, key: source[2]! };
}

/** True for envelope names that carry a translation overlay (vs. source). */
export function isOverlayName(name: string): boolean {
  return OVERLAY_NAME_RE.test(name);
}

/** Envelope shape stored as the OAP `configuration` string.
 *
 *  Two flavors share this shape:
 *   - Source envelope — `name = horizon.<kind>.<key>`, `content` is the
 *     full template (widgets, slots, …) WITHOUT any embedded `i18n`.
 *   - Translation overlay envelope — `name = horizon.<kind>.<key>.i18n.<locale>`,
 *     `content` is the locale's translation overlay (a nested object
 *     keyed by translatable field paths, mirroring the source shape).
 *     `locale` is also surfaced top-level so a parser can route without
 *     re-running the name regex. */
export interface TemplateEnvelope<T = unknown> {
  name: string;
  kind: TemplateKind;
  /** Schema version for the envelope itself, not the inner content.
   *  Bump when this wrapper changes shape; never used to gate logic. */
  version: number;
  /** Set on per-locale overlay envelopes; absent on source envelopes. */
  locale?: string;
  content: T;
}

export const ENVELOPE_VERSION = 1 as const;

export function buildEnvelope<T>(kind: TemplateKind, key: string, content: T): TemplateEnvelope<T> {
  return {
    name: formatName(kind, key),
    kind,
    version: ENVELOPE_VERSION,
    content,
  };
}

/** Build a per-locale translation overlay envelope. The content shape
 *  is the source's translatable-leaf overlay (deep-merged at render
 *  time via mergeLocalizedNode). */
export function buildOverlayEnvelope<T>(
  kind: TemplateKind,
  key: string,
  locale: string,
  content: T,
): TemplateEnvelope<T> {
  return {
    name: formatOverlayName(kind, key, locale),
    kind,
    version: ENVELOPE_VERSION,
    locale,
    content,
  };
}

/** Stable JSON serializer — sorts object keys recursively so two
 *  envelopes with identical content always serialize byte-identically.
 *  OAP stores the string verbatim; if we don't normalize, every round
 *  trip looks "diverged." Arrays preserve order (they're meaningful). */
export function serializeEnvelope(envelope: TemplateEnvelope): string {
  return canonicalStringify(envelope);
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalStringify(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return '{' + parts.join(',') + '}';
}

/** Parse a configuration string from OAP into a Horizon envelope. Returns
 *  null for blobs that aren't ours (booster-ui shapes, hand-edited rows,
 *  legacy data) — callers must skip those. The returned `locale` is set
 *  iff the row is a per-locale overlay (`…i18n.<locale>`). */
export function parseEnvelope(configuration: string): TemplateEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const e = parsed as Record<string, unknown>;
  if (typeof e.name !== 'string' || typeof e.kind !== 'string') return null;
  const parsedName = parseName(e.name);
  if (!parsedName || parsedName.kind !== e.kind) return null;
  if (typeof e.version !== 'number') return null;
  if (e.content === undefined) return null;
  // For overlay envelopes the inner `locale` field must match the
  // name's locale segment — mismatched rows are corrupt and skipped.
  if (parsedName.locale !== undefined) {
    if (typeof e.locale !== 'string' || e.locale !== parsedName.locale) return null;
  }
  return {
    name: e.name,
    kind: parsedName.kind,
    version: e.version,
    locale: parsedName.locale,
    content: e.content,
  };
}
