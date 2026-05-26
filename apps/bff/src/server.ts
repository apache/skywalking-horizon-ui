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
import { LdapHealth } from './user/ldap-health.js';
import { UserSeenCache } from './user/seen-cache.js';
import { loadConfig, type ConfigSource, BootstrapError } from './config/loader.js';
import { makeRouteAuthHook } from './rbac/route-policy.js';
// User
import { registerAuthRoutes } from './http/user.js';
// Query (read-only data from OAP)
import { registerOapInfoRoute } from './http/query/info.js';
import { registerMenuRoute } from './http/query/menu.js';
import { registerLandingRoute } from './http/query/landing.js';
import { registerInstanceRoute } from './http/query/instance.js';
import { registerEndpointRoute } from './http/query/endpoint.js';
import { registerTopologyRoute } from './http/query/topology.js';
import { registerLayerServicesRoute } from './http/query/services.js';
import { registerEndpointDependencyRoute } from './http/query/endpoint-dependency.js';
import { registerTraceRoutes } from './http/query/trace.js';
import { registerTraceTagRoutes } from './http/query/trace-tag.js';
import { registerZipkinRoutes } from './http/query/zipkin.js';
import { registerLogRoute } from './http/query/log.js';
import { registerDashboardQueryRoute } from './http/query/dashboard.js';
import { registerAlarmsQueryRoutes } from './http/query/alarms.js';
import { registerPreflightRoutes } from './http/query/preflight.js';
import { registerTtlRoute } from './http/query/ttl.js';
import { registerProfileRoutes } from './http/query/profile.js';
import { registerEBPFRoutes } from './http/query/ebpf.js';
import { registerAsyncProfileRoutes } from './http/query/async-profile.js';
// Config (CRUD for templates / settings)
import { registerDashboardConfigRoute } from './http/config/dashboard.js';
import { registerLayerTemplateRoutes } from './http/config/layer-template.js';
import { startLayerTemplateWatcher } from './logic/layers/loader.js';
import { registerAlarmsConfigRoutes } from './http/config/alarms.js';
import { registerSetupRoutes } from './http/config/setup.js';
import { registerOverviewRoutes } from './http/config/overview.js';
import { registerConfigBundleRoute } from './http/config/bundle.js';
import { registerTemplateSyncAdminRoutes } from './http/admin/template-sync.js';
import { buildOapClients } from './client/index.js';
import { bootSeed } from './logic/templates/sync.js';
import { iterateBundledTemplates, iterateBundledOverlays } from './logic/templates/aggregator.js';
// Admin (operational tools)
import { registerDslCatalogRoutes } from './http/admin/dsl/catalog.js';
import { registerDslRuleRoutes } from './http/admin/dsl/rule.js';
import { registerDslDumpRoutes } from './http/admin/dsl/dump.js';
import { registerDslOalRoutes } from './http/admin/dsl/oal.js';
import { registerClusterRoutes } from './http/admin/cluster.js';
import { registerDebugRoutes } from './http/admin/live-debug.js';
import { registerInspectRoutes } from './http/admin/inspect.js';
import { registerOapConfigRoute } from './http/admin/oap-config.js';
import { registerAlarmRulesRoutes } from './http/admin/alarm-rules.js';
import { registerOverviewTemplatesAdminRoutes } from './http/admin/overview-templates.js';
import { registerAuthStatusRoutes } from './http/admin/auth-status.js';
import { registerAdminUsersRoute } from './http/admin/users.js';
import { registerAuthHealthRoute } from './http/auth-health.js';
import { registerColdStageHook } from './util/duration.js';
// Logic / stores
import { AlarmsStore } from './logic/alarms/store.js';
import { SetupStore } from './logic/setup/store.js';
import { serviceLayerCatalog } from './logic/services/service-layer-catalog.js';
import { HttpError } from './errors.js';
import { logger, loggerOptions } from './logger.js';

const configPath = process.env.HORIZON_CONFIG ?? './horizon.yaml';

let source: ConfigSource;
try {
  source = loadConfig(configPath);
} catch (err) {
  if (err instanceof BootstrapError) {
    // Fail loud — a misconfigured deployment must not silently start
    // with no auth backend wired.
    logger.fatal({ err: err.message, configPath }, 'BFF refusing to start: bootstrap validation failed');
    process.exit(1);
  }
  throw err;
}
logger.info(
  { configPath: source.path, backend: source.current.auth.backend },
  'config loaded',
);
if (source.current.auth.backend === 'ldap' && source.current.auth.local.users.length > 0) {
  logger.warn(
    { users: source.current.auth.local.users.length },
    'auth.local.users is populated but auth.backend is "ldap"; local users are ignored',
  );
}
source.onChange((cfg) => logger.info({ backend: cfg.auth.backend }, 'config reloaded'));

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
const ldapHealth = new LdapHealth();
const seenCache = new UserSeenCache();
const setupStore = new SetupStore(source.current.setup.file);
await setupStore.load();
const alarmsStore = new AlarmsStore(source.current.alarms.file);
await alarmsStore.load();
// Server-global service-by-layer index — shared by the sidebar menu, the
// alarms tagger, and any other surface that needs the service ↔ layer
// mapping. 60s TTL + single-flight dedup; one OAP fan-out per minute
// regardless of how many routes are polling.
const serviceLayer = serviceLayerCatalog({ config: source });

await app.register(cookie);

// Text/plain body parser — the rule editor sends raw YAML to /api/rule.
app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));

// Map the UI's cold-stage header (X-Horizon-Cold-Stage) onto
// `req.coldStage` so every downstream Duration helper sees one boolean
// instead of re-parsing the header. BanyanDB-only at the OAP layer;
// other backends silently ignore the resulting Duration.coldStage:true.
registerColdStageHook(app);

