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
 * Verb-check helper consumed by the auth middleware. The actual Fastify
 * pre-handlers live in `user/middleware.ts` — this file only knows about
 * resolving a session's effective verbs against the role policy table.
 */

import type { HorizonConfig } from '../config/schema.js';
import { hasVerb, resolveVerbsForRoles } from './verbs.js';

/**
 * Whoever a verb is being checked FOR. Takes the session rather than its roles
 * so a caller cannot check the roles and forget the cap — there is no
 * roles-only overload to reach for, which is the point.
 */
export interface VerbSubject {
  roles: readonly string[];
  /**
   * An OAuth scope's CAP, when the credential came from one. Effective verbs
   * are the INTERSECTION of what the user's roles grant and what the operator
   * consented to give this client, so a scope can only ever narrow: an agent
   * granted `horizon:full` by someone who is a viewer is still a viewer.
   * Absent (a browser session, an API token) means no cap.
   */
  verbCap?: readonly string[];
}

export function sessionHasVerb(
  config: HorizonConfig,
  subject: VerbSubject,
  required: string,
): boolean {
  const verbs = resolveVerbsForRoles(config.rbac.roles, subject.roles, config.rbac.enabled);
  if (!hasVerb(verbs, required)) return false;
  return subject.verbCap ? hasVerb(subject.verbCap, required) : true;
}
