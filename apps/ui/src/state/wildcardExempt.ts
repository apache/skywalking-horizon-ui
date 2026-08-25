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
 * Verbs a wildcard grant may not reach — the UI's copy of the BFF's
 * `WILDCARD_EXEMPT_VERBS` (`apps/bff/src/rbac/verbs.ts`), which is the source
 * of truth and the only side that enforces.
 *
 * There are two verb matchers on this side (the auth store's gate and the
 * Roles board's) and they must both consult this, or the two surfaces
 * contradict the server in opposite directions: the sidebar offers a page that
 * 403s, and the Roles board draws a check mark for a grant the BFF denies —
 * on the same row whose hint says a wildcard does not include it. That board
 * is what an administrator plans access around.
 *
 * `wildcardExemptVerbs.test.ts` fails if this drifts from the BFF's set.
 */
export const WILDCARD_EXEMPT_VERBS: ReadonlySet<string> = new Set(['audit:read']);
