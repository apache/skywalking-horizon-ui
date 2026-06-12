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

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  FetchLike,
  LayerCaps,
  LayerDef,
  LayerSlots,
  MenuResponse,
  UITemplateClient,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import { buildOapOpts, graphqlPost } from '../../client/graphql.js';
import type { LayerComponentFlags, LayerTemplate } from '../../logic/layers/loader.js';
import { getSyncStatus } from '../../logic/templates/sync.js';
import { iterateBundledTemplates } from '../../logic/templates/aggregator.js';
import { formatName, parseEnvelope } from '../../logic/templates/names.js';
import type { TemplateRow } from '../../logic/templates/sync.js';
import type { ServiceLayerCatalog } from '../../logic/services/service-layer-catalog.js';
import { logger } from '../../logger.js';
import type { Locale } from '../../i18n/index.js';
import { localizeContent, localeFromRequest } from '../../i18n/index.js';
import { oapOverlayContentFromRows } from '../../logic/templates/overlay.js';

/**
 * Map the JSON config's `components.*` flags onto the wire `caps`
 * shape — caps are the cap-driven feature toggles each per-layer page
 * consults. We expand a few aliases (service ⇒ no separate cap; the
 * components flag is the source of truth for whether the page exists).
 */
function componentsToCaps(components: LayerComponentFlags): LayerCaps {
  return {
    dashboards: components.service !== false,
    instances: !!components.instances,
    endpoints: !!components.endpoints,
    endpointDependency: !!components.endpointDependency,
    serviceMap: !!components.topology,
    // instanceTopology is gated by the presence of the
    // topology.instanceTopology config block, not the component flag —
    // overridden per-layer at the call site (see resolveLayerDef).
    instanceTopology: false,
    // deployment rides the component flag here; the call site
    // ANDs it with the presence of the top-level config block.
    deployment: !!components.deployment,
    processTopology: !!components.topology,
    traces: !!components.traces,
    logs: !!components.logs,
    browserErrors: !!components.browserErrors,
    traceProfiling: !!components.traceProfiling,
    ebpfProfiling: !!components.ebpfProfiling,
    asyncProfiling: !!components.asyncProfiling,
    networkProfiling: !!components.networkProfiling,
    pprofProfiling: !!components.pprofProfiling,
    podLogs: !!components.podLogs,
    events: false,
    // Bundled service-count tile defaults on — every layer benefits
    // from the headline count, and operators can opt out per-layer
    // from the setup card's Features section.
    serviceCountTile: true,
  };
}

export interface MenuRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  fetch?: FetchLike;
  /** OAP UI-template client — lets the menu honor disabled layer templates
   *  (a layer disabled in the admin disappears from the sidebar). Optional
   *  so tests can omit it; without it no layer is filtered as disabled. */
  uiTemplateClient?: () => UITemplateClient;
  /** Server-global service-by-layer index. Single source of truth for
   *  per-layer counts + `normal` flags (shared with the alarms tagger
   *  and any future surface that needs the service ↔ layer mapping). */
  serviceCatalog: ServiceLayerCatalog;
}

interface LayerSyncSnapshot {
  /** Canonical layer keys disabled on OAP (sidebar hides them). */
  disabled: Set<string>;
  /** Per-name layer rows for the live OAP UI-template state. Lets the
   *  menu prefer the operator's published edits (alias / components /
   *  slots / caps / colour / metrics / overview / log / traces /
   *  naming) over the disk-bundled defaults — same precedence rule
   *  the config-bundle endpoint already applies via
   *  `pickLayerContent`. Empty when OAP is unreachable; the menu
   *  then falls back to bundled cleanly. */
  layerRowsByName: Map<string, TemplateRow>;
  /** All sync rows (incl. per-locale overlay rows) so the menu can apply
   *  the live OAP translation overlay on top of the disk overlay — same
   *  remote-first localization the config-bundle endpoint does. */
  rows: TemplateRow[];
}

