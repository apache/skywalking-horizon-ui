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
 * `GET /api/configs/bundle` — preload payload for the SPA. Returns the
 * dashboard widget set for every (layer, scope) pair PLUS the full
 * overview-dashboard list in one round-trip so the SPA can cache the
 * lot in localStorage and serve config lookups synchronously after the
 * first visit.
 *
 * Layer / overview content reflects the merged view from the sync
 * orchestrator: when OAP holds a (non-disabled) remote template under
 * the matching `horizon.*` name, that wins over bundled — operators
 * edit OAP, the BFF reflects what they edited. When OAP admin is
 * unreachable OR the remote is missing, bundled is used. Disabled
 * templates are dropped from the bundle entirely.
 *
 * `syncStatus` carries per-template badges for the admin pages so the
 * SPA can render `synced / diverged / disabled / remote-only /
 * bundled-fallback` chips and the OAP-unreachable read-only banner
 * without a second round-trip.
 *
 * Versioning: `etag` is a stable hash of the payload (md5 of the JSON
 * shape). When the sync status changes (operator edited a template on
 * OAP, cache expired, etc.) the etag changes too — the SPA refetches
 * automatically.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  DashboardWidget,
  OverviewDashboard,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {
  allLayerTemplates,
  widgetsForScope,
  type LayerTemplate,
} from '../../logic/layers/loader.js';
import { loadOverviewDashboards } from '../../logic/overview/loader.js';
import {
  getSyncStatus,
  findOverlayRow,
  type TemplateRow,
} from '../../logic/templates/sync.js';
import type { TemplateKind } from '../../logic/templates/names.js';
import { iterateBundledTemplates } from '../../logic/templates/aggregator.js';
import { formatName, parseEnvelope } from '../../logic/templates/names.js';
import { resync as resyncTemplates } from '../../logic/templates/sync.js';
import { logger } from '../../logger.js';
import type { Locale } from '../../i18n/index.js';
import {
  localizeContent,
  getLayerOverlay,
  getOverviewOverlay,
  localeFromRequest,
} from '../../i18n/index.js';

export interface ConfigBundleDeps {
  config: ConfigSource;
  sessions: SessionStore;
  uiTemplateClient: () => UITemplateClient;
}

type ScopeMap = Partial<Record<'service' | 'instance' | 'endpoint', DashboardWidget[]>>;

/** What the admin pages need to render their banners + per-row badges.
 *  The full bundled / remote configuration strings are intentionally
 *  omitted here (they'd bloat the bundle 5x); the admin pages fetch
 *  them on demand from `/api/admin/templates/sync-status`. */
export interface BundleSyncStatus {
  unreachable: boolean;
  lastSuccessfulSyncAt: number | null;
  generatedAt: number;
  badges: Array<{
    name: string;
    kind: TemplateKind;
    key: string;
    status: TemplateRow['status'];
  }>;
  /** Names where >1 enabled OAP record exists. Empty when clean.
   *  Admin pages render a banner so the operator can disable extras. */
  conflicts: Array<{
    name: string;
    kind: TemplateKind;
    key: string;
    enabledIds: string[];
  }>;
}

export interface ConfigBundle {
  etag: string;
  generatedAt: number;
  layers: Record<string, ScopeMap>;
  overviews: OverviewDashboard[];
  syncStatus: BundleSyncStatus;
}

export function registerConfigBundleRoute(app: FastifyInstance, deps: ConfigBundleDeps): void {
  const auth = requireAuth(deps);
  app.get(
    '/api/configs/bundle',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // `?prefer=local` renders the LOCAL bundled copy for templates that
      // diverge from OAP (so an operator can preview unpublished edits);
      // default `remote` keeps OAP as the runtime source of truth.
      const preferLocal = (req.query as { prefer?: string }).prefer === 'local';
      // `?force=true` bypasses the 30s OAP sync cache — admin pages
      // pass this on mount so their `synced` / `diverged` / `disabled`
      // badges reflect the actual OAP state, not a stale snapshot from
      // the cached bundle the SPA persisted in localStorage.
      const force = (req.query as { force?: string }).force === 'true';
      if (force) resyncTemplates();
      const locale = localeFromRequest(req);
      const body = await buildBundle(deps, preferLocal, locale);
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string' && inm === body.etag) {
        return reply.code(304).send();
      }
      reply.header('ETag', body.etag);
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
      return reply.send(body);
    },
  );
}

