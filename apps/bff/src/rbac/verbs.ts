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

// Verbs are dot-namespaced. Special grants:
//   `*`              → grants everything
//   `<area>:*`       → grants every action in an area (e.g. `rule:*`)
//   `*:read`         → grants read in every area
export type Verb = string;

export const VERBS = {
  // Public data reads — covered by `*:read` for the viewer baseline. Per-area
  // verbs let an admin grant read on one area without granting all reads.
  metricsRead: 'metrics:read',
  alarmsRead: 'alarms:read',
  tracesRead: 'traces:read',
  logsRead: 'logs:read',
  browserErrorsRead: 'browser-errors:read',
  /** AI AGENT conversations — the `AI_AGENT` layer's transcripts, landed by the
   *  AI Sessionizer. Its own area, not `ai:*`: `ai:read` is the ASSISTANT chat,
   *  where Horizon sends a conversation to a model provider; this is reading
   *  stored transcripts of other agents, and a deployment may allow either
   *  without the other. Under `*:read` like `logs:read`, whose payloads it
   *  resembles. */
  aiConversationRead: 'ai-conversation:read',
  eventsRead: 'events:read',
  topologyRead: 'topology:read',
  profileRead: 'profile:read',
  infra3dRead: 'infra-3d:read',

  ruleRead: 'rule:read',
  ruleWrite: 'rule:write',
  ruleWriteStructural: 'rule:write:structural',
  ruleDelete: 'rule:delete',
  /** See a RENDERED overview dashboard. Deliberately not a template verb:
   *  the overview pages an operator reads are not the stored rows the editor
   *  writes, and a viewer needs the former without the latter. */
  overviewRead: 'overview:read',

  // One read/write pair per "Dashboard setup" page. The pairs are per-page
  // rather than one `template:*` area because the pages are independently
  // grantable: an operator may curate translations without touching layer
  // dashboards. The stored row's KIND selects the pair on every write.
  overviewTemplateRead: 'overview-template:read',
  overviewTemplateWrite: 'overview-template:write',
  layerTemplateRead: 'layer-template:read',
  layerTemplateWrite: 'layer-template:write',
  translationRead: 'translation:read',
  translationWrite: 'translation:write',
  alarmSetupRead: 'alarm-setup:read',
  alarmSetupWrite: 'alarm-setup:write',
  infra3dSetupRead: 'infra-3d-setup:read',
  infra3dSetupWrite: 'infra-3d-setup:write',
  setupRead: 'setup:read',
  setupWrite: 'setup:write',
  alarmRuleRead: 'alarm-rule:read',
  alarmRuleWrite: 'alarm-rule:write',
  liveDebugRead: 'live-debug:read',
  liveDebugWrite: 'live-debug:write',
  /** Upload / delete browser-error source maps held in BFF memory. */
  sourceMapWrite: 'source-map:write',
  /** Single verb covering task-creation across all profiling families
   *  (agent / async / pprof / eBPF cpu / eBPF network). Reads ride on
   *  `*:read` via `profile:read`. */
  profileEnable: 'profile:enable',

  // Platform monitoring (read-only screens that focus on OAP itself).
  clusterRead: 'cluster:read',
  inspectRead: 'inspect:read',
  ttlRead: 'ttl:read',
  configRead: 'config:read',

  /** Use the AI assistant (chat). Read-tier: the assistant's own data tools
   *  each additionally check their underlying read verb, so the agent inherits
   *  the caller's read scopes — never widens them. */
  aiRead: 'ai:read',

  /** Connect an external agent over MCP. Separate from `ai:read` because the
   *  two differ in who runs the model: the assistant sends the conversation to
   *  the provider Horizon is configured with, while MCP leaves the model on
   *  the caller's side and Horizon only answers tool calls. A deployment can
   *  reasonably allow one and not the other. The same per-tool read verbs
   *  apply on both paths. */
  mcpRead: 'mcp:read',

  /** Read the login audit log. See WILDCARD_EXEMPT_VERBS — this one is NOT
   *  reachable through `*:read`. */
  auditRead: 'audit:read',

  userRead: 'user:read',
  userWrite: 'user:write',
  roleRead: 'role:read',
  roleWrite: 'role:write',
  authRead: 'auth:read',
  admin: 'admin',
} as const;

