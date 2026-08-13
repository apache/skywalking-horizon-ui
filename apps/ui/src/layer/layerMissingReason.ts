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
 * Why a `/layer/<key>/…` URL has no layer behind it. The layer shell asks
 * this once it knows the menu settled without the key, and renders the
 * matching card — a bookmarked tab must not be told the layer is "inactive
 * or unknown" when the real cause is a duplicated template on OAP.
 */

import type { TemplateConflict } from '@/api/scopes/configs';

export type LayerMissingReason =
  /** The layer's own dashboard template sits on more than one enabled OAP
   *  record with differing content, so the BFF hides it from the menu. */
  | 'duplicated'
  /** Everything else: OAP doesn't report the layer, it is admin-disabled,
   *  config-excluded, or the key is a typo. */
  | 'unknown';

/**
 * `conflicts` is the config bundle's duplicate report — the same signal the
 * BFF hides the layer on. Byte-identical copies are excluded there, so they
 * are excluded here too: those layers stay in the menu, and a missing one
 * therefore went missing for some other reason.
 *
 * No conflicts (template store unreachable, or a bundle that predates the
 * field) reads as `unknown`: naming a cause needs a positive signal.
 */
export function layerMissingReason(
  conflicts: TemplateConflict[] | null | undefined,
  layerKey: string,
): LayerMissingReason {
  if (!conflicts || !layerKey) return 'unknown';
  // Sidebar entries for a split-by-service-group layer carry `<key>~<group>`;
  // the template name is the layer key alone.
  const name = `horizon.layer.${layerKey.split('~', 1)[0].toUpperCase()}`;
  const hit = conflicts.some(
    (c) => c.kind === 'layer' && c.name === name && c.identical !== true,
  );
  return hit ? 'duplicated' : 'unknown';
}
