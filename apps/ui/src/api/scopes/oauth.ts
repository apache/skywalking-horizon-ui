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

import type { BffClient } from '../client';

/** What the consent screen shows: who is granting, to whom, and how much. */
export interface ConsentRequest {
  /** Name the client registered itself under. Empty when it registered none —
   *  the screen then says so rather than inventing one. Self-asserted in every
   *  case: registration is unauthenticated, so this is a claim, not an identity. */
  clientName: string;
  /** Set only when the client identified itself by URL, which is the one
   *  identity here that was CHECKED — the document served at that address had
   *  to name the same client back. Absent for a registered client, which has
   *  only an opaque handle and therefore nothing verifiable to show. */
  clientUrl?: string;
  redirectUri: string;
  scopes: string[];
  username: string;
  roles: string[];
  /** The verbs this grant would actually carry: the scope INTERSECTED with what
   *  the signed-in user holds, so the screen never promises access they cannot
   *  delegate. */
  verbs: string[];
}

/** `bff.oauth` — the browser half of the authorization-code flow. */
export class OAuthApi {
  constructor(private readonly bff: BffClient) {}

  consentRequest(request: string): Promise<ConsentRequest> {
    return this.bff.request<ConsentRequest>(
      'GET',
      `/api/oauth/consent?request=${encodeURIComponent(request)}`,
    );
  }

  /** Returns where to send the browser next — always back to the client's
   *  redirect, carrying either a code or `error=access_denied`. */
  /**
   * `redirectTo` is absent when a DECLINED request has a remote redirect: the
   * safe answer must not navigate the operator to an address a stranger
   * registered, so the flow ends here instead. A declined loopback request
   * still carries one — that listener is on this machine, and telling it saves
   * it waiting for a callback that will never arrive.
   */
  decide(request: string, approve: boolean): Promise<{ redirectTo?: string; declined?: boolean }> {
    return this.bff.request<{ redirectTo?: string; declined?: boolean }>('POST', '/api/oauth/consent', {
      request,
      approve,
    });
  }
}
