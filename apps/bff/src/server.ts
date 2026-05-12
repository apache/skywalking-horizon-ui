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

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { AuditLogger } from './audit/logger.js';
import { registerAuthRoutes } from './auth/routes.js';
import { SessionStore } from './auth/sessions.js';
import { loadConfig, type ConfigSource } from './config/loader.js';
import { registerMenuRoute } from './oap/menu-routes.js';
import { registerOapRoutes } from './oap/routes.js';
import { registerPreflightRoutes } from './oap/preflight-routes.js';
import { registerSetupRoutes } from './setup/routes.js';
import { SetupStore } from './setup/store.js';
import { HttpError } from './errors.js';
import { logger, loggerOptions } from './logger.js';

const configPath = process.env.HORIZON_CONFIG ?? './horizon.yaml';

const source: ConfigSource = loadConfig(configPath);
logger.info({ configPath: source.path }, 'config loaded');
source.onChange((cfg) => logger.info({ users: cfg.auth.local.users.length }, 'config reloaded'));

const app = Fastify({ logger: loggerOptions });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) {
    return reply.status(err.statusCode).send({ code: err.code, message: err.message, details: err.details });
  }
  const message = err instanceof Error ? err.message : 'internal error';
  reply.log.error({ err }, 'unhandled');
  return reply.status(500).send({ code: 'internal_error', message });
});

const sessions = new SessionStore({ ttlMinutes: source.current.session.ttlMinutes });
const audit = new AuditLogger(source.current.audit.file);
await audit.open();
const setupStore = new SetupStore(source.current.setup.file);
await setupStore.load();

await app.register(cookie);

// Text/plain body parser — the rule editor sends raw YAML to /api/rule.
app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));

registerAuthRoutes(app, source, sessions, audit);
registerMenuRoute(app, { config: source, sessions });
registerSetupRoutes(app, { config: source, sessions, audit, store: setupStore });
registerOapRoutes(app, { config: source, sessions, audit });
registerPreflightRoutes(app, { config: source, sessions });

app.get('/api/health', async () => ({
  status: 'ok',
  version: process.env.HORIZON_VERSION ?? '0.1.0',
  sessions: sessions.size(),
}));

const { host, port } = source.current.server;
app.listen({ host, port }).then(
  () => logger.info(`BFF listening on http://${host}:${port}`),
  (err) => {
    logger.fatal({ err }, 'failed to start BFF');
    process.exit(1);
  },
);

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await sessions.close();
  await audit.close();
  await source.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
