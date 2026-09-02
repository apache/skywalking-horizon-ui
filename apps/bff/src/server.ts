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
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { SessionStore } from './user/sessions.js';
import { TokenStore } from './user/tokens.js';
import { LdapHealth } from './user/ldap-health.js';
import { UserSeenCache } from './user/seen-cache.js';
import { loadConfig, type ConfigSource, BootstrapError } from './config/loader.js';
import { makeRouteAuthHook } from './rbac/route-policy.js';
// User
import { registerAuthRoutes } from './http/user.js';
import { registerOidcRoutes } from './user/oidc/route.js';
// Query (read-only data from OAP)
import { registerOapInfoRoute } from './http/query/info.js';
import { registerMenuRoute } from './http/query/menu.js';
import { registerLandingRoute } from './http/query/landing.js';
import { registerInstanceRoute } from './http/query/instance.js';
import { registerEndpointRoute } from './http/query/endpoint.js';
import { registerTopologyRoute } from './http/query/topology.js';
import { registerInstanceTopologyRoute } from './http/query/instance-topology.js';
import { registerDeploymentRoute } from './http/query/deployment.js';
import { registerLayerServicesRoute } from './http/query/services.js';
import { registerEndpointDependencyRoute } from './http/query/endpoint-dependency.js';
import { registerTraceRoutes } from './http/query/trace.js';
import { registerTraceTagRoutes } from './http/query/trace-tag.js';
import { registerZipkinRoutes } from './http/query/zipkin.js';
import { registerLogRoute } from './http/query/log.js';
import { registerEvaluationRecordRoute } from './http/query/evaluation-record.js';
import { registerBrowserErrorsRoute } from './http/query/browser-errors.js';
import { registerEventsRoute } from './http/query/events.js';
import { registerExploreRoutes } from './http/query/explore.js';
import { registerPodLogRoutes } from './http/query/pod-log.js';
import { registerDashboardQueryRoute } from './http/query/dashboard.js';
import { registerMqeExecRoute } from './http/query/mqe-exec.js';
import { registerAlarmsQueryRoutes } from './http/query/alarms.js';
import { registerAiRoutes } from './ai/chat-assistant/route.js';
import { registerMcpRoutes } from './ai/mcp/route.js';
import { registerOAuthRoutes } from './oauth/route.js';
import { RoleResolver } from './user/roles.js';
import { OAuthTokenResolver } from './oauth/tokens.js';
import { registerPreflightRoutes } from './http/query/preflight.js';
import { registerTtlRoute } from './http/query/ttl.js';
import { registerProfileRoutes } from './http/query/profile.js';
import { registerEBPFRoutes } from './http/query/ebpf.js';
import { registerContinuousProfilingRoutes } from './http/query/continuous-profiling.js';
import { registerAsyncProfileRoutes } from './http/query/async-profile.js';
// Config (CRUD for templates / settings)
import { registerDashboardConfigRoute } from './http/config/dashboard.js';
import { registerLayerTemplateRoutes } from './http/config/layer-template.js';
import { startLayerTemplateWatcher } from './logic/layers/loader.js';
import { registerInfra3dConfigRoutes } from './http/config/infra-3d.js';
import { registerInfra3dMetricsRoute } from './http/query/infra-3d-metrics.js';
import { registerOverviewRoutes } from './http/config/overview.js';
import { registerConfigBundleRoute } from './http/config/bundle.js';
import { registerSettingsRoute } from './http/config/settings.js';
import { registerTemplateSyncAdminRoutes } from './http/admin/template-sync.js';
import { buildOapClients } from './client/index.js';
import { wireLog } from './client/wire-log.js';
import { bootSeed, waitForOapAdminReady, setTemplateReadOnly } from './logic/templates/sync.js';
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
import { registerSourceMapRoutes } from './http/admin/source-maps.js';
import { registerAuthHealthRoute } from './http/auth-health.js';
import { registerColdStageHook } from './util/duration.js';
// Logic / stores
import { SourceMapStore } from './logic/browser-errors/store.js';
import { serviceLayerCatalog } from './logic/services/service-layer-catalog.js';
import { HttpError } from './errors.js';
import { logger, loggerOptions } from './logger.js';
import { SECURITY_HEADERS, API_CACHE_CONTROL, isApiPath } from './util/security-headers.js';
import { createAuditService } from './store/audit/index.js';
import { registerAuditRoutes } from './http/admin/audit.js';

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
  if (err instanceof ZodError) {
    // A bad value (often a HORIZON_* env override): surface the field path +
    // reason instead of a raw zod dump. Booleans accept only true/false,
    // numbers must be numeric, and JSON env vars must be valid JSON.
    const issues = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    logger.fatal(
      { issues, configPath },
      'BFF refusing to start: config validation failed — check the value (and any HORIZON_* env override) at each path. Booleans must be true/false; numbers must be numeric; JSON env vars must be valid JSON',
    );
    process.exit(1);
  }
  throw err;
}
logger.info(
  {
    configPath: source.path,
    backend: source.current.auth.backend,
    templatesMode: source.current.templates.mode,
  },
  'config loaded',
);
// Template source mode is fixed at BOOT — it selects the boot-seed/source
// path (live seeds + reads OAP; readonly skips the seed + renders bundled).
// A hot-reload flip can't safely take effect (readonly→live would need the
// boot seed that already ran/was-skipped), so we capture it once and only
// warn if the file later changes it.
const bootTemplatesMode = source.current.templates.mode;
setTemplateReadOnly(bootTemplatesMode === 'readonly');
if (source.current.auth.backend === 'ldap' && source.current.auth.local.users.length > 0) {
  logger.warn(
    { users: source.current.auth.local.users.length },
    'auth.local.users is populated but auth.backend is "ldap"; local users are ignored',
  );
}
source.onChange((cfg) => {
  logger.info({ backend: cfg.auth.backend, templatesMode: cfg.templates.mode }, 'config reloaded');
  if (cfg.templates.mode !== bootTemplatesMode) {
    logger.warn(
      { from: bootTemplatesMode, to: cfg.templates.mode },
      'templates.mode change needs a BFF restart to take effect (boot-time seed + source selection); keeping the boot mode',
    );
  }
});

