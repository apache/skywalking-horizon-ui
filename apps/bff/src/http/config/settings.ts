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
 * `GET /api/configs/settings` — the EFFECTIVE content of the three org-wide
 * singleton templates every signed-in user needs at boot: the org-default
 * theme (`horizon.theme.active`), the global time-picker default window
 * (`horizon.time-defaults.global`) and the alert page setup
 * (`horizon.alert.page-setup`, which also sizes the sidebar alarm badge's
 * window and the overview alarms widget).
 *
 * Resolved server-side, for two reasons:
 *   - `templates.mode` is a server-side fact. Live mode renders ONLY the
 *     remote row, so an absent / disabled / unreadable row resolves to `null`
 *     here and the caller applies its own in-code default — the disk bundle is
 *     never handed out. Readonly mode presents the disk bundle through the same
 *     remote row (see `readonlyRows` in the sync orchestrator), so it resolves
 *     through this one expression too.
 *   - the admin sync-status payload carries every template row with BOTH its
 *     remote and bundled configuration. Reading one themeId must not disclose
 *     the whole template store, and must not require `overview:read` — a verb
 *     these three settings have nothing to do with. This route is `auth`.
 *
 * Values are returned verbatim from the envelope: what counts as a valid theme
 * id or window bound belongs to the consumer that owns that vocabulary.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { getSyncStatus, type SyncStatus } from '../../logic/templates/sync.js';
import { iterateBundledTemplates } from '../../logic/templates/aggregator.js';
import {
  ALERT_PAGE_SETUP_KEY,
  THEME_ACTIVE_KEY,
  TIME_DEFAULTS_KEY,
  formatName,
  parseEnvelope,
} from '../../logic/templates/names.js';
import { logger } from '../../logger.js';

export interface SettingsRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  uiTemplateClient: () => UITemplateClient;
}

/** Effective content per singleton, or `null` when the runtime has no source
 *  for it — the caller then falls back to its own in-code default. */
export interface EffectiveSettings {
  theme: unknown;
  timeDefaults: unknown;
  alert: unknown;
}

export function registerSettingsRoute(app: FastifyInstance, deps: SettingsRouteDeps): void {
  const auth = requireAuth(deps);

  app.get(
    '/api/configs/settings',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const sync = await readSyncStatus(deps);
      const body: EffectiveSettings = {
        theme: effectiveContent(sync, formatName('theme', THEME_ACTIVE_KEY)),
        timeDefaults: effectiveContent(sync, formatName('time-defaults', TIME_DEFAULTS_KEY)),
        alert: effectiveContent(sync, formatName('alert', ALERT_PAGE_SETUP_KEY)),
      };
      // No browser caching: an operator's publish has to land on the next
      // read. The 30s sync cache already absorbs the OAP hit.
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
      return reply.send(body);
    },
  );
}

async function readSyncStatus(deps: SettingsRouteDeps): Promise<SyncStatus | null> {
  try {
    return await getSyncStatus({
      client: deps.uiTemplateClient(),
      bundled: () => iterateBundledTemplates(),
      logger,
    });
  } catch (err) {
    logger.warn({ err }, 'org settings resolve failed — serving no value, not the bundle');
    return null;
  }
}

/** Remote-only, the same rule the layer / overview / 3D-map surfaces apply. */
function effectiveContent(sync: SyncStatus | null, name: string): unknown {
  if (!sync || sync.unreachable) return null;
  const row = sync.rows.find((r) => r.name === name);
  if (!row || row.status === 'disabled' || row.effective !== 'remote' || !row.remote) return null;
  return parseEnvelope(row.remote.configuration)?.content ?? null;
}
