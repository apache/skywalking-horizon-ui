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

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { AuditLogger } from './audit/logger.js';
import { SessionStore } from './user/sessions.js';
import { loadConfig, type ConfigSource } from './config/loader.js';
// User
import { registerAuthRoutes } from './http/user.js';
// Query (read-only data from OAP)
import { registerOapInfoRoute } from './http/query/info.js';
import { registerMenuRoute } from './http/query/menu.js';
import { registerLandingRoute } from './http/query/landing.js';
import { registerInstanceRoute } from './http/query/instance.js';
import { registerEndpointRoute } from './http/query/endpoint.js';
import { registerTopologyRoute } from './http/query/topology.js';
import { registerEndpointDependencyRoute } from './http/query/endpoint-dependency.js';
import { registerTraceRoutes } from './http/query/trace.js';
import { registerTraceTagRoutes } from './http/query/trace-tag.js';
import { registerZipkinRoutes } from './http/query/zipkin.js';
import { registerLogRoute } from './http/query/log.js';
import { registerDashboardQueryRoute } from './http/query/dashboard.js';
import { registerAlarmsQueryRoutes } from './http/query/alarms.js';
import { registerPreflightRoutes } from './http/query/preflight.js';
import { registerProfileRoutes } from './http/query/profile.js';
import { registerEBPFRoutes } from './http/query/ebpf.js';
import { registerAsyncProfileRoutes } from './http/query/async-profile.js';
// Config (CRUD for templates / settings)
import { registerDashboardConfigRoute } from './http/config/dashboard.js';
import { registerLayerTemplateRoutes } from './http/config/layer-template.js';
import { registerAlarmsConfigRoutes } from './http/config/alarms.js';
import { registerSetupRoutes } from './http/config/setup.js';
import { registerOverviewRoutes } from './http/config/overview.js';
import { registerConfigBundleRoute } from './http/config/bundle.js';
// Admin (operational tools)
import { registerDslCatalogRoutes } from './http/admin/dsl/catalog.js';
import { registerDslRuleRoutes } from './http/admin/dsl/rule.js';
import { registerDslDumpRoutes } from './http/admin/dsl/dump.js';
import { registerDslOalRoutes } from './http/admin/dsl/oal.js';
import { registerClusterRoutes } from './http/admin/cluster.js';
import { registerDebugRoutes } from './http/admin/live-debug.js';
import { registerInspectRoutes } from './http/admin/inspect.js';
import { registerAlarmRulesRoutes } from './http/admin/alarm-rules.js';
import { registerOverviewTemplatesAdminRoutes } from './http/admin/overview-templates.js';
// Logic / stores
import { AlarmsStore } from './logic/alarms/store.js';
import { SetupStore } from './logic/setup/store.js';
import { ServiceLayerMap } from './logic/alarms/service-layer-map.js';
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
const alarmsStore = new AlarmsStore(source.current.alarms.file);
await alarmsStore.load();
// Shared between alarms query (read) + alarms config (write+invalidate).
const serviceLayer = new ServiceLayerMap({ config: source });

await app.register(cookie);

// Text/plain body parser — the rule editor sends raw YAML to /api/rule.
app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));

// ── User ───────────────────────────────────────────────────────────
registerAuthRoutes(app, source, sessions, audit);

// ── Query ──────────────────────────────────────────────────────────
registerOapInfoRoute(app, { config: source, sessions });
registerMenuRoute(app, { config: source, sessions });
registerLandingRoute(app, { config: source, sessions });
registerInstanceRoute(app, { config: source, sessions });
registerEndpointRoute(app, { config: source, sessions });
registerTopologyRoute(app, { config: source, sessions });
registerEndpointDependencyRoute(app, { config: source, sessions });
registerTraceRoutes(app, { config: source, sessions });
registerTraceTagRoutes(app, { config: source, sessions });
registerZipkinRoutes(app, { config: source, sessions });
registerLogRoute(app, { config: source, sessions });
registerDashboardQueryRoute(app, { config: source, sessions });
registerAlarmsQueryRoutes(app, { config: source, sessions, serviceLayer });
registerPreflightRoutes(app, { config: source, sessions });
registerProfileRoutes(app, { config: source, sessions });
registerEBPFRoutes(app, { config: source, sessions });
registerAsyncProfileRoutes(app, { config: source, sessions });

// ── Config ─────────────────────────────────────────────────────────
registerDashboardConfigRoute(app, { config: source, sessions });
registerLayerTemplateRoutes(app, { config: source, sessions });
registerAlarmsConfigRoutes(app, { config: source, sessions, audit, store: alarmsStore, serviceLayer });
registerSetupRoutes(app, { config: source, sessions, audit, store: setupStore });
registerOverviewRoutes(app, { config: source, sessions });
registerConfigBundleRoute(app, { config: source, sessions });

// ── Admin ──────────────────────────────────────────────────────────
registerDslCatalogRoutes(app, { config: source, sessions, audit });
registerDslRuleRoutes(app, { config: source, sessions, audit });
registerDslDumpRoutes(app, { config: source, sessions, audit });
registerDslOalRoutes(app, { config: source, sessions, audit });
registerClusterRoutes(app, { config: source, sessions, audit });
registerDebugRoutes(app, { config: source, sessions, audit });
registerInspectRoutes(app, { config: source, sessions, audit });
registerAlarmRulesRoutes(app, { config: source, sessions });
registerOverviewTemplatesAdminRoutes(app, { config: source, sessions });

// Serve the built SPA out of the BFF when HORIZON_STATIC_DIR points at a
// directory (Docker image layout: /app/static contains the Vite dist).
// Local dev keeps using the Vite dev-server on :9091 so this is a no-op
// when the env var is absent.
const staticDir = process.env.HORIZON_STATIC_DIR
  ? resolvePath(process.env.HORIZON_STATIC_DIR)
  : null;
if (staticDir && existsSync(staticDir)) {
  await app.register(fastifyStatic, { root: staticDir, prefix: '/', wildcard: false });
  // SPA fallback — anything that isn't an `/api/*` request and didn't match
  // a built file falls through to index.html so client-side routing works.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ code: 'not_found', message: req.url });
    }
    return reply.sendFile('index.html');
  });
  logger.info({ staticDir }, 'serving SPA from static dir');
}

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
