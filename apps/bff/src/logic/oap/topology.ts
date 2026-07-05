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
 * One-hop service EGO topology — the focus service plus only its DIRECT
 * neighbours: upstream callers (services that call it) and downstream
 * dependencies (services it calls). OAP's `getServicesTopology` seeded with a
 * single serviceId already returns exactly one hop (it loads only relations
 * where the seed is the source OR the target), so there is no radius to prune —
 * we just partition the returned calls by direction. Structural only (no
 * per-edge metrics); the heavier metric-fan-out lives in the full topology
 * route. Powers the AI chat's inline topology block. Never throws — an
 * unreachable OAP yields `reachable:false` so the block degrades gracefully.
 */

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import type { Window } from '../../util/window.js';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';

const EGO_TOPOLOGY_QUERY = /* GraphQL */ `
  query HorizonServiceEgoTopology($duration: Duration!, $serviceIds: [ID!]!) {
    topology: getServicesTopology(duration: $duration, serviceIds: $serviceIds) {
      nodes { id name type isReal layers }
      calls { id source target detectPoints }
    }
  }
`;

interface RawNode {
  id: string;
  name: string;
  type: string | null;
  isReal: boolean;
  layers: string[];
}
interface RawResp {
  topology: { nodes: RawNode[]; calls: Array<{ source: string; target: string }> };
}

/** A direct neighbour of the focus service. `isReal:false` is a conjectural
 *  node (an untraced DB / cache / MQ / external endpoint), rendered dashed;
 *  `type` is its component (e.g. mysql, Tomcat) when OAP resolved one; `layer`
 *  is its own layer (may differ from the focus for a cross-layer edge). */
export interface EgoPeer {
  id: string;
  name: string;
  isReal: boolean;
  type: string | null;
  layer: string | null;
}

export interface ServiceEgoTopology {
  reachable: boolean;
  focus: { id: string; name: string };
  /** Callers — services that call the focus (calls where target === focus). */
  upstream: EgoPeer[];
  /** Dependencies — services the focus calls (calls where source === focus). */
  downstream: EgoPeer[];
  error?: string | null;
}

export async function getServiceEgoTopology(
  config: HorizonConfig,
  serviceId: string,
  serviceName: string,
  window: Window,
  fetchImpl?: FetchLike,
): Promise<ServiceEgoTopology> {
  const opts = buildOapOpts(config, fetchImpl);
  try {
    const data = await graphqlPost<RawResp>(opts, EGO_TOPOLOGY_QUERY, {
      duration: { start: window.start, end: window.end, step: window.step },
      serviceIds: [serviceId],
    });
    const nodes = new Map((data.topology?.nodes ?? []).map((n) => [n.id, n] as const));
    const toPeer = (id: string): EgoPeer => {
      const n = nodes.get(id);
      return {
        id,
        name: n?.name ?? id,
        isReal: n?.isReal ?? true,
        type: n?.type ?? null,
        layer: n?.layers?.[0] ?? null,
      };
    };
    // Partition the calls that touch the focus into callers vs dependencies,
    // deduped by peer id. Keep strictly one hop (ignore neighbour↔neighbour
    // edges OAP may include) and drop the focus's self-call.
    const up = new Map<string, EgoPeer>();
    const down = new Map<string, EgoPeer>();
    for (const c of data.topology?.calls ?? []) {
      if (c.target === serviceId && c.source !== serviceId) up.set(c.source, toPeer(c.source));
      else if (c.source === serviceId && c.target !== serviceId) down.set(c.target, toPeer(c.target));
    }
    return {
      reachable: true,
      focus: { id: serviceId, name: serviceName },
      upstream: [...up.values()],
      downstream: [...down.values()],
    };
  } catch (err) {
    return {
      reachable: false,
      focus: { id: serviceId, name: serviceName },
      upstream: [],
      downstream: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
