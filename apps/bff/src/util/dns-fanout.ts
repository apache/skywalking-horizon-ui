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
 * DNS-resolve a hostname-based URL into one URL per resolved IP, so the
 * caller can fan out per-node requests against a single configured URL.
 *
 * Used by the per-node features (live-debug status): the user configures
 * one URL pointing at a DNS name (or k8s Service / headless Service);
 * this helper turns it into N URLs the BFF can probe individually.
 *
 * Behavior:
 *   - Hostname is already an IPv4/IPv6 literal → returns [originalUrl].
 *   - Lookup succeeds with N addresses → returns N URLs, one per IP,
 *     with the literal IP substituted into the hostname slot. Port,
 *     scheme and path are preserved.
 *   - Lookup fails → returns [originalUrl] (so the caller can still
 *     attempt the request and surface the real error).
 *
 * Caveat: substituting an IP into an HTTPS URL breaks cert validation
 * unless the server cert includes the IP in its SAN. Operators that
 * need per-node fan-out across HTTPS endpoints should either issue
 * certs with all node IPs in SANs, terminate TLS at a load balancer,
 * or run the admin port over plain HTTP on the cluster-internal
 * network — which is the typical pattern for OAP admin (port 17128).
 */

import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

export interface ResolvedTarget {
  /** URL with IP substituted into the host (or the original URL when
   *  no resolution happened). */
  url: string;
  /** True iff this URL was synthesised from a DNS-resolved IP. */
  resolved: boolean;
  /** The original hostname (useful for diagnostic display, e.g.
   *  "oap-1.svc.cluster.local → 10.4.18.42"). */
  originalHost: string;
  /** The resolved IP, or null when no resolution happened. */
  ip: string | null;
}

export async function resolveTargets(originalUrl: string): Promise<ResolvedTarget[]> {
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return [{ url: originalUrl, resolved: false, originalHost: '', ip: null }];
  }
  const host = parsed.hostname;
  if (isIP(host)) {
    return [{ url: originalUrl, resolved: false, originalHost: host, ip: host }];
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsPromises.lookup(host, { all: true });
  } catch {
    return [{ url: originalUrl, resolved: false, originalHost: host, ip: null }];
  }
  if (addresses.length === 0) {
    return [{ url: originalUrl, resolved: false, originalHost: host, ip: null }];
  }
  // Dedup IPs while preserving order — some resolvers return duplicates.
  const seen = new Set<string>();
  const out: ResolvedTarget[] = [];
  for (const { address } of addresses) {
    if (seen.has(address)) continue;
    seen.add(address);
    const url = new URL(originalUrl);
    // IPv6 literals must be bracket-wrapped in URLs.
    url.hostname = address.includes(':') ? `[${address}]` : address;
    out.push({ url: url.toString(), resolved: true, originalHost: host, ip: address });
  }
  return out;
}
