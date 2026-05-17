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
import type { ConfigBundle, BundleScopeMap } from '@/api/scopes/configs';
import type { DashboardWidget, OverviewDashboard } from '@skywalking-horizon-ui/api-client';

const STORAGE_KEY = 'horizon:configBundle:v1';
const state = ref<ConfigBundle | null>(null);
let loadPromise: Promise<void> | null = null;

function readStorage(): ConfigBundle | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConfigBundle;
    if (!parsed?.etag || !parsed?.layers) return null;
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
      const fresh = await bffClient.configs.bundle(cached?.etag);
      if (fresh) {
        state.value = fresh;
        writeStorage(fresh);
        pushEvent(
          'preload',
          'ok',
          `Pre-loaded ${Object.keys(fresh.layers).length} layer configs + ${fresh.overviews.length} overviews`,
        );
      } else {
        pushEvent('preload', 'ok', 'Configs unchanged · using cached copy');
      }
    } catch (err) {
      pushEvent(
        'preload',
        'err',
        `Config preload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Don't rethrow — the SPA falls back to per-page network reads.
    }
  })();
  return loadPromise;
}

/** Sync lookup. Returns null when the bundle hasn't loaded yet OR
 *  when the (layer, scope) pair has no widgets configured. */
export function getDashboardConfig(
  layerKey: string,
  scope: 'service' | 'instance' | 'endpoint',
): DashboardWidget[] | null {
  const b = state.value;
  if (!b) return null;
  const layer = b.layers[layerKey.toLowerCase()] as BundleScopeMap | undefined;
  return layer?.[scope] ?? null;
}

/** Sync lookup. Returns null when the bundle hasn't loaded yet. */
export function getOverviews(): OverviewDashboard[] | null {
  return state.value?.overviews ?? null;
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
