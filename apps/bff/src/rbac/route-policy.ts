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
 * Single source of truth for which RBAC verb gates each route.
 *
 *   - 'public'  → no auth, no verb (login / logout / health).
 *   - 'auth'    → authenticated session required, no verb check.
 *                 Used for routes the shell itself needs to render
 *                 (menu, oap-info, preflight, configs bundle, /me).
 *   - '<verb>'  → authenticated session + verb grant required.
 *
 * The `onRoute` hook in `server.ts` reads this table and attaches the
 * appropriate pre-handler to each registered route. Adding a new route
 * without a policy entry logs a warning at startup and defaults to
 * 'auth' (fail-safe: at least require login, never silently open).
 */

import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { sessionHasVerb } from './policy.js';
import type { AuthDeps } from '../user/middleware.js';
import { requireAuth } from '../user/middleware.js';
import { logger } from '../logger.js';

export type RoutePolicy = 'public' | 'auth' | string;

/**
 * Verb-only check. Assumes a prior pre-handler (`requireAuth`) has
 * already populated `req.session`; sends 401 if not.
 */
export function checkVerb(deps: AuthDeps, verb: string) {
  return async function verbOnlyPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = req.session;
    if (!session) {
      return void reply.code(401).send({ error: 'unauthenticated' });
    }
    if (!sessionHasVerb(deps.config.current, session.roles, verb)) {
      return void reply.code(403).send({ error: 'permission_denied', verb });
    }
  };
}

