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
 * Single source of truth for the RBAC verb gating each route.
 *   - 'public' → no auth (login / logout / health).
 *   - 'auth'   → signed-in session, no verb (shell bootstrap routes).
 *   - '<verb>' → signed-in session + that verb grant.
 * The `onRoute` hook (server.ts) attaches the matching pre-handler. A
 * missing `/api/*` entry hard-throws at boot — never silently open.
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

/**
 * Keyed by `${METHOD} ${url}` (url as registered, with `:param` placeholders).
 * Grouped by the lowest built-in role that can reach each route:
 * viewer ⊂ maintainer ⊂ operator ⊂ admin.
 */
export const ROUTE_POLICY: Record<string, RoutePolicy> = {
  // ── Public — no auth ──
  'POST /api/auth/login':                          'public',
  'POST /api/auth/logout':                         'public',
  'GET /api/health':                               'public',
  'GET /api/auth/health':                          'public',

  // ── Authenticated — any signed-in user (shell bootstrap) ──
  'GET /api/auth/me':                              'auth',
  'GET /api/oap/info':                             'auth',
  'GET /api/menu':                                 'auth',
  'GET /api/preflight':                            'auth',
  'GET /api/configs/bundle':                       'auth',

  // ── Viewer — read-only data catalog ──
  'GET /api/alarms':                               'alarms:read',
  'GET /api/alarms/count':                         'alarms:read',
  'GET /api/alarms/services':                      'alarms:read',

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

  'POST /api/layer/:key/logs':                     'logs:read',
  'POST /api/layer/:key/logs/facets':              'logs:read',
  'GET /api/log-tags/keys':                        'logs:read',
  'GET /api/log-tags/values':                      'logs:read',
  'GET /api/layer/:key/pod-logs/containers':       'logs:read',
  'POST /api/layer/:key/pod-logs':                 'logs:read',

  'POST /api/layer/:key/browser-errors':           'browser-errors:read',
  'GET /api/browser-errors/source-maps':           'browser-errors:read',
  'POST /api/browser-errors/resolve':              'browser-errors:read',

  'POST /api/explore/query':                       'inspect:read',

  'GET /api/layer/:key/topology':                  'topology:read',
  'GET /api/layer/:key/instance-topology':         'topology:read',
  'GET /api/layer/:key/deployment':                'topology:read',
  'GET /api/layer/:key/endpoint-dependency':       'topology:read',
  'GET /api/layer/:key/service-hierarchy':         'topology:read',

  'POST /api/layer/:key/dashboard':                'metrics:read',
  'GET /api/layer/:key/dashboard/config':          'metrics:read',
  'POST /api/layer/:key/landing':                  'metrics:read',
  'GET /api/layer/:key/instances':                 'metrics:read',
  'GET /api/layer/:key/endpoints':                 'metrics:read',
  'GET /api/layer/:key/services':                  'metrics:read',

  // Profiling reads — task-creation is operator (profile:enable) below.
  'GET /api/layer/:key/profile/tasks':             'profile:read',
  'GET /api/profile/tasks/:taskId/segments':       'profile:read',
  'GET /api/profile/tasks/:taskId/logs':           'profile:read',
  'POST /api/profile/analyze':                     'profile:read',
  'GET /api/layer/:key/async/tasks':               'profile:read',
  'GET /api/async/tasks/:taskId/progress':         'profile:read',
  'POST /api/async/analyze':                       'profile:read',
  'GET /api/layer/:key/pprof/tasks':               'profile:read',
  'GET /api/pprof/tasks/:taskId/progress':         'profile:read',
  'POST /api/pprof/analyze':                       'profile:read',
  'GET /api/layer/:key/ebpf/tasks':                'profile:read',
  'GET /api/ebpf/tasks/:taskId/schedules':         'profile:read',
  'POST /api/ebpf/analyze':                        'profile:read',
  'GET /api/layer/:key/ebpf/network/tasks':        'profile:read',
  'GET /api/ebpf/network/tasks':                   'profile:read',
  'GET /api/ebpf/network/topology':                'profile:read',
  'POST /api/layer/:key/ebpf/network/process-relation-metrics': 'profile:read',

  'GET /api/overview/dashboards':                  'overview:read',
  'GET /api/overview/dashboards/:id':              'overview:read',
  'GET /api/admin/templates/sync-status':          'overview:read',
  'GET /api/admin/templates/:name/i18n/:locale':   'overview:read',

  'GET /api/infra-3d/config':                      'infra-3d:read',
  'POST /api/infra-3d/metrics':                    'infra-3d:read',

  // ── Maintainer — platform-monitoring reads ──
  'GET /api/cluster/state':                        'cluster:read',
  'GET /api/inspect/metrics':                      'inspect:read',
  'GET /api/inspect/catalog':                      'inspect:read',
  'GET /api/inspect/server-time':                  'inspect:read',
  'POST /api/inspect/exec':                        'inspect:read',
  'GET /api/inspect/entities':                     'inspect:read',
  'GET /api/oap/ttl':                              'ttl:read',
  'GET /api/oap/config':                           'config:read',

  // ── Operator — config / dashboard / rule / diagnostics writes ──
  'GET /api/setup':                                'setup:read',
  'POST /api/setup':                               'setup:write',
  'GET /api/alarms/config':                        'alarm-setup:read',
  'POST /api/alarms/config':                       'alarm-setup:write',

  'GET /api/admin/layer-templates':                'dashboard:read',

  // Overview-template editor + OAP UI-template sync. The editor catalog needs
  // write even to read it; rendered overviews stay 'overview:read' above.
  'GET /api/admin/overview-templates':             'overview:write',
  'GET /api/admin/overview-templates/:id':         'overview:write',
  'POST /api/admin/overview-templates':            'overview:write',
  'DELETE /api/admin/overview-templates/:id':      'overview:write',
  'POST /api/admin/templates/resync':              'overview:write',
  'POST /api/admin/templates/resolve-conflicts':   'overview:write',
  'POST /api/admin/templates/save-translation':    'overview:write',
  'POST /api/admin/templates/delete-translation':  'overview:write',
  // `save-local` is gated 'auth'; same per-kind verb as `save` runs in the handler.
  'POST /api/admin/templates/save-local':          'auth',
  'POST /api/admin/templates/disable':             'overview:write',
  'POST /api/admin/templates/revert-local':        'overview:write',
  'POST /api/admin/templates/:name/push-bundled':  'overview:write',
  'POST /api/admin/templates/sync-all':            'overview:write',
  // `save` is gated 'auth'; the real per-kind verb (layer → dashboard:write,
  // else → overview:write) is enforced in the handler before any OAP write.
  'POST /api/admin/templates/save':                'auth',

  'GET /api/rule':                                 'rule:read',
  'GET /api/rule/status':                          'rule:read',
  'GET /api/oal/files':                            'rule:read',
  'GET /api/oal/files/:name':                      'rule:read',
  'GET /api/oal/rules':                            'rule:read',
  'GET /api/oal/rules/:source':                    'rule:read',
  'GET /api/catalog/list':                         'rule:read',
  'GET /api/catalog/bundled':                      'rule:read',
  'POST /api/rule':                                'rule:write',
  'POST /api/rule/inactivate':                     'rule:write',
  'POST /api/rule/delete':                         'rule:delete',
  'GET /api/dump':                                 'rule:debug',
  'GET /api/dump/:catalog':                        'rule:debug',

  'GET /api/debug/session/:id':                    'live-debug:read',
  'GET /api/debug/sessions':                       'live-debug:read',
  'GET /api/debug/status':                         'live-debug:read',
  'POST /api/debug/session':                       'live-debug:write',
  'POST /api/debug/session/:id/stop':              'live-debug:write',

  'GET /api/admin/alarm-rules':                    'alarm-rule:read',
  'GET /api/admin/alarm-rules/:id':                'alarm-rule:read',
  'GET /api/admin/alarm-rules/:id/context':        'alarm-rule:read',

  'POST /api/layer/:key/profile/tasks':            'profile:enable',
  'POST /api/layer/:key/async/tasks':              'profile:enable',
  'POST /api/layer/:key/pprof/tasks':              'profile:enable',
  'POST /api/layer/:key/ebpf/tasks':               'profile:enable',
  'POST /api/layer/:key/ebpf/network/tasks':       'profile:enable',
  'POST /api/ebpf/network/tasks':                  'profile:enable',
  'POST /api/ebpf/network/tasks/:taskId/keep-alive': 'profile:enable',

  'POST /api/browser-errors/source-maps':          'source-map:write',
  'DELETE /api/browser-errors/source-maps/:id':    'source-map:write',

  // ── Admin — auth + user administration ──
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
