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

import type {
  DashboardWidget,
  OverviewDashboard,
} from '@skywalking-horizon-ui/api-client';
import { pushEvent } from '@/controls/eventLog';
import { currentLocale } from '@/i18n';
import { withBase, type BffClient } from '../client';

export type BundleScopeMap = Partial<
  Record<'service' | 'instance' | 'endpoint', DashboardWidget[]>
>;

/** What kind of template a sync-status row describes. Reserved kinds —
 *  see the BFF's `apps/bff/src/logic/templates/names.ts`. */
export type TemplateKind =
  | 'overview'
  | 'layer'
  | 'alert'
  | 'theme'
  | 'time-defaults'
  | 'infra-3d';

/** Status of a single template, mirrored from the BFF sync orchestrator.
 *  - `synced`           — bundled == remote, byte-equal
 *  - `diverged`         — both present, NOT byte-equal (operator edited
 *                          remote; show inline diff)
 *  - `disabled`         — remote present but disabled on OAP; hidden
 *  - `remote-only`      — remote present, no matching bundled (operator
 *                          added a template the BFF doesn't ship)
 *  - `bundled-fallback` — bundled present, remote absent. NOT a render
 *                          source: the entry is dropped from the bundle and
 *                          the page falls to its in-code default
 *  - `unknown`          — defensive; shouldn't appear */
export type TemplateStatus =
  | 'synced'
  | 'diverged'
  | 'disabled'
  | 'remote-only'
  | 'bundled-fallback'
  | 'unknown';

export interface TemplateBadge {
  name: string;
  kind: TemplateKind;
  key: string;
  status: TemplateStatus;
}

/** A template name where OAP has >1 enabled row. The BFF renders the
 *  LOWEST id — content-blind, so Horizon never ranks one operator's
 *  dashboard above another's — and reports the rest. Nothing here resolves
 *  the duplicate: retiring a row is an OAP-side decision for a human. */
export interface TemplateConflict {
  name: string;
  kind: TemplateKind;
  key: string;
  /** UUIDs of every enabled OAP row for this name, sorted ASC. The first
   *  element is the one Horizon renders (lowest id). */
  enabledIds: string[];
  /** Duplicated name, unambiguous definition — the layer / overview still
   *  renders. Absent on a bundle cached by an older Horizon, where reading it
   *  as "not identical" reproduces that version's hide-on-any-duplicate. */
  identical?: boolean;
}

/** An enabled OAP record that is not readable as the template it is stored as
 *  — a layer key that isn't the canonical one, or content whose own `key` /
 *  `id` names a different template than the record it sits in. Neither shape
 *  renders: no layer dashboard, overview or sidebar entry is served from one.
 *  Both still appear in the admin listings that build from stored names, as
 *  ordinary rows. What differs is the REPAIR. A record under a name no page
 *  computes has to be republished under the canonical name and this one retired
 *  by id — the publish boundary refuses to write the non-canonical name at all.
 *  A record under a name a page DOES compute also fills that name's Remote pane
 *  in the editor (a `horizon.layer.GENERAL` row holding a K8S template opens as
 *  GENERAL's remote copy), which is deliberate: its repair IS a push over that
 *  same record. Neither surface says why, and that is what this row carries —
 *  the record id and the reason, for the page banner. */
export interface UnreadableTemplateRow {
  /** OAP record id — what the operator needs to retire it on OAP. */
  id: string;
  name: string;
  kind: TemplateKind;
  /** Which of the two is wrong, and the readable form. Not translated: it
   *  names template names and JSON fields. */
  reason: string;
}

/** Bundle-level sync envelope. When `unreachable`, no layer / overview content
 *  is served at all and the admin pages render the global read-only banner. */
export interface BundleSyncStatus {
  /** `live` = OAP ui_template store is the source. `readonly` = local bundle
   *  only; the config surface is read-only. */
  mode: 'live' | 'readonly';
  unreachable: boolean;
  lastSuccessfulSyncAt: number | null;
  generatedAt: number;
  badges: TemplateBadge[];
  conflicts: TemplateConflict[];
  /** Absent on a bundle cached by an older Horizon — read as "none reported". */
  unreadable?: UnreadableTemplateRow[];
}