// Auto-apply RBAC pre-handlers to every route as it's registered. Must
// be added BEFORE the route registrations below — onRoute fires for
// each subsequent app.get/post/...
app.addHook('onRoute', makeRouteAuthHook({ config: source, sessions }));

// ── User ───────────────────────────────────────────────────────────
registerAuthRoutes(app, { config: source, sessions, audit, ldapHealth, seenCache });
registerAuthHealthRoute(app, { config: source, ldapHealth });

// ── Query ──────────────────────────────────────────────────────────
registerOapInfoRoute(app, { config: source, sessions });
registerMenuRoute(app, {
  config: source,
  sessions,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
  serviceCatalog: serviceLayer,
});
registerLandingRoute(app, { config: source, sessions });
registerInstanceRoute(app, { config: source, sessions });
registerEndpointRoute(app, { config: source, sessions });
registerTopologyRoute(app, { config: source, sessions });
registerLayerServicesRoute(app, { config: source, sessions });
registerEndpointDependencyRoute(app, { config: source, sessions });
registerTraceRoutes(app, { config: source, sessions });
registerTraceTagRoutes(app, { config: source, sessions });
registerZipkinRoutes(app, { config: source, sessions });
registerLogRoute(app, { config: source, sessions });
registerDashboardQueryRoute(app, { config: source, sessions });
registerAlarmsQueryRoutes(app, { config: source, sessions, serviceLayer });
registerPreflightRoutes(app, { config: source, sessions });
registerTtlRoute(app, { config: source, sessions });
registerProfileRoutes(app, { config: source, sessions });
registerEBPFRoutes(app, { config: source, sessions });
registerAsyncProfileRoutes(app, { config: source, sessions });

// ── Config ─────────────────────────────────────────────────────────
registerDashboardConfigRoute(app, { config: source, sessions });
registerLayerTemplateRoutes(app, { config: source, sessions });
// Spawn the bundled-template fs.watch once per process. Skipped in
// tests (each test file imports the loader; a watcher per import
// EMFILEs CI under low ulimits). Production calls this exactly once.
if (process.env.NODE_ENV !== 'test') startLayerTemplateWatcher();
registerAlarmsConfigRoutes(app, { config: source, sessions, audit, store: alarmsStore, serviceLayer });
registerSetupRoutes(app, { config: source, sessions, audit, store: setupStore });
registerOverviewRoutes(app, { config: source, sessions });
registerConfigBundleRoute(app, {
  config: source,
  sessions,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});

// ── Admin ──────────────────────────────────────────────────────────
registerDslCatalogRoutes(app, { config: source, sessions, audit });
registerDslRuleRoutes(app, { config: source, sessions, audit });
registerDslDumpRoutes(app, { config: source, sessions, audit });
registerDslOalRoutes(app, { config: source, sessions, audit });
registerClusterRoutes(app, { config: source, sessions, audit });
registerDebugRoutes(app, { config: source, sessions, audit });
registerInspectRoutes(app, { config: source, sessions, audit });
registerOapConfigRoute(app, { config: source, sessions });
registerAlarmRulesRoutes(app, { config: source, sessions });
registerOverviewTemplatesAdminRoutes(app, { config: source, sessions });
registerAuthStatusRoutes(app, { config: source, ldapHealth, sessions });
registerAdminUsersRoute(app, { config: source, seenCache });
registerTemplateSyncAdminRoutes(app, {
  config: source,
  sessions,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});

// Serve the built SPA out of the BFF when a static dir is configured.
// Two paths to set it:
//   - HORIZON_STATIC_DIR env var (Docker image layout: /app/static).
//   - server.staticDir in horizon.yaml (local dev / operator-managed).
// The env var wins when both are set so the image's default isn't
// silently shadowed by a stale YAML value. Vite dev-server on :9091 is
// still the right path during UI development; this branch is for the
// "serve the built SPA from the BFF" workflow.
const staticDir = (() => {
  const raw = process.env.HORIZON_STATIC_DIR ?? source.current.server.staticDir;
  return raw ? resolvePath(raw) : null;
})();
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
  version: process.env.HORIZON_VERSION ?? '0.6.0-dev',
  sessions: sessions.size(),
}));

const { host, port } = source.current.server;
app.listen({ host, port }).then(
  () => {
    logger.info(`BFF listening on http://${host}:${port}`);
    // Fire-and-forget the boot-time OAP template seed: list OAP, POST any
    // bundled template that's missing on the OAP side. This is the ONLY
    // path that writes implicitly to OAP — runtime sync is read-only.
    // Failures are non-fatal: the BFF stays up, the UI falls back to
    // bundled templates and shows the read-only banner.
    void bootSeed({
      client: buildOapClients(source.current).uiTemplate(),
      bundled: () => iterateBundledTemplates(),
      bundledOverlays: () => iterateBundledOverlays(),
      logger,
    })
      .then((status) => {
        if (status.unreachable) {
          logger.warn(
            { lastSuccessfulSyncAt: status.lastSuccessfulSyncAt },
            'OAP UI-template boot seed: admin unreachable, rendering bundled (admin pages will be read-only until OAP comes back)',
          );
        } else {
          const counts = countByStatus(status.rows);
          logger.info(counts, 'OAP UI-template boot seed: complete');
        }
      })
      .catch((err) => {
        logger.error({ err }, 'OAP UI-template boot seed: unexpected error');
      });
  },
  (err) => {
    logger.fatal({ err }, 'failed to start BFF');
    process.exit(1);
  },
);

function countByStatus(rows: Array<{ status: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

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
