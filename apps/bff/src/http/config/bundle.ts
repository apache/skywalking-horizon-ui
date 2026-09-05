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
 * Layer / overview content is strictly REMOTE at runtime: a (non-
 * disabled) remote OAP template stored under the matching `horizon.*`
 * name AND declaring that same identity is rendered; anything else —
 * including a row whose content names another template — is dropped
 * from the bundle. Bundled disk content is NEVER served here at
 * runtime: it reaches the UI only by being synced INTO OAP (boot seed
 * / admin reset) or via the explicit `?prefer=local` preview. So when
 * OAP admin is unreachable, or a template is disabled / missing its
 * remote row, that entry is simply absent from the bundle (the SPA
 * blocks via the connectivity banner / falls to per-page in-code
 * defaults), rather than masked by stale bundled config. An overview
 * whose name sits on several enabled OAP records with differing
 * content is dropped for the same reason the sidebar drops a
 * duplicated layer: there is no single definition to serve, and
 * picking one for the operator is not the renderer's call.
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
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import {
  allLayerTemplates,
  extPagesForScope,
  widgetsForScope,
  withTopNOrder,
  type LayerTemplate,
} from '../../logic/layers/loader.js';
import { loadOverviewDashboards } from '../../logic/overview/loader.js';
import {
  ambiguousConflicts,
  getSyncStatus,
  findOverlayRow,
  type TemplateRow,
} from '../../logic/templates/sync.js';
import { iterateBundledTemplates } from '../../logic/templates/aggregator.js';
import { formatName, parseEnvelope } from '../../logic/templates/names.js';
import { resync as resyncTemplates } from '../../logic/templates/sync.js';
import { logger } from '../../logger.js';
import type { Locale } from '../../i18n/index.js';
import { localizeContent, localeFromRequest } from '../../i18n/index.js';
import type { VerbSubject } from '../../rbac/policy.js';
import { canReadTemplateRow } from '../../rbac/template-verbs.js';
import type { TemplateKind } from '../../logic/templates/names.js';

export interface ConfigBundleDeps extends AuthDeps {
  uiTemplateClient: () => UITemplateClient;
}

type ScopeMap = Partial<Record<'service' | 'instance' | 'endpoint', DashboardWidget[]>>;

/** Extension-page widget sets, keyed `<component>/<pageId>`. A sibling of
 *  `ScopeMap` rather than an entry inside it, so the default grids stay
 *  exactly the shape every existing reader expects. */
type ExtPageMap = Record<string, DashboardWidget[]>;

/** What the admin pages need to render their banners + per-row badges.
 *  The full bundled / remote configuration strings are intentionally
 *  omitted here (they'd bloat the bundle 5x); the admin pages fetch
 *  them on demand from `/api/admin/templates/sync-status`. */
export interface BundleSyncStatus {
  /** `live` = templates read/written via OAP's ui_template store. `readonly` =
   *  rendered from the local disk bundle; the store is not used and the config
   *  surface is read-only. Drives the SPA's read-only chrome + banner. */
  mode: 'live' | 'readonly';
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
   *  Admin pages render a banner so the operator can disable extras
   *  (the lowest id is the one Horizon renders — see `ConflictRow`).
   *  Every duplicate is reported here, including the `identical` ones
   *  `overviews` keeps serving. */
  conflicts: Array<{
    name: string;
    kind: TemplateKind;
    key: string;
    enabledIds: string[];
    identical: boolean;
  }>;
  /** Enabled OAP records that are not readable as the template they are stored
   *  as (see `UnreadableRow`). No read path serves them; the banner names them
   *  with their OAP record ids, which is what an operator needs to repair or
   *  retire one. */
  unreadable: Array<{
    id: string;
    name: string;
    kind: TemplateKind;
    reason: string;
  }>;
}