/** Extension-page widget sets for one layer, keyed `<component>/<pageId>`. */
export type BundleExtPageMap = Record<string, DashboardWidget[]>;

export interface ConfigBundle {
  etag: string;
  generatedAt: number;
  layers: Record<string, BundleScopeMap>;
  /** Absent when no layer declares extension pages, which is every
   *  deployment running only bundled templates. */
  layerExtPages?: Record<string, BundleExtPageMap>;
  overviews: OverviewDashboard[];
  syncStatus: BundleSyncStatus;
}

/** Org-wide singleton settings, resolved by the BFF for its template mode.
 *  A `null` member means the runtime has no source for that setting — the
 *  caller applies its own in-code default. The disk bundle never arrives
 *  here in live mode; in readonly mode it IS the declared source and does. */
export interface EffectiveSettings {
  /** `horizon.theme.active` content — `{ themeId }`. */
  theme: unknown;
  /** `horizon.time-defaults.global` content — `{ defaultWindowMinutes }`. */
  timeDefaults: unknown;
  /** `horizon.alert.page-setup` content — see `AlarmsConfig`. */
  alert: unknown;
}

/** `bff.configs` — preload of dashboard + overview configs. The SPA
 *  caches the response in localStorage and re-fetches with
 *  `If-None-Match` so a 304 means "your cached copy is still good". */
export class ConfigsApi {
  constructor(private readonly bff: BffClient) {}

  /** The three org-wide singletons in one auth-gated read: no verb beyond a
   *  signed-in session, and no template rows in the payload. */
  settings(): Promise<EffectiveSettings> {
    return this.bff.request<EffectiveSettings>('GET', '/api/configs/settings');
  }

  /**
   * Fetch the bundle, optionally with a prior `etag` for cache
   * validation. Returns `null` on a 304 (the caller's cached copy
   * is current); otherwise a full bundle.
   */
  async bundle(
    ifNoneMatch?: string,
    prefer?: 'local' | 'remote',
    force?: boolean,
  ): Promise<ConfigBundle | null> {
    // X-Horizon-Locale is added explicitly here because this path
    // bypasses BffClient.request (304 needs to be a non-throwing
    // success), and bundle content varies by locale — without it,
    // the BFF falls through to browser Accept-Language and a
    // locale switch in the UI doesn't change overview / layer text.
    const headers: Record<string, string> = { 'X-Horizon-Locale': currentLocale() };
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    const params: string[] = [];
    if (prefer === 'local') params.push('prefer=local');
    // `force=true` makes the BFF invalidate its 30s OAP sync cache
    // before computing the bundle's `syncStatus`. Admin pages pass
    // this on mount so their badges reflect live OAP state, not a
    // stale snapshot from a prior session's localStorage cache.
    if (force) params.push('force=true');
    const path = `/api/configs/bundle${params.length ? '?' + params.join('&') : ''}`;
    // Direct fetch (not BffClient.request) because we need 304 to be a
    // non-throwing success path. The error logging that lives in
    // BffClient.request is replicated here so a bundle-load failure
    // still lands in the debug event log.
    let res: Response;
    try {
      res = await fetch(withBase(path), {
        method: 'GET',
        credentials: 'include',
        headers,
      });
    } catch (err) {
      pushEvent(
        'api',
        'err',
        `GET /api/configs/bundle · network ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    if (res.status === 304) return null;
    if (res.status === 401) {
      pushEvent('api', 'info', 'GET /api/configs/bundle · 401 (re-auth)');
      this.bff.handleUnauthorized();
      throw new Error('unauthenticated');
    }
    if (!res.ok) {
      pushEvent('api', 'err', `GET /api/configs/bundle · ${res.status}`);
      throw new Error(`bundle fetch failed (${res.status})`);
    }
    return (await res.json()) as ConfigBundle;
  }
}
