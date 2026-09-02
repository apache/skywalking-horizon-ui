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
 * Which verb pair guards a stored template row.
 *
 * The `ui_template` store holds every Dashboard-setup page's config behind one
 * set of routes, so the ROUTE_POLICY table cannot express the gate on its own —
 * a single URL serves six independently-grantable pages. The routes are
 * therefore policy-gated `'auth'` and resolve the verb per ROW, here, from the
 * kind the name parses to.
 *
 * A per-locale overlay row belongs to the Translations page whatever it
 * translates: curating wording is not the same authority as changing what a
 * layer dashboard queries.
 */

import type { TemplateKind } from '../logic/templates/names.js';
import type { HorizonConfig } from '../config/schema.js';
import { sessionHasVerb, type VerbSubject } from './policy.js';
import type { Verb } from './verbs.js';

export interface VerbPair {
  read: Verb;
  write: Verb;
}

const BY_KIND: Readonly<Record<TemplateKind, VerbPair>> = {
  overview: { read: 'overview-template:read', write: 'overview-template:write' },
  layer: { read: 'layer-template:read', write: 'layer-template:write' },
  alert: { read: 'alarm-setup:read', write: 'alarm-setup:write' },
  theme: { read: 'setup:read', write: 'setup:write' },
  'time-defaults': { read: 'setup:read', write: 'setup:write' },
  'infra-3d': { read: 'infra-3d-setup:read', write: 'infra-3d-setup:write' },
};

const TRANSLATION: VerbPair = { read: 'translation:read', write: 'translation:write' };

/** The pair guarding one row. `locale` set marks a translation overlay. */
export function templateVerbs(kind: TemplateKind, locale?: string): VerbPair {
  return locale === undefined ? BY_KIND[kind] : TRANSLATION;
}

/** Every read verb that reaches some part of the template store. A caller
 *  holding none of these has no business on any Dashboard-setup page. */
export const TEMPLATE_READ_VERBS: readonly Verb[] = [
  ...new Set([...Object.values(BY_KIND).map((p) => p.read), TRANSLATION.read]),
];

/** Every write verb, for the same reason on the mutating routes. */
export const TEMPLATE_WRITE_VERBS: readonly Verb[] = [
  ...new Set([...Object.values(BY_KIND).map((p) => p.write), TRANSLATION.write]),
];

/** The kinds the Translations page lists, and so the only source rows a
 *  translation reader has business seeing. */
const TRANSLATABLE_KINDS: ReadonlySet<TemplateKind> = new Set(['overview', 'layer']);

/**
 * May this session be told about this row?
 *
 * The one answer both the admin surface and the config bundle ask, so a
 * translator cannot be handed rows on one route and denied their badges on
 * the other. Its own read verb, or — for a SOURCE row of a kind the
 * Translations page lists — `translation:read`, because the page shows the
 * source string beside each translation. Reading a source is not writing one.
 */
export function canReadTemplateRow(
  config: HorizonConfig,
  session: VerbSubject | undefined,
  row: { kind: TemplateKind; locale?: string },
): boolean {
  if (!session) return false;
  if (sessionHasVerb(config, session, templateVerbs(row.kind, row.locale).read)) return true;
  return (
    row.locale === undefined &&
    TRANSLATABLE_KINDS.has(row.kind) &&
    sessionHasVerb(config, session, templateVerbs(row.kind, 'i18n').read)
  );
}
