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

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { basicAuthHeader } from './graphql.js';
import { wireFetch } from './wire-log.js';

/**
 * Read OAP's resolved runtime config from the admin port's
 * `/debugging/config/dump`. With `Accept: application/json` OAP returns
 * a flat `Record<string,string>`; secrets are masked server-side. This
 * is the canonical fetch for the read-only OAP-config page; preflight
 * and mqe-target keep their own narrower copies because they only probe
 * a couple of keys and predate this helper.
 */
export async function fetchConfigDump(
  adminUrl: string,
  opts: {
    fetch?: FetchLike;
    timeoutMs: number;
    auth?: { username: string; password: string };
  },
): Promise<Record<string, string>> {
  const f = wireFetch(opts.fetch ?? globalThis.fetch.bind(globalThis));
  const url = `${adminUrl.replace(/\/$/, '')}/debugging/config/dump`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.auth) {
    headers.authorization = basicAuthHeader(opts.auth.username, opts.auth.password);
  }
  let init: RequestInit = { method: 'GET', headers };
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (opts.timeoutMs > 0) {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    init = { ...init, signal: ctrl.signal };
  }
  try {
    const res = await f(url, init);
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`HTTP ${res.status} at ${url}${text ? ` — ${text}` : ''}`);
    }
    return (await res.json()) as Record<string, string>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
