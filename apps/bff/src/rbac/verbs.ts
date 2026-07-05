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
  eventsRead: 'events:read',
  topologyRead: 'topology:read',
  profileRead: 'profile:read',
  infra3dRead: 'infra-3d:read',

  ruleRead: 'rule:read',
  ruleWrite: 'rule:write',
  ruleWriteStructural: 'rule:write:structural',
  ruleDelete: 'rule:delete',
  ruleDebug: 'rule:debug',
  dashboardRead: 'dashboard:read',
  dashboardWrite: 'dashboard:write',
  overviewRead: 'overview:read',
  overviewWrite: 'overview:write',
  setupRead: 'setup:read',
  setupWrite: 'setup:write',
  alarmSetupRead: 'alarm-setup:read',
  alarmSetupWrite: 'alarm-setup:write',
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

  userRead: 'user:read',
  userWrite: 'user:write',
  roleRead: 'role:read',
  roleWrite: 'role:write',
  authRead: 'auth:read',
  auditRead: 'audit:read',
  admin: 'admin',
} as const;

export type KnownVerb = (typeof VERBS)[keyof typeof VERBS];

function matchOne(grant: Verb, required: Verb): boolean {
  if (grant === '*' || grant === 'admin') return true;
  if (grant === required) return true;
  // `area:*` matches any verb in that area (and any sub-action — `rule:*` covers `rule:write:structural`)
  const [grantArea, grantAction, grantSub] = grant.split(':', 3);
  const [reqArea, reqAction, reqSub] = required.split(':', 3);
  if (grantArea === reqArea && grantAction === '*') return true;
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
  for (const r of userRoles) for (const v of rolePolicy[r] ?? []) set.add(v);
  return [...set];
}
