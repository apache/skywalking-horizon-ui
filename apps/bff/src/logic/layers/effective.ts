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
 * Resolve the **in-use** layer template — strictly the effective REMOTE row,
 * with an explicit block/default distinction.
 *
 * In `live` mode Horizon renders what OAP stores, full stop. The disk-bundled
 * template is a seed/reset source (it syncs INTO OAP at boot) and is NEVER a
 * render-time fallback. Bundled content reaches a running Horizon through
 * exactly two doors, neither of which is a fallback: `templates.mode: readonly`
 * — where the sync status presents the disk bundle AS the effective rows, so
 * this resolver reads it like any remote row — and the config bundle's
 * `?prefer=local` preview. {@link resolveEffectiveLayer} folds every state into
 * two signals routes act on:
 *
 *   - `template` (non-null) — the effective row's content, render it.
 *   - `blocked: true`       — the template store is UNREACHABLE, or the layer's
 *     row is admin-DISABLED. A deliberate **feature block**: the route serves
 *     nothing (empty) and the UI surfaces the connectivity banner (unreachable)
 *     / the layer is hidden from nav (disabled). Routes MUST NOT fall back to
 *     in-code defaults here.
 *   - `template: null, blocked: false` — reachable but NO remote row Horizon
 *     can read for this layer (an OAP layer Horizon ships no bundled template
 *     for, one not yet synced, or a row that is not readable as this layer —
 *     see below). Routes render their hard-coded in-code **defaults** — this
 *     is the "remote OR default" runtime, never "remote OR bundled".
 *
 * An identity-invalid row (the sync layer gives it `effective: null`) lands in
 * that last case DELIBERATELY, not in `blocked`. Blocking is reserved for the
 * two states an operator can act on and would recognise — the store is down, or
 * they disabled this layer. A row holding some other layer's template is
 * neither: it is a record that says nothing about THIS layer, so the honest
 * reading is the one every other reader already takes, "no row for this layer".
 * Blocking on it would let one stray record dark a working layer's features,
 * and the operator would have no disable to un-do. It is reported on the sync
 * status instead, where the admin banner names the record id.
 *
 * Reads the shared 30s sync cache, so it's cheap on the hot path.
 */

import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { LayerTemplate } from './loader.js';
import { getSyncStatus } from '../templates/sync.js';
import { iterateBundledTemplates } from '../templates/aggregator.js';
import { formatName, parseEnvelope } from '../templates/names.js';
import { canonicalLayerKey } from '../templates/identity.js';
import { logger } from '../../logger.js';

/**
 * Why {@link resolveEffectiveLayer} returned what it did. `blocked` folds the
 * two block states into one boolean for routes, which is all a route needs —
 * but a reader that has to EXPLAIN the outcome cannot tell an OAP outage from
 * an empty layer, and those warrant opposite responses. The AI tools report
 * this verbatim so an agent never calls an unreachable store "no metrics".
 */
export type EffectiveLayerReason =
  /** A remote row resolved — `template` is non-null. */
  | 'ok'
  /** Admin port unreachable. Affects EVERY layer; an OAP health incident. */
  | 'store-unreachable'
  /** An administrator disabled this layer's row. Deliberate, one layer. */
  | 'layer-disabled'
  /** Reachable, but nothing readable for this layer — unsynced, identity-
   *  invalid or unparseable. One layer; routes use in-code defaults. */
  | 'no-remote-row'
  /** The read itself threw. Rare (the sync layer soft-fails internally), and
   *  distinct from `no-remote-row`: nothing is known about the layer, so it
   *  must not be reported as "not synced". */
  | 'read-error';

export interface EffectiveLayer {
  /** Remote OAP row content to render, or `null` (use in-code defaults
   *  when `blocked` is false, render nothing when `blocked` is true). */
  template: LayerTemplate | null;
  /** Template store unreachable OR this layer's row disabled — block the
   *  feature (no defaults, no bundled). Equivalent to `reason` being
   *  `store-unreachable` or `layer-disabled`. */
  blocked: boolean;
  /** The distinction `blocked` discards. */
  reason: EffectiveLayerReason;
}

export async function resolveEffectiveLayer(
  uiTemplateClient: (() => UITemplateClient) | undefined,
  layerKey: string,
): Promise<EffectiveLayer> {
  // Unconfigured (tests / no OAP admin wired) — never hard-block on a
  // missing client; fall through to in-code defaults.
  if (!uiTemplateClient) return { template: null, blocked: false, reason: 'no-remote-row' };
  try {
    const sync = await getSyncStatus({
      client: uiTemplateClient(),
      bundled: () => iterateBundledTemplates(),
      logger,
    });
    const name = formatName('layer', canonicalLayerKey(layerKey));
    const row = sync.rows.find(
      (r) => r.name === name && r.kind === 'layer' && r.locale === undefined,
    );
    // Admin disabled the layer's template → block (the sidebar also hides it).
    // Checked BEFORE the unreachable branch: a disabled layer is an
    // administrator's decision and stays decided whether or not the store can
    // be read right now.
    if (row?.status === 'disabled') return { template: null, blocked: true, reason: 'layer-disabled' };
    // A REMOTE row renders — including one retained from the last successful
    // read while the store is unreachable. That is the operator's own
    // published configuration, not the disk bundle: `sync` marks bundled rows
    // `bundled-fallback`, never `remote`, so this gate cannot admit them and
    // the live-mode rule is untouched.
    if (row?.effective === 'remote' && row.remote) {
      // The row's own name got us here, but the name alone is not the
      // identity: `effective` is what the shared identity rule leaves behind,
      // so a row carrying another layer's template never renders as this one.
      const env = parseEnvelope(row.remote.configuration);
      if (env?.content && typeof env.content === 'object' && 'key' in env.content) {
        return { template: env.content as LayerTemplate, blocked: false, reason: 'ok' };
      }
    }
    // Nothing retained for this layer and the store cannot be read → block.
    // NOT a degrade to disk: the bundle can differ from what the operator
    // published, and rendering it as though it were the live config is worse
    // than an empty page behind the connectivity banner. An OAP that never
    // serves the template store (10.x) runs `templates.mode: readonly`, where
    // `unreachable` is always false.
    if (sync.unreachable) return { template: null, blocked: true, reason: 'store-unreachable' };
    // No remote row → reachable but unknown/unsynced layer → in-code defaults.
    if (!row) return { template: null, blocked: false, reason: 'no-remote-row' };
    // Bundled-fallback (seed didn't land), identity-invalid, or unparseable
    // remote → we do NOT resurrect bundled at render time; in-code defaults.
    return { template: null, blocked: false, reason: 'no-remote-row' };
  } catch {
    // Unexpected read error (getSyncStatus soft-fails internally, so this
    // is rare) — default rather than blank the app on a transient bug.
    return { template: null, blocked: false, reason: 'read-error' };
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

/**
 * The blocked reason as the graph routes report it.
 *
 * Only two of the resolver's reasons BLOCK, and only those two are worth
 * naming on the wire: a store that could not be read, and a template an
 * administrator disabled. Anything else is not a block, so it contributes
 * nothing and the field stays absent.
 */
export function blockedReason(
  reason: EffectiveLayerReason,
): { blocked?: 'store-unreachable' | 'layer-disabled' } {
  if (reason === 'store-unreachable' || reason === 'layer-disabled') return { blocked: reason };
  return {};
}