// `trustProxy` decides whether X-Forwarded-For is believed for `req.ip`,
// which is what the audit log records as the client address. Read once:
// Fastify is constructed once, so this cannot hot-reload — it is on the
// documented restart-required list beside the listener.
const app = Fastify({
  logger: loggerOptions,
  trustProxy: source.current.server.trustProxy,
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) {
    return reply.status(err.statusCode).send({ code: err.code, message: err.message, details: err.details });
  }
  // Never leak an internal / upstream exception message to the client — it can
  // carry upstream response snippets or endpoint details. Log it server-side,
  // return a generic body plus the request id for correlation; dev keeps the
  // raw message for debugging.
  reply.log.error({ err }, 'unhandled');
  const isDev = process.env.NODE_ENV === 'development';
  return reply.status(500).send({
    code: 'internal_error',
    message: isDev && err instanceof Error ? err.message : 'internal error',
    requestId: req.id,
  });
});

// Security headers on every response — CSP, MIME-sniff, clickjacking,
// referrer leakage. Defense-in-depth for the console behind the operator's
// ingress; no third-party dependency. The AI SSE route hijacks the reply and
// therefore bypasses this hook, so it writes the same map itself.
app.addHook('onSend', (req, reply, payload, done) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  // Static assets are content-hashed and stay cacheable; API data never is.
  if (isApiPath(req.url)) reply.header('Cache-Control', API_CACHE_CONTROL);
  done(null, payload);
});

/** Reported on /api/health and as the MCP server version an agent sees. */
const HORIZON_VERSION = process.env.HORIZON_VERSION ?? '1.1.0-dev';

