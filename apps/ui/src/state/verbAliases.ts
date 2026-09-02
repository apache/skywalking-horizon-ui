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
 * The UI's copy of the BFF's `VERB_ALIASES` + retired area wildcards
 * (`apps/bff/src/rbac/verbs.ts`), which is the source of truth.
 *
 * The session's own verbs arrive already expanded, so the app gate never needs
 * this. The Roles board does: it reads RAW role grants out of the policy to
 * tabulate what each role can reach, so without the aliases it reports the new
 * setup pages as denied for a role that works perfectly at runtime — and that
 * board is what an administrator plans access around.
 *
 * `verbAliases.test.ts` fails if this drifts from the BFF's tables.
 */
export const VERB_ALIASES: Readonly<Record<string, readonly string[]>> = {
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
  'dashboard:*': ['layer-template:read', 'layer-template:write'],
  'overview:*': [
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

/** What one configured grant additionally confers. `hasOwnProperty` rather
 *  than `in`: a role may legally grant a string like `toString`, which would
 *  otherwise resolve to a prototype member and blow up the caller. */
export function aliasesFor(grant: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(VERB_ALIASES, grant) ? VERB_ALIASES[grant]! : [];
}
