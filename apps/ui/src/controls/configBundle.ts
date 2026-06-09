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
 * Single-shot preload of every layer's dashboard widget set + the
 * overview-dashboard list. Lives in a module singleton so any
 * composable can look up `getDashboardConfig(layerKey, scope)` /
 * `getOverviews()` synchronously without re-fetching, and persists to
 * `localStorage` so a returning operator gets instant config reads —
 * the BFF's ETag tells us whether the cached copy is still good.
 *
 * Boot sequence:
 *   1. AppShell calls `ensureConfigBundle()` on mount.
 *   2. We read the prior bundle (if any) from localStorage and seed
 *      `state` synchronously so the first paint already has configs.
 *   3. We fire `GET /api/configs/bundle` with `If-None-Match`. A 304
 *      means the cached copy is current; a 200 supersedes it.
 *   4. Progress shows up in the EventTicker via pushEvent('preload', …).
 */

import { ref, computed, type ComputedRef, type Ref } from 'vue';
import { bffClient } from '@/api/client';
import { pushEvent } from '@/controls/eventLog';
import { debug } from '@/utils/debug';
import { useTemplatePreference } from '@/controls/templatePreference';
import { useLocalTemplateEdits, layerEditName, overviewEditName } from '@/controls/localTemplateEdits';
import { usePreviewMode, getPreviewSource } from '@/controls/previewMode';
import { usePreviewOverride } from '@/controls/previewOverride';
import type { ConfigBundle, BundleScopeMap } from '@/api/scopes/configs';
import type { DashboardWidget, OverviewDashboard } from '@skywalking-horizon-ui/api-client';

// Browser-side unpublished drafts. Overlaid on live pages ONLY while the
// route is in `?mode=preview` — the editor's explicit preview entrance.
// Normal viewing always renders remote; the draft is never shown to other
// users or in plain review.
const localEdits = useLocalTemplateEdits();
const previewMode = usePreviewMode();
// The Preview dropdown can preview ANY source (local/bundled/remote); it
// writes the chosen content here and this takes precedence over the draft.
const previewOverride = usePreviewOverride();

/** Content to overlay for `name` while previewing, or undefined.
 *  `source=local` reads the LIVE local draft (so it follows Reset/Save —
 *  no stale snapshot); `bundled`/`remote` read the override snapshot the
 *  Preview dropdown captured. */
function previewContentFor<T>(name: string): T | undefined {
  if (!previewMode.value) return undefined;
  const src = getPreviewSource();
  if (src === 'local') return localEdits.get<T>(name);
  if (src === 'bundled' || src === 'remote') return previewOverride.get<T>(name);
  // No explicit source (hand-typed ?mode=preview) — override then draft.
  return previewOverride.get<T>(name) ?? localEdits.get<T>(name);
}

/** Preview overlay content for a template `name` (a layer / overview
 *  edit name), or `undefined` when not in preview mode or no override
 *  exists for it. Exposed so pages that fetch a SINGLE template directly
 *  from the BFF (e.g. the overview-detail page) honour the same preview
 *  the bundle already applies to its list views — without it, the admin
 *  Preview button is a no-op on those pages. */
export function getPreviewContentFor<T>(name: string): T | undefined {
  return previewContentFor<T>(name);
}

/** `local` only when the operator opted to preview unpublished edits;
 *  otherwise `remote` (the default runtime source of truth). */
function preferParam(): 'local' | 'remote' {
  try {
    return useTemplatePreference().mode === 'local' ? 'local' : 'remote';
  } catch {
    return 'remote';
  }
}

// Bumped to v2 in 2026-05 when the bundle gained `syncStatus` (OAP
// UI-template overlay). v1 cached bundles lack the field; loading them
// would crash the admin pages reading badges.
const STORAGE_KEY = 'horizon:configBundle:v2';
const state = ref<ConfigBundle | null>(null);
let loadPromise: Promise<void> | null = null;

function readStorage(): ConfigBundle | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConfigBundle;
    // Strict shape check: a v2 bundle MUST carry syncStatus. Older v1
    // shapes are silently discarded — the next bundle fetch repopulates.
    if (!parsed?.etag || !parsed?.layers || !parsed?.syncStatus) return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeStorage(b: ConfigBundle): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    /* quota / disabled storage — degrade silently, in-memory still works */
  }
}

/**
 * Idempotent — first call kicks off the network fetch (or 304 check
 * against the localStorage etag); subsequent calls await the same
 * promise. Safe to call from every composable that needs configs.
 */