const sessions = new SessionStore({ ttlMinutes: () => source.current.session.ttlMinutes });
// API tokens ride the same pre-handler as the session cookie, so every route
// accepts one under the verb policy it already declares (user/tokens.ts).
const tokens = new TokenStore(source);
// OAuth access tokens Horizon issued itself. Both non-cookie credentials
// resolve roles through the same resolver, so they cannot disagree about what
// a user currently holds.
const roleResolver = new RoleResolver(source);
const oauthTokens = new OAuthTokenResolver(source, roleResolver);
/**
 * The credential set EVERY route authenticates against, spread into each
 * registration rather than restated. Listing them per call site is how one call
 * site ends up missing one, and a route that quietly rejects a valid token is
 * not a failure anyone notices until a user reports it.
 */
// The audit log. Always constructed: a deployment with the feature off gets a
// no-op service, so no emit site needs a null check. It records SIGN-INS only,
// and only ones a valid credential produced.
const audit = createAuditService({ audit: source.current.audit });

const authDeps = { config: source, sessions, tokens, oauthTokens, audit };
// Wire-level OAP debug log (`debugLog` in horizon.yaml) — reads the live
// config per call, so `enabled` / `file` / redaction all hot-reload.
wireLog.init(() => source.current.debugLog);
const ldapHealth = new LdapHealth();
const seenCache = new UserSeenCache();

// In-memory source-map cache for the Browser Errors tab (#6784). Process-
// global (NOT per-session); statically-mounted maps are indexed once here.
// The store reads config through a live getter so `enabled` + the budgets
// hot-reload with horizon.yaml. (The multipart hard-cap below is the one
// exception — it's fixed at registration, so raising maxFileBytes needs a
// restart; the store still enforces the live value for everything else.)
const sourceMapStore = new SourceMapStore(() => source.current.sourceMaps);
await sourceMapStore.loadMountDir(source.current.sourceMaps.bootMountDir);
// Server-global service-by-layer index — shared by the sidebar menu, the
// alarms tagger, and any other surface that needs the service ↔ layer
// mapping. 60s TTL + single-flight dedup; one OAP fan-out per minute
// regardless of how many routes are polling.
const serviceLayer = serviceLayerCatalog({ config: source });

await app.register(cookie);

// Multipart for source-map (.map) uploads on the Browser Errors tab. The
// fileSize cap mirrors `sourceMaps.maxFileBytes` so an oversized stream is
// rejected before it's buffered; the store re-checks the live value too.
await app.register(fastifyMultipart, {
  limits: { fileSize: source.current.sourceMaps.maxFileBytes, files: 1 },
});

// Text/plain body parser — the rule editor sends raw YAML to /api/rule.
app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));

/**
 * Form-encoded bodies, for the OAuth token endpoint.
 *
 * RFC 6749 §4.1.3 REQUIRES the token endpoint to accept
 * `application/x-www-form-urlencoded`, and every conformant client sends it —
 * Fastify parses only JSON out of the box, so without this the endpoint threw
 * on the one content type it is obliged to read, and the caller got a 500
 * error envelope where it expected `access_token`. That failure looked like a
 * client bug from both ends, which is how it survived: exchanges tested with a
 * JSON body worked perfectly.
 *
 * Hand-rolled rather than @fastify/formbody: it is one call to URLSearchParams,
 * and Fastify's bodyLimit already bounds what reaches it.
 */
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (err) {
      done(err instanceof Error ? err : new Error('malformed form body'), undefined);
    }
  },
);

// Map the UI's cold-stage header (X-Horizon-Cold-Stage) onto
// `req.coldStage` so every downstream Duration helper sees one boolean
// instead of re-parsing the header. BanyanDB-only at the OAP layer;
// other backends silently ignore the resulting Duration.coldStage:true.
registerColdStageHook(app);

// Auto-apply RBAC pre-handlers to every route as it's registered. Must
// be added BEFORE the route registrations below — onRoute fires for
// each subsequent app.get/post/...
app.addHook('onRoute', makeRouteAuthHook({ ...authDeps }));

// ── User ───────────────────────────────────────────────────────────
registerAuthRoutes(app, { ...authDeps, ldapHealth, seenCache, audit });
registerAuthHealthRoute(app, { config: source, ldapHealth });
registerAuditRoutes(app, { ...authDeps, audit });
registerOidcRoutes(app, { ...authDeps, seenCache, audit });

