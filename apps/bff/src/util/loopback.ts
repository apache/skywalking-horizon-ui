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
 * Is this host THIS machine?
 *
 * Lives in `util/` with no imports of its own because both the config schema
 * and the audit config need it, and having one import the other formed a cycle
 * that broke a direct import of either with `Cannot access 'auditSchema'
 * before initialization`.
 */

import { isIP } from 'node:net';

/**
 * A loopback host, and nothing that merely looks like one.
 *
 * `/^127\./` is a string prefix rather than an address check: it accepts
 * `127.attacker.example`, an ordinary DNS name that resolves wherever its
 * owner points it. The literal has to BE an IP before the `127/8` rule means
 * anything, which is what this exists to enforce.
 */
export function isLoopbackHostname(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  const version = isIP(host);
  if (version === 4) return host.startsWith('127.');
  if (version === 6) return host === '::1' || host === '::ffff:127.0.0.1';
  return false;
}

/** https, or a loopback host where there is no network to listen on. */
export function isHttpsOrLoopback(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    if (u.protocol !== 'http:') return false;
    return isLoopbackHostname(u.hostname);
  } catch {
    return false;
  }
}
