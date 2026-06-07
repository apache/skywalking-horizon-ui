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
 * defaults to `service`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {
  widgetsForScope,
  type LayerTemplate,
} from '../../logic/layers/loader.js';
import { resolveEffectiveLayer } from '../../logic/layers/effective.js';
import { oapOverlayContentFor } from '../../logic/templates/overlay.js';
import { defaultWidgetsFor } from '../../logic/dashboard/defaults.js';
import { scopeSchema } from '../query/dashboard.js';
import { localizeContent, localeFromRequest } from '../../i18n/index.js';

export interface DashboardConfigDeps {
  config: ConfigSource;
  sessions: SessionStore;
  /** OAP UI-template client — serve the in-use (remote-or-bundled)
   *  widget config, matching the admin + the config-bundle endpoint. */
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
      const q = req.query as { scope?: string };
      const scopeParsed = q.scope ? scopeSchema.safeParse(q.scope) : null;
      const scope = scopeParsed?.success ? scopeParsed.data : 'service';
      const eff = await resolveEffectiveLayer(deps.uiTemplateClient, layerKey);
      if (eff.blocked) {
        // Template store unreachable / layer disabled — block: empty grid,
        // no in-code defaults. The SPA's banner explains the empty state.
        return reply.send({ layer: layerKey, scope, widgets: [] });
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
      const widgets = tpl ? widgetsForScope(tpl, scope) : defaultWidgetsFor(rawTpl, layerKey);
      return reply.send({ layer: layerKey, scope, widgets });
    },
  );
}