// ── Query ──────────────────────────────────────────────────────────
registerOapInfoRoute(app, { ...authDeps });
registerMenuRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
  serviceCatalog: serviceLayer,
});
registerLandingRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerInstanceRoute(app, { ...authDeps });
registerEndpointRoute(app, { ...authDeps });
registerTopologyRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerInstanceTopologyRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerDeploymentRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerLayerServicesRoute(app, { ...authDeps });
registerEndpointDependencyRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerTraceRoutes(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerTraceTagRoutes(app, { ...authDeps });
registerZipkinRoutes(app, { ...authDeps });
registerLogRoute(app, { ...authDeps });
registerEvaluationRecordRoute(app, { ...authDeps });
registerBrowserErrorsRoute(app, { ...authDeps });
registerEventsRoute(app, { ...authDeps });
registerExploreRoutes(app, { ...authDeps });
registerPodLogRoutes(app, { ...authDeps });
registerDashboardQueryRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerMqeExecRoute(app, { ...authDeps });
registerAlarmsQueryRoutes(app, { ...authDeps, serviceLayer });
registerAiRoutes(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerOAuthRoutes(app, {
  ...authDeps,
  roles: roleResolver,
});
registerMcpRoutes(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
  version: HORIZON_VERSION,
});
registerPreflightRoutes(app, { ...authDeps });
registerTtlRoute(app, { ...authDeps });
registerProfileRoutes(app, { ...authDeps });
registerEBPFRoutes(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerAsyncProfileRoutes(app, { ...authDeps });
registerContinuousProfilingRoutes(app, { ...authDeps });

// ── Config ─────────────────────────────────────────────────────────
registerDashboardConfigRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerLayerTemplateRoutes(app, { ...authDeps });
// Spawn the bundled-template fs.watch ONLY in development. Bundled
// templates ship inside the BFF image — they're immutable in prod
// (rebuild + redeploy is how you'd change them), so an fs.watch on
// `bundled_templates/` is pure overhead there. `tsx watch` only
// reloads on `.ts` edits, so during local dev the watcher lets a
// JSON edit (layer template, overlay catalog) take effect without
// a manual restart. Tests skip it for the same EMFILE reason as
// before (each test file imports the loader; a watcher per import
// would exhaust the fd ceiling on low-ulimit CI).
if (process.env.NODE_ENV === 'development') startLayerTemplateWatcher();
registerInfra3dConfigRoutes(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerInfra3dMetricsRoute(app, { ...authDeps });
registerOverviewRoutes(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerConfigBundleRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});
registerSettingsRoute(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});

// ── Admin ──────────────────────────────────────────────────────────
registerDslCatalogRoutes(app, { ...authDeps });
registerDslRuleRoutes(app, { ...authDeps });
registerDslDumpRoutes(app, { ...authDeps });
registerDslOalRoutes(app, { ...authDeps });
registerClusterRoutes(app, { ...authDeps });
registerDebugRoutes(app, { ...authDeps });
registerInspectRoutes(app, { ...authDeps });
registerOapConfigRoute(app, { ...authDeps });
registerAlarmRulesRoutes(app, { ...authDeps });
registerOverviewTemplatesAdminRoutes(app, { ...authDeps });
registerAuthStatusRoutes(app, { ...authDeps, ldapHealth });
registerAdminUsersRoute(app, { config: source, seenCache });
registerSourceMapRoutes(app, { ...authDeps, store: sourceMapStore });
registerTemplateSyncAdminRoutes(app, {
  ...authDeps,
  uiTemplateClient: () => buildOapClients(source.current).uiTemplate(),
});

// Who serves the UI is a function of how the BFF was started, not of
// configuration:
//   - dev (`pnpm dev`): Vite on :9091 owns the UI and proxies /api here,
//     so this process is correctly API-only and no static dir exists.
//   - packaged (binary tarball or Docker image): `static/` always sits
//     next to server.js, so its location is a structural fact — probed
//     like bundled_templates rather than asked of the operator.
// HORIZON_STATIC_DIR / server.staticDir remain as an override for a
// layout that differs from either (the image sets the env var explicitly).
const staticDir = (() => {
  const raw = process.env.HORIZON_STATIC_DIR ?? source.current.server.staticDir;
  if (raw) return resolvePath(raw);
  const sibling = join(dirname(fileURLToPath(import.meta.url)), 'static');
  return existsSync(sibling) ? sibling : null;
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
} else if (process.env.NODE_ENV === 'development') {
  logger.info('dev mode — API only; the Vite dev server serves the UI');
} else {
  // Packaged layouts always ship `static/` beside server.js, so reaching
  // here means the tree is incomplete (or an override points nowhere).
  logger.warn(
    'no UI found next to server.js — running API-only, `/` will 404. Check the packaged layout is intact, or point HORIZON_STATIC_DIR at the built UI.',
  );
}

// Public liveness probe. Intentionally minimal — kept identifier-free so
// an unauthenticated caller can confirm "the BFF is up" without leaking
// operational details (session count, OAP reachability, etc.). Detailed
// state lives behind /api/auth/health (which requires auth) and the
// admin status pages.
app.get('/api/health', async () => ({
  status: 'ok',
  version: HORIZON_VERSION,
}));

const { host, port } = source.current.server;
// AbortController bound to shutdown so the readiness wait can exit
// cleanly when the BFF is signal-killed mid-backoff (k8s rolling
// restart, ctrl-c, etc.) instead of holding the process open.
const bootSeedAbort = new AbortController();
app.listen({ host, port }).then(
  () => {
    logger.info(`BFF listening on http://${host}:${port}`);
    // Opens the store and starts the one timer the feature has. Never
    // rejects: a store that cannot be reached logs and is retried on the
    // tick, because an optional feature must not hold up the console.
    void audit.start();
    // Wait for OAP admin readiness, then run the boot-time template
    // seed ONCE. Two-phase so we don't lose the seed when OAP is still
    // starting up alongside the BFF (compose / k8s rollout, slow OAP
    // module wiring). The wait is a backoff loop that warn-logs each
    // failed ping; once `client.list()` succeeds we run bootSeed and
    // never touch the admin port from here again until an operator
    // admin action triggers a fresh sync. The seed itself is
    // absent-only (`seedMissing` skips templates already present), so
    // a successful previous boot leaves nothing to re-push.
    // readonly mode renders from the disk bundle and never touches the
    // ui_template store — skip the readiness wait + seed entirely (otherwise
    // the backoff loop warn-spams forever against an absent/disabled admin
    // surface). The OAP *query* reachability check is independent and stays.
    if (source.current.templates.mode === 'readonly') {
      logger.info('templates.mode=readonly — rendering bundled templates, ui_template store not used');
      return;
    }
    void (async (): Promise<void> => {
      const deps = {
        client: buildOapClients(source.current).uiTemplate(),
        bundled: () => iterateBundledTemplates(),
        bundledOverlays: () => iterateBundledOverlays(),
        logger,
      };
      try {
        await waitForOapAdminReady(deps, bootSeedAbort.signal);
        if (bootSeedAbort.signal.aborted) return;
        const status = await bootSeed(deps);
        if (status.unreachable) {
          // Admin port flapped between readiness probe and the actual
          // `bootSeed.list()` — very narrow window, but log it the
          // same way so the operator notices.
          logger.warn(
            { lastSuccessfulSyncAt: status.lastSuccessfulSyncAt },
            'OAP UI-template boot seed: admin became unreachable between readiness and seed',
          );
        } else {
          const counts = countByStatus(status.rows);
          logger.info(counts, 'OAP UI-template boot seed: complete');
        }
      } catch (err) {
        logger.error({ err }, 'OAP UI-template boot seed: unexpected error');
      }
    })();
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
  // Cancel an in-flight OAP-admin readiness wait so the boot-seed
  // promise resolves quickly instead of blocking shutdown.
  bootSeedAbort.abort();
  await app.close();
  // AFTER the HTTP server stops accepting, so the final flush is not racing
  // new sign-ins.
  await audit.stop();
  await sessions.close();
  await wireLog.close();
  await source.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
