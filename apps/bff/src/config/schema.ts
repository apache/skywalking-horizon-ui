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

import { z } from 'zod';

// Env-var-overridable bind defaults. The Docker image sets
// `HORIZON_SERVER_HOST=0.0.0.0` so a zero-config `docker run -p 8081:8081
// horizon-ui:local` reaches the BFF (the YAML default `127.0.0.1` would
// bind container-loopback and silently 502 from the host side). An
// explicit `server.host`/`server.port` in horizon.yaml always wins.
const serverHostDefault = process.env.HORIZON_SERVER_HOST ?? '127.0.0.1';
const serverPortDefault = (() => {
  const raw = process.env.HORIZON_SERVER_PORT;
  if (!raw) return 8081;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8081;
})();
const serverSchema = z
  .object({
    host: z.string().default(serverHostDefault),
    port: z.number().int().positive().default(serverPortDefault),
    staticDir: z.string().optional(),
  })
  .strict();

const oapSchema = z
  .object({
    /** OAP query host (GraphQL + `/status/*`). Single URL — query traffic
     *  is load-balanceable, any OAP node can answer. */
    queryUrl: z.string().url().default('http://127.0.0.1:12800'),
    /** OAP admin host (runtime rule mgmt, DSL/MQE/OAL, inspect, live
     *  debug). Single URL. Most endpoints get a single fire (OAP routes
     *  cluster-internal); live-debug status performs a DNS lookup on
     *  the hostname to discover all node IPs and probes each. */
    adminUrl: z.string().url().default('http://127.0.0.1:17128'),
    timeoutMs: z.number().int().positive().default(15000),
    auth: z
      .object({
        username: z.string().min(1),
        password: z.string().min(1),
      })
      .strict()
      .optional(),
    mqe: z
      .object({
        host: z.string().optional(),
        port: z.number().int().positive().optional(),
      })
      .strict()
      .default({}),
    zipkinUrl: z.string().url().default('http://127.0.0.1:9412/zipkin'),
  })
  .strict();

const localUserSchema = z
  .object({
    username: z.string().min(1),
    passwordHash: z.string().min(1),
    roles: z.array(z.string().min(1)).default([]),
  })
  .strict();

const ldapGroupMappingSchema = z
  .object({
    /** LDAP group DN (or the literal "*" to match any authenticated user). */
    group: z.string().min(1),
    /** Horizon role assigned when the user's group memberships include `group`. */
    role: z.string().min(1),
  })
  .strict();

const ldapSchema = z
  .object({
    /** Directory URL, e.g. `ldaps://ldap.corp:636` or `ldap://localhost:389`. */
    url: z.string().min(1),
    /** Optional service-account DN used for user/group searches.
     *  When empty, an anonymous bind is attempted for searches. */
    bindDn: z.string().default(''),
    /** Service-account password. Supports `${VAR:default}` interpolation
     *  in the YAML; empty means anonymous search. */
    bindPassword: z.string().default(''),
    /** Base DN under which user entries live (e.g. `ou=people,dc=corp`). */
    userBaseDn: z.string().min(1),
    /** Search filter; `{username}` is substituted with the typed username,
     *  escaped per RFC 4515. Default targets the common `uid` attribute. */
    userFilter: z.string().default('(uid={username})'),
    /** Attribute on the user entry that holds the display name. */
    displayNameAttr: z.string().default('cn'),
    /** Group membership strategy:
     *  - `memberOf`  → read the user entry's `memberOf` attribute (AD-style).
     *  - `search`    → search `groupBaseDn` for groups whose `memberAttr`
     *                   contains the user's DN (OpenLDAP-style). */
    groupStrategy: z.enum(['memberOf', 'search']).default('memberOf'),
    /** Base DN under which group entries live. Only used when
     *  `groupStrategy: 'search'`. */
    groupBaseDn: z.string().default(''),
    /** Group attribute that lists members (e.g. `member`, `uniqueMember`).
     *  Only used when `groupStrategy: 'search'`. */
    memberAttr: z.string().default('member'),
    /** Group DN → Horizon role bindings. First match wins; `"*"` matches
     *  every authenticated user. Order matters — put the highest-privilege
     *  rule first if you only want one role per user, or use multiple
     *  entries to assign multiple roles. */
    groupMappings: z.array(ldapGroupMappingSchema).default([]),
    /** Bind / search timeout in ms. */
    timeoutMs: z.number().int().positive().default(5000),
    /** When `true`, skip TLS certificate validation. Use only for dev
     *  directories with self-signed certs; never in production. */
    tlsInsecure: z.boolean().default(false),
  })
  .strict();

