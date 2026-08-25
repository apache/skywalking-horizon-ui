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
 * `GET /api/layer/:key/dashboard/config` — returns the default widget
 * set for one (layer, scope) without running any MQE. The SPA renders
 * the empty grid first, then fires `POST /api/layer/:key/dashboard` to
 * populate cells. Accepts `?scope=service|instance|endpoint|…` and
 * defaults to `service`, plus `?page=<id>` to select one of a component's
 * extension pages — omitted means the component's default grid, and an id
 * the template doesn't declare is a 404 rather than a silent fall back.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import {
  widgetsForScopePage,
  type LayerTemplate,
} from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { oapOverlayContentFor } from '../../logic/templates/overlay.js';
import { defaultWidgetsFor } from '../../logic/dashboard/defaults.js';
import { scopeSchema } from '../../logic/dashboard/schema.js';
import { localizeContent, localeFromRequest } from '../../i18n/index.js';

export interface DashboardConfigDeps extends AuthDeps {
  /** OAP UI-template client — serve the in-use REMOTE widget config,
   *  matching the admin + the config-bundle endpoint. Without one, or with no
   *  readable remote row, the route answers with its in-code defaults. */
  uiTemplateClient?: () => UITemplateClient;
}

export function registerDashboardConfigRoute(app: FastifyInstance, deps: DashboardConfigDeps): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/layer/:key/dashboard/config',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { key: string };
      const layerKey = params.key;
      if (!layerKey || !/^[a-z0-9_]+$/i.test(layerKey)) {
        return reply.code(400).send({ error: 'invalid_layer_key' });
      }
      const q = req.query as { scope?: string; page?: string };
      const scopeParsed = q.scope ? scopeSchema.safeParse(q.scope) : null;
      const scope = scopeParsed?.success ? scopeParsed.data : 'service';
      const page = q.page || undefined;
      const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
      if (eff.blocked) {
        // Template store unreachable / layer disabled — block: empty grid,
        // no in-code defaults. The SPA's banner explains the empty state.
        // An explicit page can't be judged unknown from here: the template
        // that would name it is exactly what could not be read.
        return reply.send({ layer: layerKey, scope, page, widgets: [] });
      }
      const rawTpl = eff.template;
      const locale = localeFromRequest(req);
      const tpl = rawTpl
        ? localizeContent<LayerTemplate>(
            rawTpl,
            // Overlay rows key on the canonical UPPER_SNAKE layer key
            // (`GENERAL`), not the lowercase URL param — pass the template's
            // own key so the OAP translation overlay row actually matches.
            await oapOverlayContentFor(deps.uiTemplateClient, 'layer', rawTpl.key, locale),
            locale,
          )
        : null;
      if (tpl) {
        const widgets = widgetsForScopePage(tpl, scope, page);
        // Unknown explicit page — never the default grid under the wrong
        // URL, which an operator would read as the page they asked for.
        if (widgets === null) return reply.code(404).send({ error: 'unknown_page', layer: layerKey, scope, page });
        return reply.send({ layer: layerKey, scope, page, widgets });
      }
      // No template at all: only the in-code default set exists, and it is
      // the default page by definition.
      if (page) return reply.code(404).send({ error: 'unknown_page', layer: layerKey, scope, page });
      return reply.send({ layer: layerKey, scope, widgets: defaultWidgetsFor(rawTpl, layerKey) });
    },
  );
}
