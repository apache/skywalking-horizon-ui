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
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {
  getLayerTemplate,
  widgetsForScope,
  type LayerTemplate,
} from '../../logic/layers/loader.js';
import { defaultWidgetsFor } from '../../logic/dashboard/defaults.js';
import { scopeSchema } from '../query/dashboard.js';
import { localize, getLayerOverlay, localeFromRequest } from '../../i18n/index.js';

export interface DashboardConfigDeps {
  config: ConfigSource;
  sessions: SessionStore;
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
      const rawTpl = getLayerTemplate(layerKey);
      const locale = localeFromRequest(req);
      const tpl = rawTpl
        ? localize<LayerTemplate>(rawTpl, getLayerOverlay(layerKey, locale), locale)
        : null;
      const widgets = tpl ? widgetsForScope(tpl, scope) : defaultWidgetsFor(layerKey);
      return reply.send({ layer: layerKey, scope, widgets });
    },
  );
}