/** Read the shared 30s sync cache once and project the things the menu
 *  needs out of it: which layer rows are admin-disabled, the full
 *  per-name remote envelope content so the menu can prefer operator edits
 *  over disk-bundled defaults, and all rows for OAP translation overlays.
 *  Soft-fails to an empty snapshot so the sidebar never breaks because the
 *  template status couldn't be read. */
async function layerSyncSnapshot(deps: MenuRouteDeps): Promise<LayerSyncSnapshot> {
  const empty: LayerSyncSnapshot = { disabled: new Set(), layerRowsByName: new Map(), rows: [] };
  if (!deps.uiTemplateClient) return empty;
  try {
    const sync = await getSyncStatus({
      client: deps.uiTemplateClient(),
      bundled: () => iterateBundledTemplates(),
      logger,
    });
    if (sync.unreachable) return empty;
    const disabled = new Set<string>();
    const layerRowsByName = new Map<string, TemplateRow>();
    for (const row of sync.rows) {
      if (row.kind !== 'layer') continue;
      if (row.locale !== undefined) continue; // skip i18n overlay rows
      layerRowsByName.set(row.name, row);
      if (row.status === 'disabled') {
        disabled.add(canonical(row.key.toUpperCase()));
      }
    }
    return { disabled, layerRowsByName, rows: sync.rows };
  } catch {
    // Status unavailable — show every layer rather than hide wrongly.
  }
  return empty;
}

// `listLayers` — active layers in this deployment.
// `listLayerLevels` — catalog level per layer (sidebar hierarchy).
const MENU_QUERY = /* GraphQL */ `
  query HorizonMenu {
    layers: listLayers
    levels: listLayerLevels {
      layer
      level
    }
  }
`;

/**
 * Legacy enum values OAP keeps for backward compatibility — collapse to the
 * modern equivalent so the sidebar shows one row per logical layer.
 */
const LAYER_ALIAS: Record<string, string> = {
  CACHE: 'VIRTUAL_CACHE',
  DATABASE: 'VIRTUAL_DATABASE',
  MQ: 'VIRTUAL_MQ',
  GENAI: 'VIRTUAL_GENAI',
};

function canonical(layer: string): string {
  return LAYER_ALIAS[layer] ?? layer;
}

interface MenuRaw {
  layers: string[];
  levels: Array<{ layer: string; level: number }>;
}

/**
 * Horizon-side defaults for per-layer term aliases and color. OAP doesn't
 * expose these — they live alongside the UI's sidebar config. Operators can
 * override via the Dashboard setup → Layer dashboards admin page,
 * which writes to OAP via the UI-template sync surface.
 *
 * Keys match `Layer.name` in OAP's enum (UPPER_SNAKE_CASE).
 */