export type KnownVerb = (typeof VERBS)[keyof typeof VERBS];

/**
 * Declared, but nothing checks them: no route in `ROUTE_POLICY`, no in-handler
 * check, no UI gate. Granting one neither opens nor closes anything today, so
 * the Roles board renders them marked instead of as capabilities. They keep
 * their names so a `horizon.yaml` that already lists one still validates, and
 * so the name is stable if a capability ever binds to it.
 *
 * `alarm-rule:write` has nothing to bind to: OAP's alarm-rule catalog is
 * read-only upstream (rules change in its YAML + watcher reload), so Horizon
 * has no write to gate.
 *
 * `verb-enforcement.test.ts` re-derives this list from the policy sources —
 * a verb that gains (or loses) an enforcement site fails the test until this
 * list is updated.
 */
export const RESERVED_VERBS: readonly Verb[] = [
  'alarm-rule:write',
  'role:write',
  'user:write',
];

/**
 * Verbs a WILDCARD may not reach. Only a bare `*`, `admin`, or the exact verb
 * grants one.
 *
 * `audit:read` is here because the ordinary grammar cannot contain it. A verb
 * shaped `<area>:read` is matched by `*:read`, which is a documented role
 * recipe, and `SCOPE_VERBS['horizon:read']` — the DEFAULT OAuth scope — maps
 * to exactly that. Without this set, enabling an optional audit log would
 * silently hand every read-only MCP client and every `*:read` role the full
 * login history: usernames, verified email addresses, source addresses, and
 * internal cluster addressing. The consent screen renders that scope as the
 * single line `*:read` and names none of it.
 *
 * So the containment is built rather than declared. Keep the set small: each
 * entry is a place the grammar stops being uniform, and that is only worth it
 * where a wildcard grant would leak something an operator would not expect.
 */
export const WILDCARD_EXEMPT_VERBS: ReadonlySet<Verb> = new Set<Verb>(['audit:read']);

/**
 * Verbs retired by the per-page Dashboard-setup split, mapped to what they
 * used to gate. An unrecognised verb grants nothing silently, so without this
 * an upgraded `horizon.yaml` naming a retired verb would quietly stop working
 * — the role would still load, the buttons would still render, and the save
 * would 403.
 *
 * `overview:write` gated five of the six setup pages, so it expands to both
 * halves of each: whoever could edit those pages could necessarily read them.
 * `overview:read` is NOT here — it survives as the render verb, and expanding
 * it to the template reads would hand every viewer the editor content the
 * split exists to withhold.
 */
export const VERB_ALIASES: Readonly<Record<string, readonly Verb[]>> = {
  'dashboard:read': ['layer-template:read'],
  'dashboard:write': ['layer-template:write'],
  'overview:write': [
    'overview-template:read',
    'overview-template:write',
    'translation:read',
    'translation:write',
    'alarm-setup:read',
    'alarm-setup:write',
    'infra-3d-setup:read',
    'infra-3d-setup:write',
    'setup:read',
    'setup:write',
  ],
};

/**
 * Retired AREA wildcards. `overview:*` and `dashboard:*` used to reach the
 * setup pages through the retired verbs; with those gone the wildcard still
 * parses (both areas still exist) so nothing would report the loss — it would
 * simply stop granting. Expanded like an exact alias.
 */
const RETIRED_AREA_ALIASES: Readonly<Record<string, readonly Verb[]>> = {
  'dashboard:*': ['layer-template:read', 'layer-template:write'],
  'overview:*': VERB_ALIASES['overview:write'] ?? [],
};

/** What one configured grant additionally confers, retired names included. */
function aliasesFor(grant: string): readonly Verb[] {
  if (Object.hasOwn(VERB_ALIASES, grant)) return VERB_ALIASES[grant]!;
  if (Object.hasOwn(RETIRED_AREA_ALIASES, grant)) return RETIRED_AREA_ALIASES[grant]!;
  return [];
}