async function buildBundle(
  deps: ConfigBundleDeps,
  preferLocal = false,
  locale: Locale = 'en',
): Promise<ConfigBundle> {
  const sync = await getSyncStatus({
    client: deps.uiTemplateClient(),
    bundled: () => iterateBundledTemplates(),
    logger,
  });

  const remoteByName = new Map<string, TemplateRow>();
  for (const row of sync.rows) remoteByName.set(row.name, row);

  // Pull the OAP overlay row content for a (kind, key, locale) tuple.
  // Returns null in English (no overlay) or when no operator has
  // pushed a translation row yet — disk overlay handles the rest.
  const oapOverlayFor = (kind: TemplateKind, key: string): unknown => {
    if (locale === 'en') return null;
    const row = findOverlayRow(sync, kind, key, locale);
    if (!row?.remote) return null;
    const env = parseEnvelope(row.remote.configuration);
    return env?.content ?? null;
  };

  const layers: Record<string, ScopeMap> = {};
  for (const tpl of allLayerTemplates()) {
    const picked = pickLayerContent(tpl, remoteByName, preferLocal);
    if (picked === null) continue; // disabled
    // Localize: OAP overlay wins where present, disk overlay fills the
    // rest, English source falls through for the remainder. Both
    // overlays are keyed by the layer key (the source's `key`,
    // upper-snake to match OAP's enum).
    const effective = localizeContent(
      picked,
      oapOverlayFor('layer', picked.key),
      getLayerOverlay(picked.key, locale),
      locale,
    );
    const scopes: ScopeMap = {};
    for (const scope of ['service', 'instance', 'endpoint'] as const) {
      const ws = widgetsForScope(effective, scope);
      if (ws.length > 0) scopes[scope] = ws;
    }
    layers[effective.key.toLowerCase()] = scopes;
  }

  const overviews: OverviewDashboard[] = [];
  const diskOverviewIds = new Set<string>();
  for (const dash of loadOverviewDashboards()) {
    diskOverviewIds.add(dash.id);
    const picked = pickOverviewContent(dash, remoteByName, preferLocal);
    if (picked === null) continue; // disabled
    overviews.push(
      localizeContent(
        picked,
        oapOverlayFor('overview', picked.id),
        getOverviewOverlay(picked.id, locale),
        locale,
      ),
    );
  }
  // Remote-only overviews: dashboards that live on OAP with no on-disk
  // base — created in the admin UI and pushed. The disk loop can't see
  // them, so surface them straight from the remote envelope. (Layers can't
  // be remote-only: every layer ships a bundled template.)
  for (const row of sync.rows) {
    if (row.kind !== 'overview' || row.status === 'disabled' || !row.remote) continue;
    if (row.locale !== undefined) continue; // skip per-locale overlay rows
    const env = parseEnvelope(row.remote.configuration);
    if (!env || !isOverviewLike(env.content)) continue;
    const dash = env.content as OverviewDashboard;
    if (diskOverviewIds.has(dash.id)) continue; // already handled above
    // Remote-only dashboards: no disk overlay, but a per-locale OAP
    // overlay row may still apply.
    overviews.push(
      localizeContent(dash, oapOverlayFor('overview', dash.id), null, locale),
    );
  }

  const syncStatus: BundleSyncStatus = {
    unreachable: sync.unreachable,
    lastSuccessfulSyncAt: sync.lastSuccessfulSyncAt,
    generatedAt: sync.generatedAt,
    badges: sync.rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      key: r.key,
      status: r.status,
    })),
    conflicts: sync.conflicts ?? [],
  };

  const body = { layers, overviews, syncStatus };
  // Locale folded into the etag so the SPA's per-locale caches don't
  // collide. Without this, switching from `en` to `zh-CN` would 304 off
  // the previous etag and never re-render localized content.
  const etag = createHash('md5')
    .update(locale)
    .update('\0')
    .update(JSON.stringify(body))
    .digest('hex');
  return { etag, generatedAt: Date.now(), ...body };
}

/** Choose remote envelope.content over bundled when the row is synced or
 *  diverged. `disabled` returns null (drop from bundle). `bundled-fallback`,
 *  `unknown`, and `remote-only` fall to bundled (remote-only is impossible
 *  here because the bundled iterator would have included it — but be
 *  defensive). */
function pickLayerContent(
  bundled: LayerTemplate,
  byName: Map<string, TemplateRow>,
  preferLocal = false,
): LayerTemplate | null {
  const row = byName.get(formatName('layer', bundled.key));
  if (!row) return bundled;
  if (row.status === 'disabled') return null;
  // Operator opted to preview unpublished local edits: bundled wins for
  // diverged templates (synced rows are byte-equal, so it's a no-op there).
  if (preferLocal && row.status === 'diverged') return bundled;
  if (row.effective === 'remote' && row.remote) {
    const env = parseEnvelope(row.remote.configuration);
    if (env && isLayerLike(env.content)) {
      return env.content as LayerTemplate;
    }
  }
  return bundled;
}

function pickOverviewContent(
  bundled: OverviewDashboard,
  byName: Map<string, TemplateRow>,
  preferLocal = false,
): OverviewDashboard | null {
  const row = byName.get(formatName('overview', bundled.id));
  if (!row) return bundled;
  if (row.status === 'disabled') return null;
  if (preferLocal && row.status === 'diverged') return bundled;
  if (row.effective === 'remote' && row.remote) {
    const env = parseEnvelope(row.remote.configuration);
    if (env && isOverviewLike(env.content)) {
      return env.content as OverviewDashboard;
    }
  }
  return bundled;
}

function isLayerLike(v: unknown): boolean {
  return !!v && typeof v === 'object' && 'key' in (v as Record<string, unknown>);
}

function isOverviewLike(v: unknown): boolean {
  return !!v && typeof v === 'object' && 'id' in (v as Record<string, unknown>);
}
