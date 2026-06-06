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
 * Parse + bound a client-supplied **preview** config block for the
 * topology / endpoint-dependency / trace pages.
 *
 * The admin "Preview" button opens the live layer page in `?mode=preview`
 * and the page forwards the operator's unpublished draft config here, so
 * the BFF can render the draft's MQE against live OAP without publishing
 * to OAP first. This is the only path that runs config the UI hands us —
 * so it is bounded: a hard size ceiling, capped metric/expression counts,
 * and required string fields. The MQE itself is operator-authored (they
 * hold `dashboard:write` to even produce a draft) and runs read-only,
 * the same trust class as the dashboard POST's `widgets[]`.
 *
 * Returns the typed config on success, or `null` for absent / oversized /
 * malformed input — callers then fall back to the normal remote-resolved
 * config (i.e. preview silently no-ops rather than erroring).
 */

import type {
  TopologyConfig,
  EndpointDependencyConfig,
  TracesConfig,
  ProcessTopologyConfig,
  TopologyMetricDef,
} from './loader.js';

const MAX_RAW_BYTES = 32_000;
const MAX_METRICS = 32;
const MAX_MQE_LEN = 512;

function isMetricList(v: unknown): v is TopologyMetricDef[] {
  if (!Array.isArray(v) || v.length > MAX_METRICS) return false;
  return v.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const d = m as Record<string, unknown>;
    return (
      typeof d.id === 'string' &&
      d.id.length > 0 &&
      d.id.length <= 64 &&
      typeof d.mqe === 'string' &&
      d.mqe.length > 0 &&
      d.mqe.length <= MAX_MQE_LEN
    );
  });
}

function parseJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.length > MAX_RAW_BYTES) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `topology` block — node + per-side link metric lists (+ optional
 *  nested `instanceTopology`, which rides through verbatim once its own
 *  metric lists pass the same bound). */
export function parsePreviewTopology(raw: string | undefined): TopologyConfig | null {
  const o = parseJson(raw);
  if (!o || !isMetricList(o.nodeMetrics)) return null;
  if (o.linkServerMetrics !== undefined && !isMetricList(o.linkServerMetrics)) return null;
  if (o.linkClientMetrics !== undefined && !isMetricList(o.linkClientMetrics)) return null;
  const inst = o.instanceTopology as Record<string, unknown> | undefined;
  if (inst !== undefined) {
    if (!inst || typeof inst !== 'object' || !isMetricList(inst.nodeMetrics)) return null;
    if (inst.linkServerMetrics !== undefined && !isMetricList(inst.linkServerMetrics)) return null;
    if (inst.linkClientMetrics !== undefined && !isMetricList(inst.linkClientMetrics)) return null;
  }
  return o as unknown as TopologyConfig;
}

/** `endpointDependency` block — node + (server-only) link metric lists. */
export function parsePreviewEndpointDep(raw: string | undefined): EndpointDependencyConfig | null {
  const o = parseJson(raw);
  if (!o || !isMetricList(o.nodeMetrics)) return null;
  if (o.linkMetrics !== undefined && !isMetricList(o.linkMetrics)) return null;
  return o as unknown as EndpointDependencyConfig;
}

/** `traces` block — just the source selector. */
export function parsePreviewTraces(raw: string | undefined): TracesConfig | null {
  const o = parseJson(raw);
  if (!o) return null;
  const source = o.source;
  if (source !== 'native' && source !== 'zipkin' && source !== 'both') return null;
  return { source } as TracesConfig;
}

/** `processTopology` block — the network-profiling edge-detail metric
 *  lists (ProcessRelation scope, client + server). */
export function parsePreviewProcessTopology(raw: string | undefined): ProcessTopologyConfig | null {
  const o = parseJson(raw);
  if (!o) return null;
  if (o.edgeClientMetrics !== undefined && !isMetricList(o.edgeClientMetrics)) return null;
  if (o.edgeServerMetrics !== undefined && !isMetricList(o.edgeServerMetrics)) return null;
  if (o.edgeClientMetrics === undefined && o.edgeServerMetrics === undefined) return null;
  return o as unknown as ProcessTopologyConfig;
}
