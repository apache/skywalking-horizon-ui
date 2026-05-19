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
 * Naming:
 *   - `horizon.overview.<id>`        — overview dashboards (e.g. `services`, `mesh`)
 *   - `horizon.layer.<KEY>`          — layer dashboards (e.g. `GENERAL`, `K8S`)
 *   - `horizon.alert.page-setup`     — alert page setup (singleton)
 *   - `horizon.theme.active`         — org-default theme selection (singleton)
 *   - `horizon.time-defaults.global` — global time-picker default window (singleton)
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

const NAME_RE = /^horizon\.(overview|layer|alert|theme|time-defaults)\.([A-Za-z0-9_-]+)$/;

export interface ParsedName {
  kind: TemplateKind;
  key: string;
}

export function formatName(kind: TemplateKind, key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error(`invalid template key for kind=${kind}: ${JSON.stringify(key)}`);
  }
  return `horizon.${kind}.${key}`;
}

export function parseName(name: string): ParsedName | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return { kind: m[1] as TemplateKind, key: m[2]! };
}

/** Envelope shape stored as the OAP `configuration` string. */
export interface TemplateEnvelope<T = unknown> {
  name: string;
  kind: TemplateKind;
  /** Schema version for the envelope itself, not the inner content.
   *  Bump when this wrapper changes shape; never used to gate logic. */
  version: number;
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
 *  legacy data) — callers must skip those. */
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
  return {
    name: e.name,
    kind: parsedName.kind,
    version: e.version,
    content: e.content,
  };
}
