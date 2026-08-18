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

export interface SsoProvider {
  id: string;
  displayName: string;
  /** A `data:` URI the operator configured, or '' — Horizon ships no vendor
   *  marks. See `auth.sso.providers[].icon` for why. */
  icon: string;
}

/**
 * `bff.oidc` — the sign-in providers this deployment offers.
 *
 * Only the LISTING is an API call. Starting a login is a full-page navigation
 * to `/api/auth/oidc/start`, not a fetch: the provider answers with a redirect
 * the browser has to follow, and an XHR cannot follow one across origins.
 */
export class OidcApi {
  constructor(private readonly bff: BffClient) {}

  providers(): Promise<{ providers: SsoProvider[] }> {
    return this.bff.request<{ providers: SsoProvider[] }>('GET', '/api/auth/oidc/providers');
  }
}
