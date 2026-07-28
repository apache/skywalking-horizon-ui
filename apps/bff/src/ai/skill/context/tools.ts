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
import { resolveEffectiveLayer } from '../../../logic/layers/effective.js';
import { toolPrompt } from '../../resources/loader.js';

export function contextTools(ctx: AiRequestContext): StructuredToolInterface[] {
  const catalog = () => serviceLayerCatalog({ config: ctx.config, fetch: ctx.fetch }).get();
  const denied = (): string => 'Permission denied: the current user lacks metrics:read.';

  const listLayers = tool(
    async (): Promise<string> => {
      if (!ctx.hasVerb('metrics:read')) return denied();
      const cat = await catalog();
      const rows = await Promise.all(
        cat.layers.map(async (layer) => {
          const eff = await resolveEffectiveLayer(ctx.uiTemplateClient, layer);
          return { layer, alias: eff.template?.alias, services: cat.byLayer.get(layer)?.length ?? 0 };
        }),
      );
      return JSON.stringify(rows);
    },
    {
      name: 'list_layers',
      description: toolPrompt('context', 'list_layers').description,
      schema: z.object({}),
    },
  );

  const SERVICE_CAP = 100;
  const svc = toolPrompt('context', 'list_services');
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
      description: svc.description,
      schema: z.object({
        layer: z.string().optional().describe(svc.p('layer')),
        keyword: z.string().optional().describe(svc.p('keyword')),
      }),
    },
  );

  return [listLayers, listServices];
}