const breakGlassSchema = z
  .object({
    /** Username allowed to log in via break-glass. When unset, break-glass
     *  is disabled. */
    username: z.string().min(1),
    /** Argon2id hash of the break-glass password (use `pnpm --filter bff cli:hash`). */
    passwordHash: z.string().min(1),
    /** Roles granted when the break-glass session is established.
     *  Defaults to `['admin']` since the whole point of break-glass is
     *  recovering from a broken auth config. */
    roles: z.array(z.string().min(1)).default(['admin']),
  })
  .strict();

const authSchema = z
  .object({
    /** Active auth backend. Switching to `ldap` causes `auth.local` to be
     *  ignored (a warning is logged at startup if both are populated). */
    backend: z.enum(['local', 'ldap']).default('local'),
    local: z
      .object({
        users: z.array(localUserSchema).default([]),
      })
      .strict()
      .default({ users: [] }),
    ldap: ldapSchema.optional(),
    /** Optional break-glass account, only honored when `backend: 'ldap'`
     *  AND the LDAP probe is currently failing. Logged loudly in the
     *  audit file on every use. */
    breakGlass: breakGlassSchema.optional(),
  })
  .strict()
  .default({ backend: 'local', local: { users: [] } });

const rbacSchema = z
  .object({
    /** When false, every authenticated session is granted `*`. */
    enabled: z.boolean().default(true),
    roles: z
      .record(z.string(), z.array(z.string().min(1)))
      .default({
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
          'inspect:read',
          'topology:read',
          'profile:read',
          'overview:read',
          'infra-3d:read',
          'ai:read',
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
          'topology:read',
          'profile:read',
          'overview:read',
          'cluster:read',
          'inspect:read',
          'ttl:read',
          'config:read',
          'infra-3d:read',
          'ai:read',
        ],
        // Configures observability: dashboards, alarm rules, DSL/OAL,
        // diagnostics. Inherits viewer + platform reads so operators
        // can verify their changes against live data.
        operator: [
          'metrics:read',
          'alarms:read',
          'events:read',
          'traces:read',
          'logs:read',
          'browser-errors:read',
          'source-map:write',
          'topology:read',
          'profile:read',
          'cluster:read',
          'inspect:read',
          'ttl:read',
          'config:read',
          'overview:read',
          'overview:write',
          'setup:read',
          'setup:write',
          'dashboard:read',
          'dashboard:write',
          'alarm-setup:read',
          'alarm-setup:write',
          'alarm-rule:read',
          'alarm-rule:write',
          'infra-3d:read',
          'rule:read',
          'rule:write',
          'rule:write:structural',
          'rule:delete',
          'rule:debug',
          'live-debug:read',
          'live-debug:write',
          'profile:enable',
          'ai:read',
        ],
        admin: ['*'],
      }),
    /** Landing route per role; the UI uses this to send users to the
     *  page that fits their job after login. Cluster status lives at
     *  `/operate/cluster` (operator tooling against OAP). */
    landingByRole: z
      .record(z.string(), z.string())
      .default({
        viewer: '/',
        maintainer: '/operate/cluster',
        operator: '/',
        admin: '/operate/cluster',
      }),
  })
  .strict()
  .default({});

const sessionSchema = z
  .object({
    ttlMinutes: z.number().int().positive().default(60),
    cookieName: z.string().default('horizon_sid'),
    cookieSecure: z.boolean().default(false),
  })
  .strict()
  .default({ ttlMinutes: 60, cookieName: 'horizon_sid', cookieSecure: false });

// Env-var-overridable defaults for the four state-file paths. The
// Docker image sets `HORIZON_*_FILE=/data/...` so an operator running
// the published image without a custom `horizon.yaml` (or with one
// that omits these blocks) gets writes routed to the writable `/data`
// volume instead of `/app` (which is root-owned and EACCESes).
const auditDefault = process.env.HORIZON_AUDIT_FILE ?? './horizon-audit.jsonl';
const setupDefault = process.env.HORIZON_SETUP_FILE ?? './horizon-setup.json';
const alarmsDefault = process.env.HORIZON_ALARMS_FILE ?? './horizon-alarms.json';
const wireLogDefault = process.env.HORIZON_WIRE_LOG_FILE ?? './horizon-wire.jsonl';