const LAYER_DEFAULTS: Record<string, { color: string; slots: LayerSlots; caps: LayerCaps }> = {
  GENERAL: {
    color: 'var(--sw-accent)',
    slots: { services: 'Services', instances: 'Instances', endpoints: 'API', endpointDependency: 'API dependency' },
    caps: {
      serviceMap: true, endpointDependency: true, processTopology: true,
      dashboards: true, traces: true, logs: true,
      traceProfiling: true, ebpfProfiling: true, asyncProfiling: true, events: true,
    },
  },
  MESH: {
    color: 'var(--sw-info)',
    slots: { services: 'Services', instances: 'Sidecars', endpoints: 'Endpoints' },
    caps: {
      serviceMap: true, endpointDependency: true,
      dashboards: true, traces: true, logs: true, events: true,
    },
  },
  MESH_CP: { color: 'var(--sw-info)', slots: { services: 'Control-plane services' }, caps: { dashboards: true } },
  MESH_DP: { color: 'var(--sw-info)', slots: { services: 'Data-plane services', instances: 'Sidecars' }, caps: { dashboards: true } },
  K8S: { color: 'var(--sw-purple)', slots: { services: 'Workloads', instances: 'Pods' }, caps: { serviceMap: true, dashboards: true, events: true } },
  K8S_SERVICE: { color: 'var(--sw-purple)', slots: { services: 'K8s services', instances: 'Pods' }, caps: { serviceMap: true, dashboards: true } },
  BROWSER: { color: 'var(--sw-cyan)', slots: { services: 'Applications', instances: 'Versions', endpoints: 'Pages' }, caps: { dashboards: true, traces: true, browserErrors: true } },
  MYSQL: { color: 'var(--sw-warn)', slots: { services: 'Instances' }, caps: { dashboards: true } },
  POSTGRESQL: { color: 'var(--sw-warn)', slots: { services: 'Instances' }, caps: { dashboards: true } },
  ELASTICSEARCH: { color: 'var(--sw-warn)', slots: { services: 'Clusters', instances: 'Nodes' }, caps: { dashboards: true } },
  REDIS: { color: 'var(--sw-warn)', slots: { services: 'Instances' }, caps: { dashboards: true } },
  MONGODB: { color: 'var(--sw-warn)', slots: { services: 'Clusters', instances: 'Nodes' }, caps: { dashboards: true } },
  CLICKHOUSE: { color: 'var(--sw-warn)', slots: { services: 'Services', instances: 'Instances' }, caps: { dashboards: true } },
  KAFKA: { color: 'var(--sw-ok)', slots: { services: 'Clusters', instances: 'Brokers' }, caps: { dashboards: true } },
  PULSAR: { color: 'var(--sw-ok)', slots: { services: 'Clusters', instances: 'Brokers' }, caps: { dashboards: true } },
  ROCKETMQ: { color: 'var(--sw-ok)', slots: { services: 'Clusters', instances: 'Brokers', endpoints: 'Topics' }, caps: { dashboards: true } },
  RABBITMQ: { color: 'var(--sw-ok)', slots: { services: 'Clusters', instances: 'Nodes' }, caps: { dashboards: true } },
  ACTIVEMQ: { color: 'var(--sw-ok)', slots: { services: 'Clusters', instances: 'Brokers', endpoints: 'Destinations' }, caps: { dashboards: true } },
  VIRTUAL_DATABASE: { color: 'var(--sw-warn)', slots: { services: 'Databases' }, caps: { dashboards: true } },
  VIRTUAL_CACHE: { color: 'var(--sw-warn)', slots: { services: 'Caches' }, caps: { dashboards: true } },
  VIRTUAL_MQ: { color: 'var(--sw-ok)', slots: { services: 'Queues' }, caps: { dashboards: true } },
  VIRTUAL_GENAI: { color: 'var(--sw-purple)', slots: { services: 'Providers', instances: 'Models' }, caps: { dashboards: true } },
};

const DEFAULT_FOR_UNKNOWN_LAYER = {
  color: 'var(--sw-fg-2)',
  slots: { services: 'Services' } as LayerSlots,
  caps: {dashboards: true } as LayerCaps,
};

/** Resolve the layer template the menu should serve for `rawKey`,
 *  matching the bundle endpoint + the per-page routes: REMOTE-only.
 *    1. remote OAP UI-template row, when present + not disabled
 *       (operator edits go live the moment they push) ;
 *    2. null otherwise — the caller (`deriveLayer`) then renders the
 *       in-code `LAYER_DEFAULTS`, NOT the disk-bundled template.
 *  Bundled disk content is the seed/reset source (it syncs INTO remote
 *  on boot), never a render-time fallback: when the template store is
 *  unreachable, the snapshot is empty → every layer resolves to its
 *  hard-coded default here, and the per-page features block. */
function resolveLayerTemplate(
  rawKey: string,
  layerRowsByName: Map<string, TemplateRow>,
): LayerTemplate | null {
  const row = layerRowsByName.get(formatName('layer', rawKey.toUpperCase()));
  if (row && row.status !== 'disabled' && row.effective === 'remote' && row.remote) {
    const env = parseEnvelope(row.remote.configuration);
    if (env && env.content && typeof env.content === 'object' && 'key' in env.content) {
      return env.content as LayerTemplate;
    }
  }
  return null;
}

