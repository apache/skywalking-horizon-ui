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
 * `GET /api/alarms/pages` — the alarm pages the caller is served, each with
 * only the pins they reach (see `logic/alarms/pages.ts`). The sidebar lists
 * the named ones; the Alarms page reads its own entry for its tiles and its
 * opening window.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { alarmPagesFor, pinReachOf, readStoredAlarmPages } from '../../logic/alarms/pages.js';

export interface AlarmPagesRouteDeps extends AuthDeps {
  uiTemplateClient: () => UITemplateClient;
}

export function registerAlarmPagesRoute(app: FastifyInstance, deps: AlarmPagesRouteDeps): void {
  const auth = requireAuth(deps);

  app.get('/api/alarms/pages', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const stored = await readStoredAlarmPages(deps.uiTemplateClient);
    return reply.send(alarmPagesFor(stored, pinReachOf(req.access)));
  });
}
