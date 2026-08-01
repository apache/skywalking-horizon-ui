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
 * One rule, both sides of the store: **a template is the thing it is stored
 * as.** Its OAP row carries the name its readers compute, and its content
 * declares that same identity.
 *
 * No reader searches for a near miss. The layer resolver and the sidebar menu
 * each build ONE name from the canonical layer key ({@link canonicalLayerKey}),
 * the overview resolver builds one from the dashboard `id`, and the singleton
 * kinds have exactly one key each. So a row stored under any other spelling —
 * a lower-case layer key, an OAP legacy alias (`CACHE` where the runtime reads
 * `VIRTUAL_CACHE`), an overview whose content `id` is not the row's — is
 * reachable by nobody, however successful the push looked; and a row whose
 * content declares a different identity renders as some OTHER template.
 *
 * {@link templateIdentityIssue} is that rule, and the only copy of it: the
 * publish routes refuse on it, and the sync status reports the rows on OAP
 * that already carry it (`unreadable`), so the two sides cannot drift.
 */

import {
  ALERT_PAGE_SETUP_KEY,
  INFRA3D_CONFIG_KEY,
  THEME_ACTIVE_KEY,
  TIME_DEFAULTS_KEY,
  formatName,
  type TemplateKind,
} from './names.js';

/** Legacy enum values OAP keeps for backward compatibility. The sidebar
 *  collapses each to its modern equivalent, so that — not the legacy spelling
 *  — is the key every template reader holds. */
const LAYER_ALIAS: Record<string, string> = {
  CACHE: 'VIRTUAL_CACHE',
  DATABASE: 'VIRTUAL_DATABASE',
  MQ: 'VIRTUAL_MQ',
  GENAI: 'VIRTUAL_GENAI',
};

/** The layer key Horizon addresses a layer by: UPPER_SNAKE, aliases collapsed.
 *  Used to build every layer template name AND to fold the raw OAP layer list,
 *  so the two agree by construction. */
export function canonicalLayerKey(key: string): string {
  const upper = key.toUpperCase();
  return LAYER_ALIAS[upper] ?? upper;
}

/** Kinds whose store holds exactly one row, under a fixed key. */
const SINGLETON_KEY: Partial<Record<TemplateKind, string>> = {
  alert: ALERT_PAGE_SETUP_KEY,
  theme: THEME_ACTIVE_KEY,
  'time-defaults': TIME_DEFAULTS_KEY,
  'infra-3d': INFRA3D_CONFIG_KEY,
};

/** The key `kind` is read under. Overview ids are matched verbatim by their
 *  readers, so they are their own canonical form. */
export function canonicalTemplateKey(kind: TemplateKind, key: string): string {
  if (kind === 'layer') return canonicalLayerKey(key);
  return SINGLETON_KEY[kind] ?? key;
}

export interface TemplateIdentityIssue {
  /** Dotted path, in the same shape the schema checks report: `name` for the
   *  row's own name, `key` / `id` for the identity the content declares. */
  path: string;
  /** Self-contained: states which of the two is wrong and names the readable
   *  form, so a caller can show it without composing anything further. */
  message: string;
}

/** What the content says it is: a layer's `key`, an overview's `id`. The
 *  singleton kinds carry no identity field. `null` when absent or not a
 *  string — that is the per-kind schema's finding to report, not this one's. */
function declaredIdentity(kind: TemplateKind, content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const field = kind === 'layer' ? 'key' : kind === 'overview' ? 'id' : null;
  if (!field) return null;
  const value = (content as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The rule. `key` is the row's key (the tail of `horizon.<kind>.<key>`),
 * `content` the inner template. Returns the single reason this pair is not
 * readable, or `null` when it is.
 */
export function templateIdentityIssue(
  kind: TemplateKind,
  key: string,
  content: unknown,
): TemplateIdentityIssue | null {
  const canonical = canonicalTemplateKey(kind, key);
  const canonicalName = formatName(kind, canonical);
  if (key !== canonical) {
    return {
      path: 'name',
      message: `"${formatName(kind, key)}" is not a name Horizon reads — publish it as "${canonicalName}"`,
    };
  }
  // Exact, not "canonicalises to the same thing": readers take the declared
  // value VERBATIM in places the row name never reaches — the config bundle
  // files a layer's widget sets under the key its content reports, the overview
  // list carries each dashboard's own `id` — so an alias here is filed under a
  // key no page asks for, even in a correctly-named row.
  const declared = declaredIdentity(kind, content);
  if (declared !== null && declared !== canonical) {
    return {
      path: kind === 'layer' ? 'key' : 'id',
      message: `"${declared}" is not the ${kind} this is published as (${canonicalName})`,
    };
  }
  return null;
}
