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
 * The UI's copy of the BFF's verb grammar (`apps/bff/src/rbac/verbs.ts`, plus
 * the layer-key fold from `logic/templates/identity.ts`). The BFF is the source
 * of truth and the only side that enforces. The auth store's gate and the Roles
 * board both answer through this module, so they cannot disagree with each
 * other; `verbGrammar.test.ts` fails if the lists here drift from the BFF's.
 */

import { WILDCARD_EXEMPT_VERBS } from './wildcardExempt';

/**
 * Does one PLAIN grant cover `required`? A layer-limited grant never answers a
 * question that has no layer in it: `metrics:read@GENERAL` must not open the
 * overview or the 3D map.
 */
export function matchOne(grant: string, required: string): boolean {
  if (grant.includes('@')) return false;
  if (grant === '*' || grant === 'admin' || grant === required) return true;
  // After the exact / `*` / `admin` grants and BEFORE both wildcard branches,
  // so `*:read` and `audit:*` are equally denied.
  if (WILDCARD_EXEMPT_VERBS.has(required)) return false;
  // A fourth segment is malformed rather than truncated, and `area:*` carries
  // no sub-segment.
  if (grant.split(':').length > 3) return false;
  const [ga, gact, gsub] = grant.split(':', 3);
  const [ra, ract, rsub] = required.split(':', 3);
  if (ga === ra && gact === '*' && gsub === undefined) return true;
  if (ga === '*' && gact === ract && (gsub ?? '') === (rsub ?? '')) return true;
  return ga === ra && gact === ract && (gsub ?? '') === (rsub ?? '');
}

export function hasPlainVerb(grants: readonly string[], required: string): boolean {
  return grants.some((g) => matchOne(g, required));
}

/** The verbs a layer qualifier means something on. Any other verb written with
 *  `@` grants nothing. */
export const LAYER_SCOPED_VERBS: ReadonlySet<string> = new Set([
  'metrics:read',
  'traces:read',
  'logs:read',
  'browser-errors:read',
  'ai-conversation:read',
  'events:read',
  'alarms:read',
  'topology:read',
  'profile:read',
  'profile:enable',
]);

/** How a grant spells "the services with no OAP group". */
export const UNGROUPED_GRANT = '-';

export interface LayerGrant {
  verb: string;
  /** Upper-cased as written; compare through {@link canonicalLayerKey}. */
  layer: string;
  /** Absent = the whole layer. `''` is the ungrouped services. */
  groups?: readonly string[];
}

const QUALIFIER = /^([A-Za-z0-9_]+)(?:\[([^\]]*)\])?$/;

/**
 * Split `<verb>@<LAYER>[group,…]`. `null` for a plain grant AND for a malformed
 * qualifier (`metrics:read@`, `@GENERAL[]`, `@GENERAL[a,,b]`), which grants
 * nothing — a typo must not confer the whole layer.
 */
export function parseLayerGrant(grant: string): LayerGrant | null {
  const at = grant.indexOf('@');
  if (at < 0) return null;
  const verb = grant.slice(0, at);
  const m = QUALIFIER.exec(grant.slice(at + 1));
  if (!verb || !m) return null;
  const layer = m[1].toUpperCase();
  if (m[2] === undefined) return { verb, layer };
  const groups = m[2].split(',').map((g) => g.trim());
  if (groups.some((g) => g === '')) return null;
  return { verb, layer, groups: groups.map((g) => (g === UNGROUPED_GRANT ? '' : g)) };
}

/** Does a layer grant's VERB part cover `required`? `*@X` covers every
 *  layer-scoped verb on X; `admin@X` covers nothing, since the sentinel means
 *  everything and everything has no layer. */
export function layerGrantCovers(grant: LayerGrant, required: string): boolean {
  if (grant.verb === 'admin' || !LAYER_SCOPED_VERBS.has(required)) return false;
  return grant.verb === '*' || matchOne(grant.verb, required);
}

/** Legacy layer enum values OAP keeps; a grant may name either spelling. */
export const LAYER_ALIAS: Readonly<Record<string, string>> = {
  CACHE: 'VIRTUAL_CACHE',
  DATABASE: 'VIRTUAL_DATABASE',
  MQ: 'VIRTUAL_MQ',
  GENAI: 'VIRTUAL_GENAI',
};

export function canonicalLayerKey(key: string): string {
  const upper = key.toUpperCase();
  return LAYER_ALIAS[upper] ?? upper;
}
