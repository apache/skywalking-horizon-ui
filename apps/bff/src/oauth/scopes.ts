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
 * Scopes, and what they mean here.
 *
 * A scope names a set of Horizon verbs, and the token that carries it holds the
 * INTERSECTION of that set with whatever its user's roles grant. Both halves
 * matter and neither is redundant:
 *
 *  - the roles say what this person may ever see, and are re-read per request;
 *  - the scope says how much of that they agreed to lend this client, on the
 *    consent screen, once.
 *
 * So `horizon:full` granted by a viewer is still a viewer, and `horizon:read`
 * granted by an admin is a read-only agent. The default is `horizon:read`,
 * because an agent connecting for the first time should not silently arrive
 * holding an operator's write verbs.
 */

import type { HorizonConfig } from '../config/schema.js';
import { hasVerb } from '../rbac/verbs.js';

export const DEFAULT_SCOPE = 'horizon:read';

/** Two scopes, not a scope per verb. A consent screen listing thirty
 *  permissions is one nobody reads, and the verbs are already enforced
 *  per-tool underneath — the scope answers "read, or read and change?". */
export const SCOPE_VERBS: Record<string, string[]> = {
  'horizon:read': ['*:read'],
  // No cap at all — this token is exactly its user's own access. Distinct from
  // listing every write verb, which would silently omit any verb added later.
  'horizon:full': ['*'],
};

export function knownScopes(): string[] {
  return Object.keys(SCOPE_VERBS);
}

/**
 * Parse a space-delimited `scope` parameter into the granted set.
 *
 * An unknown scope is REFUSED rather than dropped: silently narrowing a request
 * gives the client a token that fails later, somewhere unrelated, with no clue
 * that its scope was not the one it asked for.
 */
export function parseScope(raw: string | undefined): { scopes: string[]; unknown?: string } {
  const asked = (raw ?? '').split(/\s+/).filter(Boolean);
  if (asked.length === 0) return { scopes: [DEFAULT_SCOPE] };
  const bad = asked.find((s) => !(s in SCOPE_VERBS));
  if (bad) return { scopes: [], unknown: bad };
  return { scopes: asked };
}

/** The verb cap a granted scope set imposes. `undefined` means no cap — the
 *  credential is exactly its user's access. */
export function verbCapFor(scopes: readonly string[]): string[] | undefined {
  if (scopes.includes('horizon:full')) return undefined;
  return [...new Set(scopes.flatMap((s) => SCOPE_VERBS[s] ?? []))];
}

/**
 * What the consent screen says a scope will let the agent do, as verbs the
 * signed-in user actually holds. Showing the scope's whole set would promise
 * access the user cannot delegate — a viewer consenting to `horizon:full`
 * should not read "change alarm rules" on the way.
 */
export function grantedVerbs(config: HorizonConfig, roles: readonly string[], scopes: readonly string[]): string[] {
  const owned = new Set<string>();
  for (const r of roles) for (const v of config.rbac.roles[r] ?? []) owned.add(v);
  if (!config.rbac.enabled || owned.has('*') || owned.has('admin')) {
    // An admin (or RBAC-off) holds everything, so the scope alone describes it.
    return scopes.includes('horizon:full') ? ['*'] : ['*:read'];
  }
  const cap = verbCapFor(scopes);
  if (!cap) return [...owned].sort();
  // Filter with the SAME matcher the gate uses. A hand-rolled test here read
  // `metrics:*` as matching nothing, so a role granted a whole area was shown
  // fewer permissions than the grant actually carried — the one direction a
  // consent screen must never be wrong in.
  return [...owned].filter((v) => hasVerb(cap, v)).sort();
}