export function ensureConfigBundle(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const cached = readStorage();
    if (cached) {
      state.value = cached;
      pushEvent(
        'preload',
        'info',
        `Cached configs: ${Object.keys(cached.layers).length} layers + ${cached.overviews.length} overviews`,
      );
    }
    pushEvent('preload', 'start', 'Pre-loading dashboard + overview configs…');
    try {
      const fresh = await bffClient.configs.bundle(cached?.etag, preferParam());
      if (fresh) {
        state.value = fresh;
        writeStorage(fresh);
        pushEvent(
          'preload',
          'ok',
          `Pre-loaded ${Object.keys(fresh.layers).length} layer configs + ${fresh.overviews.length} overviews`,
        );
        logSyncSummary(fresh);
      } else {
        pushEvent('preload', 'ok', 'Configs unchanged · using cached copy');
        if (state.value) logSyncSummary(state.value);
      }
    } catch (err) {
      pushEvent(
        'preload',
        'err',
        `Config preload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Don't rethrow — but DO unblock the shell. A network / non-2xx
      // failure with no cached copy leaves `state` null, and the AppShell
      // waits on `loaded` before rendering ANY route — so the app would
      // hang on "Initializing…" forever. Seed an empty, unreachable bundle
      // so `loaded` flips true: routes render, per-page reads + the
      // connectivity banner take over, and the banner's retry can recover.
      if (state.value === null) {
        const now = Date.now();
        state.value = {
          etag: '',
          generatedAt: now,
          layers: {},
          overviews: [],
          syncStatus: {
            unreachable: true,
            lastSuccessfulSyncAt: null,
            generatedAt: now,
            badges: [],
            conflicts: [],
          },
        };
      }
    }
  })();
  return loadPromise;
}

/**
 * Force a fresh bundle pull, ignoring the cached etag. Needed after a
 * template push to OAP: the bundled content is unchanged (so an
 * etag-gated fetch would 304 and keep stale `syncStatus` badges), but
 * the OAP-side sync state HAS changed. Fetches without the etag so the
 * server returns the full bundle with a freshly computed `syncStatus`.
 *
 * `force=true` additionally invalidates the BFF's 30s OAP sync cache
 * before recomputing — admin pages opt into this on mount so the
 * badges reflect live OAP state and not the snapshot a prior session
 * persisted in localStorage. Default `false` keeps the render-side
 * fast path cached.
 */
export async function refreshConfigBundle(opts: { force?: boolean } = {}): Promise<void> {
  try {
    const fresh = await bffClient.configs.bundle(undefined, preferParam(), opts.force);
    if (fresh) {
      state.value = fresh;
      writeStorage(fresh);
    }
  } catch {
    /* leave the previous bundle in place — badges just stay stale */
  }
}

/** Set the global local-vs-remote render preference and re-pull the
 *  bundle so every dashboard re-renders from the chosen source. */
export async function setTemplateRenderMode(mode: 'local' | 'remote'): Promise<void> {
  useTemplatePreference().set(mode);
  await refreshConfigBundle();
}

/** Sync lookup. Returns null when the bundle hasn't loaded yet OR
 *  when the (layer, scope) pair has no widgets configured. */
export function getDashboardConfig(
  layerKey: string,
  scope: 'service' | 'instance' | 'endpoint',
): DashboardWidget[] | null {
  // In preview mode, overlay the previewed source's content for this layer.
  type LayerContent = { dashboards?: Record<string, DashboardWidget[]>; widgets?: DashboardWidget[] };
  const draft = previewContentFor<LayerContent>(layerEditName(layerKey));
  if (draft) {
    const d = draft.dashboards?.[scope] ?? (scope === 'service' ? draft.widgets : undefined);
    if (d !== undefined) return d;
  }
  const b = state.value;
  if (!b) return null;
  const layer = b.layers[layerKey.toLowerCase()] as BundleScopeMap | undefined;
  return layer?.[scope] ?? null;
}

/** Sync lookup. Returns null when the bundle hasn't loaded yet. Local
 *  browser drafts replace the matching overview for the editing operator. */
export function getOverviews(): OverviewDashboard[] | null {
  const base = state.value?.overviews ?? null;
  if (!base) return null;
  if (!previewMode.value) return base;
  // Overlay each overview with its previewed source's content…
  const out = base.map((ov) => previewContentFor<OverviewDashboard>(overviewEditName(ov.id)) ?? ov);
  // …and inject previewed overviews absent from the bundle.
  const seen = new Set(base.map((o) => o.id));
  for (const name of [...previewOverride.names(), ...localEdits.names()]) {
    if (!name.startsWith('horizon.overview.')) continue;
    const id = name.slice('horizon.overview.'.length);
    if (seen.has(id)) continue;
    const content = previewContentFor<OverviewDashboard>(name);
    if (content) {
      out.push(content);
      seen.add(id);
    }
  }
  return out;
}

export function useConfigBundle(): {
  bundle: Ref<ConfigBundle | null>;
  loaded: ComputedRef<boolean>;
} {
  return {
    bundle: state,
    loaded: computed<boolean>(() => state.value !== null),
  };
}

function logSyncSummary(b: ConfigBundle): void {
  const s = b.syncStatus;
  if (s.unreachable) {
    debug(
      'templates',
      `OAP unreachable — admin pages will render bundled read-only. Last successful sync: ${
        s.lastSuccessfulSyncAt ? new Date(s.lastSuccessfulSyncAt).toISOString() : 'never'
      }`,
    );
    return;
  }
  const counts: Record<string, number> = {};
  for (const b of s.badges) counts[b.status] = (counts[b.status] ?? 0) + 1;
  const parts = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  debug('templates', `sync: ${parts}`);
}