function deriveLayer(
  rawKey: string,
  active: boolean,
  level: number | null,
  serviceCount: number,
  normal: boolean | null,
  locale: Locale,
  layerRowsByName: Map<string, TemplateRow>,
  /** Live OAP translation overlay content for this (layer, locale), or
   *  null — applied on top of the disk overlay (remote wins per leaf). */
  oapOverlay: unknown,
): LayerDef {
  // Remote (OAP) wins when present — alias / color / slots / caps /
  // components / documentLink follow the operator's published edits.
  // When no remote row is live (not yet synced, OR the template store is
  // unreachable so the snapshot is empty), we fall to the hard-coded
  // LAYER_DEFAULTS — NOT the disk-bundled template. Bundled is the
  // seed/reset source, never a render-time fallback; the per-page
  // features block in that state while the sidebar still navigates.
  const rawTpl = resolveLayerTemplate(rawKey, layerRowsByName);
  const tpl = rawTpl ? localizeContent<LayerTemplate>(rawTpl, oapOverlay, locale) : null;
  if (tpl) {
    return {
      key: rawKey.toLowerCase(),
      name: tpl.alias || rawKey,
      color: tpl.color || 'var(--sw-fg-2)',
      serviceCount,
      active,
      level,
      normal,
      group: tpl.group,
      visibility: tpl.visibility,
      documentLink: tpl.documentLink ?? undefined,
      slots: tpl.slots,
      // Caps come straight from the in-use (remote-or-bundled) template's
      // component flags — remote-first. Missing flags fall to the
      // componentsToCaps defaults, never to the bundled copy of an
      // already-published layer: bundled is the seed/reset source (it
      // syncs INTO remote on boot), not a render-time merge partner.
      // instanceTopology cap follows the served topology config's
      // `instanceTopology` block (same source the topology routes read),
      // so the Instance-map drill-down only appears where it's configured.
      caps: ((): LayerCaps => {
        const c = componentsToCaps(tpl.components);
        // Read the EFFECTIVE (remote-or-bundled) template — the same one
        // the topology routes serve — so the Instance-map drill-down is
        // available iff it's enabled on the in-use template, matching the
        // admin. Gate on the parent Topology component (`serviceMap` =
        // `components.topology`): instance topology is a drill-down OF the
        // topology map, so disabling the Topology component must hide it
        // too — even if a stale `topology.instanceTopology` block lingers.
        c.instanceTopology = c.serviceMap && !!rawTpl?.topology?.instanceTopology;
        // Deployment is its own tab (not a drill-down of the
        // service map), so it's gated only on its own config block presence
        // AND its component flag — independent of `serviceMap`.
        c.deployment =
          c.deployment && !!rawTpl?.deployment;
        return c;
      })(),
      header: tpl.header,
      metrics: tpl.metrics,
      overview: tpl.overview,
      log: tpl.log,
      traces: tpl.traces,
      naming: tpl.naming,
      instances: tpl.instances,
    };
  }
  const def = LAYER_DEFAULTS[rawKey] ?? DEFAULT_FOR_UNKNOWN_LAYER;
  return {
    key: rawKey.toLowerCase(),
    name: rawKey.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
    color: def.color,
    serviceCount,
    active,
    level,
    normal,
    slots: def.slots,
    caps: def.caps,
  };
}

