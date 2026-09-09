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
 * The role set a deployment gets when it configures none, and — under
 * `rbac.builtinRoles: keep` — the base a configured block is merged onto.
 *
 * Kept beside the schema rather than inside it: this is a policy decision
 * about who may do what, argued in its own comments, and a reader auditing
 * access should not have to read a validation schema to find it.
 */

/** The roles a deployment gets when it configures none — and, under
 *  `builtinRoles: keep`, the base a configured block is merged onto. */
export const BUILTIN_ROLES: Readonly<Record<string, string[]>> = {
  // Data catalog + the read-only inspect tools (metric / trace / log
  // inspect, all `inspect:read`). Deliberately NOT `*:read` so a viewer
  // can't see rule definitions, live-debug sessions, setup screens, or
  // cluster / TTL / config internals.
  viewer: [
    'metrics:read',
    'alarms:read',
    'events:read',
    'traces:read',
    'logs:read',
    'browser-errors:read',
    'ai-conversation:read',
    'inspect:read',
    'topology:read',
    'profile:read',
    'overview:read',
    'infra-3d:read',
    'ai:read',
    'mcp:read',
  ],
  // Viewer baseline plus the platform-monitoring reads (cluster
  // health + OAP internals). Maintainer's whole job is watching
  // SkyWalking itself.
  maintainer: [
    'metrics:read',
    'alarms:read',
    'events:read',
    'traces:read',
    'logs:read',
    'browser-errors:read',
    'ai-conversation:read',
    'topology:read',
    'profile:read',
    'overview:read',
    'cluster:read',
    'inspect:read',
    'ttl:read',
    'config:read',
    'infra-3d:read',
    'ai:read',
    'mcp:read',
  ],
  // Configures observability: dashboards, alarm rules, DSL/OAL,
  // diagnostics. Inherits viewer + platform reads so operators
  // can verify their changes against live data. No reserved verb is
  // granted here (see RESERVED_VERBS): granting one promises a
  // capability now and silently confers it the day something enforces it.
  operator: [
    'metrics:read',
    'alarms:read',
    'events:read',
    'traces:read',
    'logs:read',
    'browser-errors:read',
    'ai-conversation:read',
    'source-map:write',
    'topology:read',
    'profile:read',
    'cluster:read',
    'inspect:read',
    'ttl:read',
    'config:read',
    'overview:read',
    // The six Dashboard-setup pages, read + write. Viewer and maintainer
    // hold none of these: the rendered dashboards are theirs to read, the
    // stored templates behind them are not.
    'overview-template:read',
    'overview-template:write',
    'layer-template:read',
    'layer-template:write',
    'translation:read',
    'translation:write',
    'setup:read',
    'setup:write',
    'alarm-setup:read',
    'alarm-setup:write',
    'infra-3d-setup:read',
    'infra-3d-setup:write',
    'alarm-rule:read',
    'infra-3d:read',
    'rule:read',
    'rule:write',
    'rule:write:structural',
    'rule:delete',
    'live-debug:read',
    'live-debug:write',
    'profile:enable',
    'ai:read',
    'mcp:read',
  ],
  admin: ['*'],
};

/** Landing route per role; the UI uses this to send users to the page that
 *  fits their job after login. Cluster status lives at `/operate/cluster`
 *  (operator tooling against OAP). */
export const BUILTIN_LANDING_BY_ROLE: Readonly<Record<string, string>> = {
  viewer: '/',
  maintainer: '/operate/cluster',
  operator: '/',
  admin: '/operate/cluster',
};