const auditSchema = z
  .object({
    file: z.string().default(auditDefault),
  })
  .strict()
  .default({ file: auditDefault });

const setupSchema = z
  .object({
    file: z.string().default(setupDefault),
  })
  .strict()
  .default({ file: setupDefault });

const alarmsSchema = z
  .object({
    file: z.string().default(alarmsDefault),
  })
  .strict()
  .default({ file: alarmsDefault });


const debugLogSchema = z
  .object({
    enabled: z.boolean().default(false),
    file: z.string().default(wireLogDefault),
    maxBodyChars: z.number().int().nonnegative().default(8192),
    redactAuthHeaders: z.boolean().default(true),
  })
  .strict()
  .default({
    enabled: false,
    file: wireLogDefault,
    maxBodyChars: 8192,
    redactAuthHeaders: true,
  });

const querySchema = z
  .object({
    /** Max services a layer landing runs metric MQE for, per request. The
     *  landing always lists ALL services, but only fetches column metrics
     *  for up to this many — the TRUE top-N by the landing's `orderBy`
     *  column (a cheap single-metric ranking pass picks them when a layer
     *  exceeds the cap). The UI surfaces "top N of M" whenever the cap
     *  bites, so nothing is silently dropped. Raise it if your OAP +
     *  storage backend can take the larger fan-out; lower it to protect a
     *  modest deployment. Default 100. */
    landingServiceCap: z.number().int().positive().default(100),
  })
  .strict()
  .default({ landingServiceCap: 100 });

// JS source maps for de-obfuscating BROWSER-layer error stacks (#6784).
// Maps live in the BFF process heap — there is NO OAP-side storage — so
// the budgets below bound a per-instance, intentionally-ephemeral cache.
// `HORIZON_SOURCEMAPS_DIR` is set by the Docker image to /app/sourcemaps
// so a mounted maps directory is picked up with zero YAML.
const sourceMapsDirDefault = process.env.HORIZON_SOURCEMAPS_DIR ?? '';
const sourceMapsSchema = z
  .object({
    /** Master switch for the upload / static-mount / resolve capability.
     *  When false the Browser Errors tab still lists errors, but the map
     *  controls are hidden and the source-map routes reject. */
    enabled: z.boolean().default(true),
    /** Reject any single `.map` larger than this (upload or mount). Maps
     *  carrying `sourcesContent` are commonly 5–40 MiB; large bundles run
     *  bigger. Default 64 MiB. */
    maxFileBytes: z.number().int().positive().default(64 * 1024 * 1024),
    /** Budget for the resident UPLOADED maps (raw `.map` bytes in the Node
     *  heap). An upload bigger than this is rejected; past it, least-recently-
     *  used uploads are evicted. A small parsed-map cache rides on top
     *  (bounded by count + this budget), so plan ~2x headroom; mounted maps
     *  are disk-backed and don't count. Lowering it trims on the next
     *  upload / resolve / list. Default 512 MiB. */
    maxTotalBytes: z.number().int().positive().default(512 * 1024 * 1024),
    /** Cap on the NUMBER of maps held, independent of bytes — bounds the
     *  in-memory uploaded set (LRU-evicted past it) and the count of
     *  statically-mounted maps indexed at boot (the rest are skipped).
     *  Default 128. */
    maxFileCount: z.number().int().positive().default(128),
    /** Directory scanned at boot for statically-provisioned `.map` files
     *  (Docker/k8s mount). Disk-backed: evictable from memory but reloaded
     *  on demand, so they survive restarts and aren't deletable from the
     *  UI. Empty disables the static mount. */
    bootMountDir: z.string().default(sourceMapsDirDefault),
  })
  .strict()
  .default({});

// AI assistant (chat/LLM). OFF by default. Transport-pluggable + vendor-neutral:
// the DEFAULT is `openai-compatible` (any OpenAI-shaped endpoint — OpenAI,
// DeepSeek-direct, local models, AI gateways, Azure-OpenAI, or Claude behind a
// gateway), configured with just model + baseUrl + apiKey. `provider` is only
// set for a non-OpenAI-shaped SERVICE — today `bedrock` (AWS Converse + bearer).
// The API key is a SECRET: set it via `${HORIZON_AI_API_KEY:}` env interpolation
// only — never inline in the YAML — and it is redacted from logs + excluded from
// the audit trail. Env-overridable defaults let a file-less container enable the
// feature with `HORIZON_AI_*` alone (mirrors sourceMaps / templates.mode).
const aiEnabledDefault = process.env.HORIZON_AI_ENABLED === 'true';
const aiProviderDefault: 'openai-compatible' | 'bedrock' =
  process.env.HORIZON_AI_PROVIDER === 'bedrock' ? 'bedrock' : 'openai-compatible';