/**
 * A grant limited to one layer, and optionally to OAP service groups in it:
 * `metrics:read@GENERAL`, `metrics:read@GENERAL[payments,risk]`. The groups
 * are OAP `Service.group` values (the `<group>::` prefix); `-` names the
 * services that have no group.
 */
export interface LayerQualifier {
  /** Upper-cased as written; the access check canonicalises aliases. */
  layer: string;
  /** Absent = the whole layer. `''` is the ungrouped services. */
  groups?: readonly string[];
}

export interface ParsedGrant {
  verb: Verb;
  qualifier?: LayerQualifier;
}

/** How a grant spells "the services with no group". */
export const UNGROUPED_GRANT = '-';

/**
 * The verbs a layer qualifier means something on: their data belongs to one
 * service, so "which layer, which group" has an answer. Any other verb written
 * with `@` grants nothing — `cluster:read@GENERAL` or `overview:read@GENERAL`
 * would promise a narrowing no route could enforce. `layer-grants.test.ts`
 * checks every `/api/layer/:key/` route's verb is listed here.
 */
export const LAYER_SCOPED_VERBS: ReadonlySet<Verb> = new Set<Verb>([
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

/** The verbs that open a layer PAGE — a sidebar entry is shown to a caller
 *  who holds one of them on that layer. Alarms and events have pages of their
 *  own, and `profile:enable` only acts on a page something else opened. */
export const LAYER_PAGE_VERBS: readonly Verb[] = [
  'metrics:read',
  'traces:read',
  'logs:read',
  'topology:read',
  'profile:read',
  'browser-errors:read',
  'ai-conversation:read',
];

const QUALIFIER = /^([A-Za-z0-9_]+)(?:\[([^\]]*)\])?$/;

/**
 * Split a grant into its verb and its layer qualifier. `null` for a malformed
 * qualifier (`metrics:read@`, `@GENERAL[]`, `@GENERAL[a,,b]`, anything after
 * the `]`), which grants nothing — a typo must not confer the whole layer.
 */
export function parseGrant(grant: string): ParsedGrant | null {
  const at = grant.indexOf('@');
  if (at < 0) return { verb: grant };
  const verb = grant.slice(0, at);
  const m = QUALIFIER.exec(grant.slice(at + 1));
  if (!verb || !m) return null;
  const layer = m[1]!.toUpperCase();
  if (m[2] === undefined) return { verb, qualifier: { layer } };
  const groups = m[2].split(',').map((g) => g.trim());
  if (groups.some((g) => g === '')) return null;
  return {
    verb,
    qualifier: { layer, groups: groups.map((g) => (g === UNGROUPED_GRANT ? '' : g)) },
  };
}

/**
 * Does a layer grant's VERB part cover `required`? `*@GENERAL` covers every
 * layer-scoped verb on GENERAL; `admin@GENERAL` covers nothing — the sentinel
 * means "everything", and everything has no layer.
 */
export function qualifiedVerbCovers(grant: ParsedGrant, required: Verb): boolean {
  if (!grant.qualifier || grant.verb === 'admin' || !LAYER_SCOPED_VERBS.has(required)) return false;
  return grant.verb === '*' || matchOne(grant.verb, required);
}

/** True for a grant the verb grammar accepts even though it names no known
 *  verb: the wildcards, and any retired name still expanded by VERB_ALIASES.
 *  Used by the boot-time warning so it does not flag the stock `admin` role.
 *  A layer grant is recognised only when it covers a layer-scoped verb. */
export function isGrantRecognised(grant: string): boolean {
  if (grant.includes('@')) {
    const parsed = parseGrant(grant);
    if (!parsed?.qualifier) return false;
    return [...LAYER_SCOPED_VERBS].some((v) => qualifiedVerbCovers(parsed, v));
  }
  if (grant === '*' || grant === 'admin') return true;
  if (aliasesFor(grant).length > 0) return true;
  // Ask the matcher itself rather than re-deriving the grammar beside it: a
  // second parser drifts, and this one drifted three ways — it missed the
  // retired area wildcards, ignored sub-actions (`*:read:typo` passed), and
  // did not know about WILDCARD_EXEMPT_VERBS (`audit:*` passed while granting
  // nothing). Recognised means "grants at least one verb this build has".
  return (Object.values(VERBS) as Verb[]).some((v) => matchOne(grant, v));
}

function matchOne(grant: Verb, required: Verb): boolean {
  // A layer-limited grant never answers a question that has no layer in it:
  // `metrics:read@GENERAL` must not open the overview or the 3D map.
  if (grant.includes('@')) return false;
  if (grant === '*' || grant === 'admin') return true;
  if (grant === required) return true;
  if (WILDCARD_EXEMPT_VERBS.has(required)) return false;
  // The grammar is at most three segments. `split(':', 3)` TRUNCATES rather
  // than failing, so without this a fourth segment is silently dropped and
  // `rule:write:structural:typo` grants `rule:write:structural` — a typo that
  // confers authority instead of none.
  if (grant.split(':').length > 3) return false;
  // `area:*` matches any verb in that area (and any sub-action — `rule:*` covers `rule:write:structural`)
  const [grantArea, grantAction, grantSub] = grant.split(':', 3);
  const [reqArea, reqAction, reqSub] = required.split(':', 3);
  // `grantSub` must be absent: `rule:*:typo` is not a narrower `rule:*`, it is
  // malformed, and reading it as the area wildcard grants the whole area.
  if (grantArea === reqArea && grantAction === '*' && grantSub === undefined) return true;
  // `*:action` matches that action in any area
  if (grantArea === '*' && grantAction === reqAction && (grantSub ?? '') === (reqSub ?? '')) return true;
  // Sub-action exact match (e.g. grant `rule:write:structural` only matches itself)
  if (grantArea === reqArea && grantAction === reqAction && (grantSub ?? '') === (reqSub ?? ''))
    return true;
  return false;
}

export function hasVerb(grantedVerbs: readonly Verb[], required: Verb): boolean {
  for (const g of grantedVerbs) if (matchOne(g, required)) return true;
  return false;
}

export function resolveVerbsForRoles(
  rolePolicy: Record<string, string[]>,
  userRoles: readonly string[],
  rbacEnabled: boolean,
): Verb[] {
  if (!rbacEnabled) return ['*'];
  const set = new Set<Verb>();
  for (const r of userRoles)
    for (const v of rolePolicy[r] ?? []) {
      set.add(v);
      // Retired names expand only when written plain: `dashboard:read@X`
      // names no layer verb, and expanding it would hand out an UNQUALIFIED
      // `layer-template:read` from a grant that asked for one layer.
      for (const a of aliasesFor(v)) set.add(a);
    }
  return [...set];
}

/**
 * What a grant still confers under an OAuth scope's cap. A cap is a set of
 * PLAIN verbs and narrows by verb, never by layer: `metrics:*@GENERAL` under
 * `*:read` is `metrics:read@GENERAL`. A plain grant is returned as it is —
 * the gate intersects it with the cap on every check.
 */
export function capGrant(grant: Verb, cap: readonly Verb[] | undefined): Verb[] {
  if (!cap || !grant.includes('@')) return [grant];
  const parsed = parseGrant(grant);
  if (!parsed?.qualifier) return [];
  if (hasVerb(cap, parsed.verb)) return [grant];
  const where = grant.slice(grant.indexOf('@'));
  return [...LAYER_SCOPED_VERBS].filter((v) => qualifiedVerbCovers(parsed, v) && hasVerb(cap, v)).map((v) => `${v}${where}`);
}

/** Does any grant cover `required`, plain or on some layer? The route gate
 *  asks this for a route that names a layer or a service, so a user whose
 *  only grant is `metrics:read@GENERAL` reaches the handler; which layer and
 *  which service they may read is decided per request after that. */
export function hasVerbOnSomeLayer(grantedVerbs: readonly Verb[], required: Verb): boolean {
  if (hasVerb(grantedVerbs, required)) return true;
  for (const g of grantedVerbs) {
    const parsed = g.includes('@') ? parseGrant(g) : null;
    if (parsed && qualifiedVerbCovers(parsed, required)) return true;
  }
  return false;
}
