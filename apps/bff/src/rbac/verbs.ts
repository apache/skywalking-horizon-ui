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
  ruleRead: 'rule:read',
  ruleWrite: 'rule:write',
  ruleWriteStructural: 'rule:write:structural',
  ruleDelete: 'rule:delete',
  ruleDebug: 'rule:debug',
  clusterRead: 'cluster:read',
  inspectRead: 'inspect:read',
  dashboardRead: 'dashboard:read',
  dashboardWrite: 'dashboard:write',
  userRead: 'user:read',
  userWrite: 'user:write',
  roleRead: 'role:read',
  roleWrite: 'role:write',
  auditRead: 'audit:read',
  alarmRuleRead: 'alarm-rule:read',
  alarmRuleWrite: 'alarm-rule:write',
  admin: 'admin',
} as const;

export type KnownVerb = (typeof VERBS)[keyof typeof VERBS];

function matchOne(grant: Verb, required: Verb): boolean {
  if (grant === '*' || grant === 'admin') return true;
  if (grant === required) return true;
  // `area:*` matches any verb in that area
  const [grantArea, grantAction] = grant.split(':', 2);
  const [reqArea, reqAction] = required.split(':', 2);
  if (grantAction === '*' && grantArea === reqArea) return true;
  // `*:action` matches any area for that action
  if (grantArea === '*' && grantAction === reqAction) return true;
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