const aiModelDefault = process.env.HORIZON_AI_MODEL ?? '';
const aiBaseUrlDefault = process.env.HORIZON_AI_BASE_URL ?? '';
const aiRegionDefault = process.env.HORIZON_AI_REGION ?? '';
const aiApiKeyDefault = process.env.HORIZON_AI_API_KEY ?? '';
const aiSchema = z
  .object({
    /** Master switch. When false, the chat route rejects (503) and the UI
     *  launcher is hidden — no provider is ever constructed. */
    enabled: z.boolean().default(aiEnabledDefault),
    /** Transport. `openai-compatible` (default) = any OpenAI-shaped endpoint via
     *  `baseUrl` (OpenAI, DeepSeek-direct, local models, gateways, Claude behind
     *  a gateway); `bedrock` = Amazon Bedrock Converse (needs a Bedrock model
     *  id + a Bedrock bearer key; region can come from AWS env/config). Set
     *  `provider` only for a non-OpenAI-shaped service. */
    provider: z.enum(['openai-compatible', 'bedrock']).default(aiProviderDefault),
    /** Model id. For `bedrock` this MUST be the Bedrock / inference-profile id
     *  (e.g. `deepseek.v3.2`, `us.anthropic.claude-...`), NOT the bare Anthropic
     *  id — do not auto-prefix, the operator/user supplies the exact id. */
    model: z.string().default(aiModelDefault),
    /** OpenAI-compatible base URL. Used only when `provider: 'openai-compatible'`. */
    baseUrl: z.string().default(aiBaseUrlDefault),
    /** AWS region for `provider: 'bedrock'`. OPTIONAL — leave blank to read it
     *  from AWS_REGION / AWS_DEFAULT_REGION in the environment. Set it only to
     *  pin a region in Horizon config. */
    region: z.string().default(aiRegionDefault),
    /** SECRET — env-only (`${HORIZON_AI_API_KEY:}`). For `bedrock` this is the
     *  Bedrock bearer API key (ABSK…). Redacted from logs, never audited. */
    apiKey: z.string().default(aiApiKeyDefault),
    // Inference params (temperature, output-token caps) are deliberately NOT
    // config knobs — the gateway / provider / model owns them. The agent fixes
    // temperature at 0 internally for tool-calling determinism.
    /** OVERRIDE the bundled system prompt. Empty → use the shipped default.
     *  Best set as a YAML block scalar (multi-line); `${HORIZON_AI_SYSTEM_PROMPT}`
     *  also works for a single-line override. */
    systemPrompt: z.string().default(''),
    /** OVERRIDE the bundled starter prompts (the chat's example chips). Empty →
     *  use the shipped defaults. Each string is one starter shown to the user. */
    starters: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({});

// Layers hidden from the sidebar / menu even when OAP reports them in
// `listLayers`. An operator can clear `excluded` to surface every reported
// layer, or add keys for internal-only layers they don't want on the menu.
// The `reason` is documentation for whoever reads this file — it isn't shown
// in the UI (an excluded layer simply doesn't appear).
const excludedLayerSchema = z
  .object({
    /** OAP layer key (UPPER_SNAKE), matched case-insensitively. */
    key: z.string().min(1),
    /** Why it's hidden — operator-facing note, not surfaced in the UI. */
    reason: z.string().optional(),
  })
  .strict();
const DEFAULT_EXCLUDED_LAYERS = [
  { key: 'FAAS', reason: 'Deprecated.' },
  { key: 'VIRTUAL_GATEWAY', reason: 'Not planned to set up.' },
];
const layersSchema = z
  .object({
    excluded: z.array(excludedLayerSchema).default(DEFAULT_EXCLUDED_LAYERS),
  })
  .strict()
  .default({ excluded: DEFAULT_EXCLUDED_LAYERS });

// ────────────────────────────────────────────────────────────────────
// Performance / behavior tuning — how hard the BFF fans queries out to
// OAP, plus the render / fetch caps that protect storage. OPERATIONAL,
// per-deployment, hot-reloaded — NOT dashboard content (those live in
// templates published to OAP). Defaults equal the built-in values, so
// omitting this block changes nothing. Every value is clamped to a hard
// ceiling (the `.max()` below) — config can lower, never exceed it.
const performanceSchema = z
  .object({
    bulk: z
      .object({
        // Service-map family routes (topology / instance-topology /
        // deployment / endpoint-dependency). `*BulkSize` = aliased MQE
        // fragments per OAP request; `concurrency` = parallel requests.
        topology: z
          .object({
            nodeBulkSize: z.number().int().min(1).max(500).default(150),
            edgeBulkSize: z.number().int().min(1).max(500).default(200),
            concurrency: z.number().int().min(1).max(16).default(4),
          })
          .strict()
          .default({}),
        // 3D infrastructure-map metric fan-out.
        infra3d: z
          .object({
            metricBulkSize: z.number().int().min(1).max(12).default(6),
            metricConcurrency: z.number().int().min(1).max(8).default(4),
            topologyConcurrency: z.number().int().min(1).max(16).default(4),
            templateConcurrency: z.number().int().min(1).max(32).default(8),
          })
          .strict()
          .default({}),
        // Per-layer landing: metric columns fetched in service batches.
        landing: z
          .object({
            bulkSize: z.number().int().min(1).max(12).default(6),
            concurrency: z.number().int().min(1).max(16).default(8),
          })
          .strict()
          .default({}),
        // Dashboard widget metric fan-out.
        dashboard: z
          .object({
            bulkSize: z.number().int().min(1).max(12).default(6),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    limits: z
      .object({
        // Service-map render valve: a graph larger than this is rejected
        // with a "narrow the scope" notice rather than drawn unreadably.
        topologyMaxNodes: z.number().int().positive().default(5000),
        topologyMaxEdges: z.number().int().positive().default(15000),
        // Max RECORDS per request (the OAP storage LIMIT) for each event
        // list — NOT a page count. The UI page-size picker maxes at the
        // same value, so a client can't out-ask the dropdown.
        maxPageSize: z
          .object({
            traces: z.number().int().min(1).max(500).default(100),
            logs: z.number().int().min(1).max(500).default(100),
            browserLogs: z.number().int().min(1).max(500).default(100),
            // Events are grouped client-side (one deploy = many per-instance
            // rows), so we fetch a deeper raw page than the other feeds.
            events: z.number().int().min(1).max(500).default(200),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

// Template source mode. `live` (default) seeds bundled templates into OAP's
// ui_template store at boot and reads/writes them via the ui_template API.
// `readonly` renders templates from the local disk bundle only — the
// ui_template API is never called and the config surface is read-only; OAP's
// query API (metrics/traces/logs) is still used + boot-checked. Env-overridable
// (`HORIZON_TEMPLATES_MODE`) so a file-less container can pick the mode.
const templatesModeDefault: 'live' | 'readonly' =
  process.env.HORIZON_TEMPLATES_MODE === 'readonly' ? 'readonly' : 'live';
const templatesSchema = z
  .object({
    mode: z.enum(['live', 'readonly']).default(templatesModeDefault),
  })
  .strict()
  .default({ mode: templatesModeDefault });

export const configSchema = z
  .object({
    server: serverSchema.default({}),
    layers: layersSchema,
    templates: templatesSchema,
    oap: oapSchema.default({}),
    auth: authSchema,
    rbac: rbacSchema,
    session: sessionSchema,
    audit: auditSchema,
    setup: setupSchema,
    alarms: alarmsSchema,
    debugLog: debugLogSchema,
    query: querySchema,
    sourceMaps: sourceMapsSchema,
    ai: aiSchema,
    performance: performanceSchema,
    // Deprecated + ignored. The 3D-map config moved to OAP (a template kind);
    // the old file-backed `infra3d.file` knob is gone. Accepted here (rather
    // than rejected by `.strict()`) so an existing config carrying the block
    // still boots — the value is unused.
    infra3d: z.unknown().optional(),
  })
  .strict();

export type HorizonConfig = z.infer<typeof configSchema>;
export type AiConfig = z.infer<typeof aiSchema>;
export type TemplatesConfig = z.infer<typeof templatesSchema>;
export type SourceMapsConfig = z.infer<typeof sourceMapsSchema>;
export type LdapConfig = z.infer<typeof ldapSchema>;
export type LocalUser = z.infer<typeof localUserSchema>;
export type BreakGlassConfig = z.infer<typeof breakGlassSchema>;
