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
 * Resolve the **in-use** layer template — strictly REMOTE, with an
 * explicit block/default distinction.
 *
 * Runtime is remote-only: the disk-bundled template reaches the UI ONLY
 * by being synced INTO OAP (boot seed / admin reset-from-bundle) or via
 * admin preview — it is NEVER a render-time fallback. {@link
 * resolveEffectiveLayer} folds every state into two signals routes act on:
 *
 *   - `template` (non-null) — the remote OAP row's content, render it.
 *   - `blocked: true`       — the template store is UNREACHABLE, or the
 *     layer's row is admin-DISABLED. A deliberate **feature block**: the
 *     route serves nothing (empty) and the UI surfaces the connectivity
 *     banner (unreachable) / the layer is hidden from nav (disabled).
 *     Routes MUST NOT fall back to in-code defaults here.
 *   - `template: null, blocked: false` — reachable but NO remote row
 *     (an OAP layer Horizon ships no bundled template for, or one not yet
 *     synced). Routes render their hard-coded in-code **defaults** — this
 *     is the "remote OR default" runtime, never "remote OR bundled".
 *
 * Reads the shared 30s sync cache, so it's cheap on the hot path.
 */

import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { LayerTemplate } from './loader.js';
import { getSyncStatus } from '../templates/sync.js';
import { iterateBundledTemplates } from '../templates/aggregator.js';
import { formatName, parseEnvelope } from '../templates/names.js';
import { logger } from '../../logger.js';

export interface EffectiveLayer {
  /** Remote OAP row content to render, or `null` (use in-code defaults
   *  when `blocked` is false, render nothing when `blocked` is true). */
  template: LayerTemplate | null;
  /** Template store unreachable OR this layer's row disabled — block the
   *  feature (no defaults, no bundled). */
  blocked: boolean;
}

export async function resolveEffectiveLayer(
  uiTemplateClient: (() => UITemplateClient) | undefined,
  layerKey: string,
): Promise<EffectiveLayer> {
  // Unconfigured (tests / no OAP admin wired) — never hard-block on a
  // missing client; fall through to in-code defaults.
  if (!uiTemplateClient) return { template: null, blocked: false };
  try {
    const sync = await getSyncStatus({
      client: uiTemplateClient(),
      bundled: () => iterateBundledTemplates(),
      logger,
    });
    if (sync.unreachable) return { template: null, blocked: true }; // store down → block
    const name = formatName('layer', layerKey.toUpperCase());
    const row = sync.rows.find(
      (r) => r.name === name && r.kind === 'layer' && r.locale === undefined,
    );
    // No remote row → reachable but unknown/unsynced layer → in-code defaults.
    if (!row) return { template: null, blocked: false };
    // Admin disabled the layer's template → block (the sidebar also hides it).
    if (row.status === 'disabled') return { template: null, blocked: true };
    if (row.effective === 'remote' && row.remote) {
      const env = parseEnvelope(row.remote.configuration);
      if (env?.content && typeof env.content === 'object' && 'key' in env.content) {
        return { template: env.content as LayerTemplate, blocked: false };
      }
    }
    // Bundled-fallback (seed didn't land) or unparseable remote → we do
    // NOT resurrect bundled at render time; fall to in-code defaults.
    return { template: null, blocked: false };
  } catch {
    // Unexpected read error (getSyncStatus soft-fails internally, so this
    // is rare) — default rather than blank the app on a transient bug.
    return { template: null, blocked: false };
  }
}

/** Back-compat: the resolved remote template, or `null` for both the
 *  blocked and the use-defaults cases. Callers that localize / read the
 *  template content but don't gate on the block (e.g. translation
 *  overlay) use this; routes that must block use {@link
 *  resolveEffectiveLayer} directly. */
export async function resolveEffectiveLayerTemplate(
  uiTemplateClient: (() => UITemplateClient) | undefined,
  layerKey: string,
): Promise<LayerTemplate | null> {
  return (await resolveEffectiveLayer(uiTemplateClient, layerKey)).template;
}
