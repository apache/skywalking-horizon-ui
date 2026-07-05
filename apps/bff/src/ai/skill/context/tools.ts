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
 * context skill — the orientation tools every investigation starts from:
 * which layers exist, and which services live in a layer. Both read the shared
 * per-layer service catalog (kept warm by the sidebar), so they're cheap.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AiRequestContext } from '../../context.js';
import { serviceLayerCatalog } from '../../../logic/services/service-layer-catalog.js';

export function contextTools(ctx: AiRequestContext): StructuredToolInterface[] {
  const catalog = () => serviceLayerCatalog({ config: ctx.config, fetch: ctx.fetch }).get();
  const denied = (): string => 'Permission denied: the current user lacks metrics:read.';

  const listLayers = tool(
    async (): Promise<string> => {
      if (!ctx.hasVerb('metrics:read')) return denied();
      const cat = await catalog();
      return JSON.stringify(
        cat.layers.map((layer) => ({ layer, services: cat.byLayer.get(layer)?.length ?? 0 })),
      );
    },
    {
      name: 'list_layers',
      description:
        'List the observability layers OAP reports (GENERAL, MESH, K8S_SERVICE, …) with how many services each has. Start here to orient before browsing metrics or picking a service.',
      schema: z.object({}),
    },
  );

  const SERVICE_CAP = 100;
  const listServices = tool(
    async ({ layer, keyword }): Promise<string> => {
      if (!ctx.hasVerb('metrics:read')) return denied();
      const cat = await catalog();
      const k = keyword?.toLowerCase();
      // Each row is tagged with its layer. A service can belong to more than one
      // layer (a k8s workload is K8S_SERVICE and, via the hierarchy, GENERAL/MESH),
      // so it appears once per layer — the agent still needs a layer to browse
      // that service's metric catalog, so the layer rides with every row.
      const collect = (l: string): Array<{ id: string; name: string; layer: string }> =>
        (cat.byLayer.get(l) ?? [])
          .filter((r) => !k || r.name.toLowerCase().includes(k))
          .map((r) => ({ id: r.id, name: r.name, layer: l }));
      const rows = layer ? collect(layer.toUpperCase()) : cat.layers.flatMap(collect);
      const out = rows.slice(0, SERVICE_CAP);
      return JSON.stringify({ services: out, total: rows.length, truncated: rows.length > out.length });
    },
    {
      name: 'list_services',
      description:
        'List services with their id, name AND layer. Pass a layer to list that layer only, OR OMIT the layer to search ACROSS ALL layers by name — do that (with a keyword) to find a service when you do not know its layer, instead of guessing. Use the returned id as serviceId for drilling and the layer for kb_browse_catalog / rendering. A service that lives in several layers appears once per layer. Capped at 100 rows (truncated:true when more) — narrow with keyword.',
      schema: z.object({
        layer: z
          .string()
          .optional()
          .describe('OAP layer key (e.g. GENERAL); OMIT to search every layer by name'),
        keyword: z
          .string()
          .optional()
          .describe('case-insensitive service-name filter (recommended when no layer is given)'),
      }),
    },
  );

  return [listLayers, listServices];
}
