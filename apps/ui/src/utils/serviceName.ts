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

import type { ServiceNamingRule } from '@skywalking-horizon-ui/api-client';

/**
 * Two name conventions co-exist:
 *
 *   - **OAP `<group>::<base>` prefix** (layer-agnostic, historical).
 *     Example: `agent::checkout`, `mesh-svr::reviews`. The `<group>`
 *     part is operationally meaningful (fleet / agent class) but the
 *     `::` syntax bleeds badly into UI labels — by default we always
 *     strip it from the display label and expose it separately on
 *     `legacyGroup`. The node detail panel can opt-in to surfacing it
 *     as a chip via `TopologyConfig.showGroup`.
 *
 *   - **Per-layer topology-cluster rule** (k8s / mesh / cilium). A
 *     named-capture regex (see `ServiceNamingRule`) splits the name
 *     into `display` + `cluster` (e.g. namespace). When the rule
 *     matches, its captures win.
 *
 * Both conventions can apply to one name. Real mesh services look
 * like `mesh-svr::reviews.default` — the cluster rule extracts
 * `service=mesh-svr::reviews`, `namespace=default`, and we then strip
 * `mesh-svr::` from the captured service to leave `display=reviews`
 * + `legacyGroup=mesh-svr` + `cluster=default`.
 *
 * The resolver is the single read-side helper: every UI display site
 * goes through it so chips, labels, and groupings stay consistent.
 */

export interface ParsedServiceName {
  /** Group prefix when the raw name contains `::`. */
  group: string | null;
  /** Service name with the `<group>::` prefix stripped; equal to `raw`
   *  when there is no group. */
  base: string;
  /** Original full name (echoed so callers don't have to keep it around). */
  raw: string;
}

export function parseServiceName(raw: string | null | undefined): ParsedServiceName {
  const r = raw ?? '';
  const idx = r.indexOf('::');
  if (idx <= 0) return { group: null, base: r, raw: r };
  return { group: r.slice(0, idx), base: r.slice(idx + 2), raw: r };
}

/** Display helper — base only. Use in tight spots (graph nodes, chips). */
export function serviceBaseName(raw: string | null | undefined): string {
  return parseServiceName(raw).base;
}

/** Display helper — group only (null when no group). Renderers should
 *  treat null as "no group chip". */
export function serviceGroupName(raw: string | null | undefined): string | null {
  return parseServiceName(raw).group;
}

/**
 * OAP buckets metrics that carry no service binding under a synthetic
 * service whose name comes back empty (its id base64-decodes to `_blank`).
 * Surface it in pickers so operators can see it exists, but NEVER
 * auto-select or query it: an empty service name no-ops every per-service
 * MQE / instance / endpoint query, and the dashboard gate `Boolean(service)`
 * then never fires — the page would sit on "Reading data…" forever.
 * `BLANK_SERVICE_NAME` is the verbatim label we show in its place.
 */
export const BLANK_SERVICE_NAME = '_blank';
export function isBlankServiceName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  return n === '' || n === BLANK_SERVICE_NAME;
}

/**
 * Layer-aware identity for a service name.
 *
 * `display` is **always** the pure service label — no `<group>::`
 * prefix, no `.<namespace>` suffix when the cluster rule consumed
 * one. Topology nodes and chip labels read this verbatim.
 *
 * `cluster` + `clusterAlias` come from a matching topology-cluster
 * rule (k8s namespace, mesh namespace, …). Both are `null` when no
 * rule was supplied or the regex didn't match.
 *
 * `legacyGroup` is OAP's historical `<group>::` prefix on the raw
 * name (or on the captured display, in case both conventions stack).
 * The node detail panel surfaces it as a separate chip only when
 * `TopologyConfig.showGroup` is true; everywhere else (topology
 * label, focus picker, lists) ignores it.
 */
export interface ServiceIdentity {
  display: string;
  cluster: string | null;
  clusterAlias: string | null;
  legacyGroup: string | null;
}

function compileRule(rule: ServiceNamingRule | null | undefined): RegExp | null {
  if (!rule || !rule.pattern) return null;
  try {
    return new RegExp(rule.pattern, rule.flags ?? '');
  } catch {
    return null;
  }
}

export function resolveServiceIdentity(
  raw: string | null | undefined,
  rule: ServiceNamingRule | null | undefined,
): ServiceIdentity {
  const r = raw ?? '';
  // Always extract the legacy `::` group up-front. It can apply both
  // to names that don't match the cluster rule (`agent::checkout`)
  // and to names that DO match it (`mesh-svr::reviews.default` — the
  // cluster rule captures `mesh-svr::reviews` as the service, and we
  // then split off `mesh-svr` here).
  let legacyGroup: string | null = null;
  const workingName = r;

  // Cluster rule first.
  const re = compileRule(rule);
  if (re && rule) {
    const m = r.match(re);
    if (m && m.groups) {
      const displayKey = rule.displayGroup ?? 'service';
      const valueKey = rule.valueGroup ?? 'group';
      const captured = m.groups[displayKey];
      const cluster = m.groups[valueKey];
      if (captured && cluster) {
        // Strip the `<group>::` prefix from the captured service so
        // the display label is the pure base name.
        const stripped = parseServiceName(captured);
        return {
          display: stripped.base,
          cluster,
          clusterAlias: rule.alias,
          legacyGroup: stripped.group,
        };
      }
      if (captured) {
        // Partial match — capture had display but not cluster.
        const stripped = parseServiceName(captured);
        return {
          display: stripped.base,
          cluster: null,
          clusterAlias: null,
          legacyGroup: stripped.group,
        };
      }
    }
    // Regex didn't match — fall through to the legacy parser.
  }

  // Legacy `<group>::<base>` fallback. By default we DON'T surface
  // the prefix anywhere in the UI; just record it on `legacyGroup`
  // so the (opt-in) node panel chip can pick it up.
  const legacy = parseServiceName(workingName);
  legacyGroup = legacy.group;
  return {
    display: legacy.base,
    cluster: null,
    clusterAlias: null,
    legacyGroup,
  };
}