/** Routes keyed by `${METHOD} ${url}` (method uppercase, url as registered with `:param` placeholders). */
export const ROUTE_POLICY: Record<string, RoutePolicy> = {
  // ── Public (no auth) ─────────────────────────────────────────────
  'POST /api/auth/login':                          'public',
  'POST /api/auth/logout':                         'public',
  'GET /api/health':                               'public',
  'GET /api/auth/health':                          'public',

  // ── Auth-only (every authenticated user) ─────────────────────────
  // Anything the shell needs to render before the user lands anywhere.
  'GET /api/auth/me':                              'auth',
  'GET /api/oap/info':                             'auth',
  'GET /api/menu':                                 'auth',
  'GET /api/preflight':                            'auth',
  'GET /api/configs/bundle':                       'auth',

  // ── Alarms (read) ────────────────────────────────────────────────
  'GET /api/alarms':                               'alarms:read',
  'GET /api/alarms/count':                         'alarms:read',
  'GET /api/alarms/services':                      'alarms:read',

  // ── Traces (read) ────────────────────────────────────────────────
  'POST /api/layer/:key/traces':                   'traces:read',
  'GET /api/trace/:traceId':                       'traces:read',
  'GET /api/trace-tags/keys':                      'traces:read',
  'GET /api/trace-tags/values':                    'traces:read',
  'GET /api/zipkin/services':                      'traces:read',
  'GET /api/zipkin/spans':                         'traces:read',
  'GET /api/zipkin/remote-services':               'traces:read',
  'GET /api/zipkin/traces':                        'traces:read',
  'GET /api/zipkin/trace/:traceId':                'traces:read',
  'GET /api/zipkin/autocomplete/keys':             'traces:read',
  'GET /api/zipkin/autocomplete/values':           'traces:read',
  'GET /api/zipkin/traceMany':                     'traces:read',

  // ── Logs (read) ──────────────────────────────────────────────────
  'POST /api/layer/:key/logs':                     'logs:read',
  'POST /api/layer/:key/logs/facets':              'logs:read',
  'GET /api/log-tags/keys':                        'logs:read',
  'GET /api/log-tags/values':                      'logs:read',
  'GET /api/layer/:key/pod-logs/containers':       'logs:read',
  'POST /api/layer/:key/pod-logs':                 'logs:read',

  // ── Topology (read) ──────────────────────────────────────────────
  'GET /api/layer/:key/topology':                  'topology:read',
  'GET /api/layer/:key/instance-topology':         'topology:read',
  'GET /api/layer/:key/endpoint-dependency':       'topology:read',
  'GET /api/layer/:key/service-hierarchy':         'topology:read',

  // ── Metrics & layer-level reads ──────────────────────────────────
  'POST /api/layer/:key/dashboard':                'metrics:read',
  'GET /api/layer/:key/dashboard/config':          'metrics:read',
  'POST /api/layer/:key/landing':                  'metrics:read',
  'GET /api/layer/:key/instances':                 'metrics:read',
  'GET /api/layer/:key/endpoints':                 'metrics:read',
  'GET /api/layer/:key/services':                  'metrics:read',

  // ── Profiling — agent / async / pprof / eBPF / eBPF network ──────
  // GETs + analyze are reads; POST <family>/tasks creates a task.
  'GET /api/layer/:key/profile/tasks':             'profile:read',
  'POST /api/layer/:key/profile/tasks':            'profile:enable',
  'GET /api/profile/tasks/:taskId/segments':       'profile:read',
  'GET /api/profile/tasks/:taskId/logs':           'profile:read',
  'POST /api/profile/analyze':                     'profile:read',

  'GET /api/layer/:key/async/tasks':               'profile:read',
  'POST /api/layer/:key/async/tasks':              'profile:enable',
  'GET /api/async/tasks/:taskId/progress':         'profile:read',
  'POST /api/async/analyze':                       'profile:read',

  'GET /api/layer/:key/pprof/tasks':               'profile:read',
  'POST /api/layer/:key/pprof/tasks':              'profile:enable',
  'GET /api/pprof/tasks/:taskId/progress':         'profile:read',
  'POST /api/pprof/analyze':                       'profile:read',

  'GET /api/layer/:key/ebpf/tasks':                'profile:read',
  'POST /api/layer/:key/ebpf/tasks':               'profile:enable',
  'GET /api/ebpf/tasks/:taskId/schedules':         'profile:read',
  'POST /api/ebpf/analyze':                        'profile:read',
  // eBPF network sub-family (extra surface beyond the cpu profiler).
  'GET /api/layer/:key/ebpf/network/tasks':        'profile:read',
  'POST /api/layer/:key/ebpf/network/tasks':       'profile:enable',
  'GET /api/ebpf/network/tasks':                   'profile:read',
  'POST /api/ebpf/network/tasks':                  'profile:enable',
  'GET /api/ebpf/network/topology':                'profile:read',
  'POST /api/layer/:key/ebpf/network/process-relation-metrics': 'profile:read',
  'POST /api/ebpf/network/tasks/:taskId/keep-alive': 'profile:enable',

  // ── Config — alarm-page setup, layer setup, overview, dashboards ─
  'GET /api/alarms/config':                        'alarm-setup:read',
  'POST /api/alarms/config':                       'alarm-setup:write',
  'GET /api/infra-3d/config':                      'infra-3d:read',
  'POST /api/infra-3d/metrics':                    'infra-3d:read',
  'GET /api/setup':                                'setup:read',
  'POST /api/setup':                               'setup:write',
  'GET /api/overview/dashboards':                  'overview:read',
  'GET /api/overview/dashboards/:id':              'overview:read',
  'GET /api/admin/layer-templates':                'dashboard:read',
  // POST /api/admin/layer-templates/:key removed — updates go through
  // `/api/admin/templates/save` (OAP-backed). See template-sync.ts.

  // ── DSL / OAL / MQE rules (admin operate) ────────────────────────
  'GET /api/rule':                                 'rule:read',
  'POST /api/rule':                                'rule:write',
  'POST /api/rule/inactivate':                     'rule:write',
  'POST /api/rule/delete':                         'rule:delete',
  'GET /api/dump':                                 'rule:debug',
  'GET /api/dump/:catalog':                        'rule:debug',
  'GET /api/oal/files':                            'rule:read',
  'GET /api/oal/files/:name':                      'rule:read',
  'GET /api/oal/rules':                            'rule:read',
  'GET /api/oal/rules/:source':                    'rule:read',
  'GET /api/catalog/list':                         'rule:read',
  'GET /api/catalog/bundled':                      'rule:read',

  // ── Platform monitoring (read) ───────────────────────────────────
  'GET /api/cluster/state':                        'cluster:read',
  'GET /api/inspect/metrics':                      'inspect:read',
  'GET /api/inspect/catalog':                      'inspect:read',
  'GET /api/inspect/mqe-target':                   'inspect:read',
  'GET /api/inspect/server-time':                  'inspect:read',
  'POST /api/inspect/exec':                        'inspect:read',
  'GET /api/inspect/entities':                     'inspect:read',
  'GET /api/oap/ttl':                              'ttl:read',
  'GET /api/oap/config':                           'config:read',

  // ── Live debugger (admin operate) ────────────────────────────────
  'POST /api/debug/session':                       'live-debug:write',
  'GET /api/debug/session/:id':                    'live-debug:read',
  'POST /api/debug/session/:id/stop':              'live-debug:write',
  'GET /api/debug/sessions':                       'live-debug:read',
  'GET /api/debug/status':                         'live-debug:read',

  // ── Alarm-rule catalog (admin read-only) ─────────────────────────
  'GET /api/admin/alarm-rules':                    'alarm-rule:read',
  'GET /api/admin/alarm-rules/:id':                'alarm-rule:read',
  'GET /api/admin/alarm-rules/:id/context':        'alarm-rule:read',

  // ── Overview-template editor (admin) ─────────────────────────────
  // The admin editor is an operate-only surface — even reading the
  // template catalog here needs `overview:write` (operator / admin).
  // Plain viewers/maintainers consume rendered overviews via
  // `GET /api/overview/dashboards`, which stays `overview:read`.
  'GET /api/admin/overview-templates':             'overview:write',
  'GET /api/admin/overview-templates/:id':         'overview:write',
  'POST /api/admin/overview-templates':            'overview:write',
  // POST /api/admin/overview-templates/:id removed — operator updates
  // now go through `/api/admin/templates/save` (OAP-backed). Bundled
  // JSON is immutable at runtime.
  'DELETE /api/admin/overview-templates/:id':      'overview:write',

  // ── Template sync (admin) — OAP UI-template REST overlay ─────────
  // Read = anyone with overview:read can see status. Write actions
  // (push-bundled, save, resync) need overview:write because save is
  // the only path that mutates OAP UI-templates.
  'GET /api/admin/templates/sync-status':          'overview:read',
  'GET /api/admin/templates/:name/i18n/:locale':   'overview:read',
  'POST /api/admin/templates/resync':              'overview:write',
  'POST /api/admin/templates/resolve-conflicts':   'overview:write',
  'POST /api/admin/templates/save':                'overview:write',
  'POST /api/admin/templates/save-translation':    'overview:write',
  'POST /api/admin/templates/delete-translation':  'overview:write',
  'POST /api/admin/templates/save-local':          'overview:write',
  'POST /api/admin/templates/disable':             'overview:write',
  'POST /api/admin/templates/revert-local':        'overview:write',
  'POST /api/admin/templates/:name/push-bundled':  'overview:write',
  'POST /api/admin/templates/sync-all':            'overview:write',

  // ── Auth/admin self-introspection ────────────────────────────────
  'GET /api/admin/auth-status':                    'auth:read',
  'POST /api/admin/auth-status/probe':             'auth:read',
  'GET /api/admin/users':                          'user:read',
};