export interface ConfigBundle {
  etag: string;
  generatedAt: number;
  layers: Record<string, ScopeMap>;
  /** Per-layer extension-page widgets. Absent for a layer with none, so a
   *  bundle from a deployment that declares no pages is byte-identical to
   *  one built before the feature existed. */
  layerExtPages?: Record<string, ExtPageMap>;
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
      const body = await buildBundle(deps, preferLocal, locale, req.session);
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string' && inm === body.etag) {
        return reply.code(304).send();
      }
      // The 304 above still fires under the central `no-store` rule: the SPA
      // keeps this payload in localStorage and sets `If-None-Match` itself,
      // so revalidation never depended on the browser's HTTP cache. Nothing
      // to trade off here — `no-store` only stops the browser writing its own
      // copy to disk.
      reply.header('ETag', body.etag);
      return reply.send(body);
    },
  );
}

async function buildBundle(
  deps: ConfigBundleDeps,
  preferLocal = false,
  locale: Locale = 'en',
  session?: VerbSubject,
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
  const layerExtPages: Record<string, ExtPageMap> = {};
  // Localize + slice a resolved layer template into per-scope widget sets.
  const addLayer = (picked: LayerTemplate): void => {
    // Localize against the OAP overlay row (keyed on the layer's
    // upper-snake `key`); English fills the rest. Disk i18n is seed/reset
    // only, never a runtime fill — same remote-first rule as the template.
    const effective = localizeContent(picked, oapOverlayFor('layer', picked.key), locale);
    const scopes: ScopeMap = {};
    const pages: ExtPageMap = {};
    for (const scope of ['service', 'instance', 'endpoint'] as const) {
      const ws = widgetsForScope(effective, scope);
      if (ws.length > 0) scopes[scope] = ws;
      for (const page of extPagesForScope(effective, scope)) {
        // Same enrichment the default grid gets: the bundle is what the
        // UI renders a page from, so a raw list ranks `asc` backwards.
        pages[`${scope}/${page.id}`] = withTopNOrder(page.widgets);
      }
    }
    const key = effective.key.toLowerCase();
    layers[key] = scopes;
    if (Object.keys(pages).length > 0) layerExtPages[key] = pages;
  };
  if (preferLocal) {
    // Preview (`?prefer=local`): the disk-bundled copy is the thing being
    // previewed for diverged rows, so reading disk here is the allowed
    // preview path.
    for (const tpl of allLayerTemplates()) {
      const picked = pickLayerContent(tpl, remoteByName, true);
      if (picked) addLayer(picked);
    }
  } else {
    // Normal runtime: enumerate the REMOTE layer rows only — never the disk
    // bundle. A bundled-but-unsynced (or disabled / unreachable) layer is
    // simply absent, exactly like the per-page routes' remote-or-default.
    // `effective === 'remote'` is the whole gate: it excludes the disabled and
    // the identity-invalid rows, which matters most HERE, because this loop
    // files each layer under the key its CONTENT declares — a row whose content
    // names another layer would otherwise land on, and overwrite, that layer.
    for (const row of sync.rows) {
      if (row.kind !== 'layer' || row.effective !== 'remote' || !row.remote || row.locale !== undefined) continue;
      const env = parseEnvelope(row.remote.configuration);
      if (env && isLayerLike(env.content)) addLayer(env.content as LayerTemplate);
    }
  }

  const ambiguousOverviews = new Set(ambiguousConflicts(sync, 'overview').map((c) => c.name));

  const overviews: OverviewDashboard[] = [];
  const diskOverviewIds = new Set<string>();
  for (const dash of loadOverviewDashboards()) {
    diskOverviewIds.add(dash.id);
    if (ambiguousOverviews.has(formatName('overview', dash.id))) continue;
    const picked = pickOverviewContent(dash, remoteByName, preferLocal);
    if (picked === null) continue; // disabled
    overviews.push(localizeContent(picked, oapOverlayFor('overview', picked.id), locale));
  }
  // Remote-only overviews: dashboards that live on OAP with no on-disk
  // base — created in the admin UI and pushed. The disk loop can't see
  // them, so surface them straight from the remote envelope. (Layers can't
  // be remote-only: every layer ships a bundled template.)
  for (const row of sync.rows) {
    if (row.kind !== 'overview' || row.effective !== 'remote' || !row.remote) continue;
    if (row.locale !== undefined) continue; // skip per-locale overlay rows
    if (ambiguousOverviews.has(row.name)) continue;
    const env = parseEnvelope(row.remote.configuration);
    if (!env || !isOverviewLike(env.content)) continue;
    const dash = env.content as OverviewDashboard;
    if (diskOverviewIds.has(dash.id)) continue; // already handled above
    // Remote-only dashboards: localize against the per-locale OAP overlay
    // row when one exists, else English.
    overviews.push(localizeContent(dash, oapOverlayFor('overview', dash.id), locale));
  }

  // The same question the admin surface asks — see `canReadTemplateRow`.
  const readable = (r: { kind: TemplateKind; locale?: string }): boolean =>
    canReadTemplateRow(deps.config.current, session, r);
  const syncStatus: BundleSyncStatus = {
    mode: sync.mode,
    unreachable: sync.unreachable,
    lastSuccessfulSyncAt: sync.lastSuccessfulSyncAt,
    generatedAt: sync.generatedAt,
    // Source rows only. Per-locale overlay rows (`…i18n.<locale>`) share
    // their parent's kind, so without this filter they inflate the
    // overview/layer remote-only/diverged counts that drive the admin
    // sync banners. Translations have their own admin page; they must
    // not count toward overview or layer dashboard status.
    badges: sync.rows
      .filter((r) => r.locale === undefined && readable(r))
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        key: r.key,
        status: r.status,
      })),
    conflicts: (sync.conflicts ?? []).filter(readable),
    unreadable: (sync.unreadable ?? []).filter(readable),
  };

  const body = {
    layers,
    ...(Object.keys(layerExtPages).length > 0 ? { layerExtPages } : {}),
    overviews,
    syncStatus,
  };
  // Locale folded into the etag so the SPA's per-locale caches don't
  // collide. Without this, switching from `en` to `zh-CN` would 304 off
  // the previous etag and never re-render localized content.
  const etag = createHash('md5')
    .update(locale)
    .update('\0')
    // The admin metadata above is filtered per session, so two roles must not
    // share an etag — one would 304 onto the other's view.
    .update((session?.roles ?? []).join(','))
    .update('\0')
    .update(JSON.stringify(body))
    .digest('hex');
  return { etag, generatedAt: Date.now(), ...body };
}

