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
 * the overview and alarm-page resolvers build one from the content `id`, and
 * the singleton kinds have exactly one key each. So a row stored under any
 * other spelling — a lower-case layer key, an OAP legacy alias (`CACHE` where
 * the runtime reads `VIRTUAL_CACHE`), an overview whose content `id` is not
 * the row's, the default alarm page under its retired `page-setup` key — is
 * reachable by nobody, however successful the push looked; and a row whose
 * content declares a different identity would otherwise render as some OTHER
 * template, which is the worse half: not an orphan, a dashboard served under a
 * name that is not its own.
 *
 * {@link templateIdentityIssue} is that rule, and the only copy of it. The
 * publish routes refuse on it; the sync layer applies it to what OAP already
 * holds, both reporting those rows (`unreadable`) and giving them
 * `effective: null` so no read path serves them. Refusing to publish one and
 * declining to read one are the same rule, so the two sides cannot drift.
 */

import {
  ALERT_DEFAULT_KEY,
  ALERT_RETIRED_KEY,
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
  theme: THEME_ACTIVE_KEY,
  'time-defaults': TIME_DEFAULTS_KEY,
  'infra-3d': INFRA3D_CONFIG_KEY,
};

/** The key `kind` is read under. Overview and alarm-page ids are matched
 *  verbatim by their readers, so they are their own canonical form. The
 *  default alarm page's retired key folds to the one it is read under now, so
 *  a row left there is reported as misnamed; its content is never read or
 *  moved. */
export function canonicalTemplateKey(kind: TemplateKind, key: string): string {
  if (kind === 'layer') return canonicalLayerKey(key);
  if (kind === 'alert') return key === ALERT_RETIRED_KEY ? ALERT_DEFAULT_KEY : key;
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

/** The content field that declares what a row of `kind` under `key` is: a
 *  layer's `key`, an overview's or a named alarm page's `id`. The default alarm
 *  page and the singleton kinds carry none. */
function identityField(kind: TemplateKind, key: string): 'key' | 'id' | null {
  if (kind === 'layer') return 'key';
  if (kind === 'overview') return 'id';
  if (kind === 'alert') return key === ALERT_DEFAULT_KEY ? null : 'id';
  return null;
}

/** What the content says it is. `null` when absent or not a string — that is
 *  the per-kind schema's finding to report, not this one's. */
function declaredIdentity(field: 'key' | 'id' | null, content: unknown): string | null {
  if (!field || !content || typeof content !== 'object') return null;
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
  const field = identityField(kind, key);
  const declared = declaredIdentity(field, content);
  if (declared !== null && declared !== canonical) {
    return {
      path: field ?? 'id',
      message: `"${declared}" is not the ${kind === 'alert' ? 'alarm page' : kind} this is published as (${canonicalName})`,
    };
  }
  return null;
}