/**
 * Hook to attach to Fastify via `app.addHook('onRoute', ...)`. Inspects
 * each route as it is registered, looks up the policy, and appends the
 * appropriate pre-handler.
 *
 * Existing routes that already declare their own `requireAuth`
 * pre-handler keep it; we only append the verb check on top — the
 * double-auth call is O(1) and the cost is negligible compared with
 * the upstream OAP fetch most handlers perform.
 */
export function makeRouteAuthHook(deps: AuthDeps) {
  return function onRoute(route: RouteOptions): void {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    // A route can be registered for multiple methods; if any one needs
    // a different policy than the others, that's a misconfiguration.
    // We honor the first policy found and warn otherwise.
    let chosen: RoutePolicy | null = null;
    let chosenKey: string | null = null;
    for (const m of methods) {
      const M = String(m).toUpperCase();
      const key = `${M} ${route.url}`;
      // Fastify auto-registers HEAD for every GET (RFC-correct: HEAD
      // returns the same data with no body). Same data → same RBAC, so
      // fall back to the GET sibling's policy when HEAD isn't enumerated
      // explicitly. The policy table only carries GET entries.
      const p = ROUTE_POLICY[key] ?? (M === 'HEAD' ? ROUTE_POLICY[`GET ${route.url}`] : undefined);
      if (p === undefined) continue;
      if (chosen !== null && chosen !== p) {
        logger.warn(
          { url: route.url, methods, conflicting: [chosenKey, key] },
          'rbac: route registered for multiple methods with divergent policies; using the first',
        );
        break;
      }
      chosen = p;
      chosenKey = key;
    }
    if (chosen === null) {
      // Don't gate Fastify's catch-all SPA fallback or any non-API route.
      if (route.url === '*' || route.url.startsWith('/metrics')) return;
      // For `/api/*` routes a missing policy entry is a hard error —
      // silently defaulting to auth-only is how unintended write
      // endpoints (create-task, log-facets, etc.) end up reachable by
      // any logged-in viewer. Fail loudly at registration time so the
      // gap surfaces in CI / first boot, not at exploit time.
      if (route.url.startsWith('/api/')) {
        const msg = `rbac: route ${String(methods)} ${route.url} has no entry in ROUTE_POLICY; add one in apps/bff/src/rbac/route-policy.ts`;
        logger.error({ method: methods, url: route.url }, msg);
        throw new Error(msg);
      }
      // Everything else (SPA static — `/`, `/login`, `/assets/*`, etc.,
      // registered by @fastify/static) is inherently public: the served
      // bundle is harmless, and the protected APIs it calls all have
      // their own ROUTE_POLICY entries enforced above. Gating these
      // routes on 'auth' breaks the login page (the browser can't load
      // /login before the user has a session).
      return;
    }
    if (chosen === 'public') return;

    const existing = Array.isArray(route.preHandler)
      ? [...route.preHandler]
      : route.preHandler
        ? [route.preHandler]
        : [];

    // Only prepend auth if no requireAuth-style pre-handler is already
    // there. We detect by name; the function is named `authPreHandler`.
    const hasAuth = existing.some((h) =>
      typeof h === 'function' && h.name === 'authPreHandler',
    );

    const newHandlers = [];
    if (!hasAuth) newHandlers.push(requireAuth(deps));
    if (chosen !== 'auth') newHandlers.push(checkVerb(deps, chosen));

    route.preHandler = [...existing, ...newHandlers];
  };
}