/** Choose the remote envelope content when the row is synced or diverged.
 *  Runtime is REMOTE-ONLY: a missing row / `disabled` / `bundled-fallback`
 *  (remote absent) all return `null` so the entry is dropped from the
 *  bundle — bundled disk content is never served at runtime. The ONE
 *  exception is `preferLocal` (the `?prefer=local` preview), where bundled
 *  IS the thing being previewed. */
function pickLayerContent(
  bundled: LayerTemplate,
  byName: Map<string, TemplateRow>,
  preferLocal = false,
): LayerTemplate | null {
  const row = byName.get(formatName('layer', bundled.key));
  if (!row) return preferLocal ? bundled : null;
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
  return preferLocal ? bundled : null;
}

function pickOverviewContent(
  bundled: OverviewDashboard,
  byName: Map<string, TemplateRow>,
  preferLocal = false,
): OverviewDashboard | null {
  const row = byName.get(formatName('overview', bundled.id));
  if (!row) return preferLocal ? bundled : null;
  if (row.status === 'disabled') return null;
  if (preferLocal && row.status === 'diverged') return bundled;
  if (row.effective === 'remote' && row.remote) {
    const env = parseEnvelope(row.remote.configuration);
    if (env && isOverviewLike(env.content)) {
      return env.content as OverviewDashboard;
    }
  }
  return preferLocal ? bundled : null;
}

function isLayerLike(v: unknown): boolean {
  return !!v && typeof v === 'object' && 'key' in (v as Record<string, unknown>);
}

function isOverviewLike(v: unknown): boolean {
  return !!v && typeof v === 'object' && 'id' in (v as Record<string, unknown>);
}