export function registerMenuRoute(app: FastifyInstance, deps: MenuRouteDeps): void {
  const auth = requireAuth(deps);
  app.get('/api/menu', { preHandler: auth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const cfg = deps.config.current;
    const queryUrl = cfg.oap.queryUrl;
    const opts = buildOapOpts(cfg, deps.fetch);
    const locale = localeFromRequest(req);
    // Operator-configured hidden layers (horizon.yaml `layers.excluded`).
    // Defaults to FaaS (deprecated) + Virtual Gateway (not planned). Matched
    // case-insensitively against the canonical layer key.
    const excludedLayers = new Set(
      (cfg.layers?.excluded ?? []).map((e) => e.key.toUpperCase()),
    );
    try {
      const raw = await graphqlPost<MenuRaw>(opts, MENU_QUERY);

      // Active list collapsed by alias (CACHE → VIRTUAL_CACHE, etc.).
      const activeCanonical = new Set(raw.layers.map(canonical));
      const levelByCanonical = new Map(raw.levels.map((l) => [canonical(l.layer), l.level]));

      // Service counts + first-row `normal` flag come from the
      // server-global catalog (60s TTL, shared with alarms + any other
      // surface needing the service ↔ layer map). RAW layer names since
      // the canonical alias collapse is presentation-only.
      const catalog = await deps.serviceCatalog.get();
      const countByCanonical = new Map<string, number>();
      const normalByCanonical = new Map<string, boolean | null>();
      for (const rawLayer of raw.layers) {
        const key = canonical(rawLayer);
        const rows = catalog.byLayer.get(rawLayer) ?? [];
        countByCanonical.set(key, (countByCanonical.get(key) ?? 0) + rows.length);
        // First non-null `normal` value wins for the canonical key —
        // raw layers that fold into one canonical (e.g. mesh / mesh_cp)
        // share the same `normal` in practice, so collisions are safe.
        const first = rows[0];
        const normal = first ? (first.normal === true ? true : first.normal === false ? false : null) : null;
        if (normal !== null && !normalByCanonical.has(key)) {
          normalByCanonical.set(key, normal);
        }
      }

      // Runtime registry = the layer templates synced to OAP, NOT the disk
      // bundle. The same snapshot also gives the disabled set + per-layer
      // remote content for deriveLayer. (Disk files reach OAP only via
      // boot-seed / admin reset; they're never read at render time.)
      const { disabled, layerRowsByName, rows } = await layerSyncSnapshot(deps);

      // Order = the synced layer rows (sorted by key), then any OAP-active
      // layer with no synced template, appended so nothing disappears.
      const ordered: string[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (row.kind !== 'layer' || row.locale !== undefined) continue;
        const k = canonical(row.key.toUpperCase());
        if (seen.has(k)) continue;
        seen.add(k);
        ordered.push(k);
      }
      for (const rawLayer of raw.layers) {
        const k = canonical(rawLayer);
        if (seen.has(k)) continue;
        seen.add(k);
        ordered.push(k);
      }

      // Every layer OAP surfaces in `listLayers` is shown — including
      // ones with no Horizon template (they render with default caps, a
      // bare Service page). Dropped only when admin-disabled (soft-deleted,
      // like disabled overviews) or config-excluded (`layers.excluded`).
      const layers = ordered
        .filter((key) => !disabled.has(key) && !excludedLayers.has(key.toUpperCase()))
        .map((key) =>
          deriveLayer(
            key,
            activeCanonical.has(key),
            levelByCanonical.has(key) ? (levelByCanonical.get(key) ?? null) : null,
            countByCanonical.get(key) ?? (activeCanonical.has(key) ? 0 : -1),
            normalByCanonical.get(key) ?? null,
            locale,
            layerRowsByName,
            oapOverlayContentFromRows(rows, 'layer', key, locale),
          ),
        );

      const body: MenuResponse = {
        layers,
        generatedAt: Date.now(),
        oap: { reachable: true, queryUrl },
      };
      return reply.send(body);
    } catch (err) {
      // OAP query unreachable — no layer list from OAP. Render a hard-coded
      // skeleton from the well-known LAYER_DEFAULTS keys so the shell still
      // navigates (each page surfaces its own OAP-down state, and the
      // banner explains). NOT the disk bundle: the runtime never reads
      // bundled files; defaults here are the in-code LAYER_DEFAULTS that
      // deriveLayer falls to on an empty row map. Counts unknown (-1),
      // layers inactive.
      const seen = new Set<string>();
      const layers: LayerDef[] = [];
      const emptyRows = new Map<string, TemplateRow>();
      for (const rawKey of Object.keys(LAYER_DEFAULTS)) {
        const key = canonical(rawKey);
        if (seen.has(key) || excludedLayers.has(key.toUpperCase())) continue;
        seen.add(key);
        layers.push(deriveLayer(key, false, null, -1, null, locale, emptyRows, null));
      }
      const body: MenuResponse = {
        layers,
        generatedAt: Date.now(),
        oap: {
          reachable: false,
          queryUrl,
          error: err instanceof Error ? err.message : String(err),
        },
      };
      return reply.status(200).send(body); // soft-fail so the UI shows a banner, not a 5xx
    }
  });
}
