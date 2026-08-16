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

import type { AdminLayerTemplate } from '@/api/client';
import { layerKeyFromEditName } from '@/controls/localTemplateEdits';

/** A layer the roster reports, as the picker needs it. */
export interface RosterLayer {
  key: string;
  name: string;
  color?: string;
}

export interface LayerPickerList {
  list: AdminLayerTemplate[];
  /** Roster layers with no template at all — the picker's blanks. */
  unconfigured: number;
  /** Their keys, upper-cased. The "not configured" filter reads this
   *  rather than re-deriving the condition: asking whether a key is
   *  missing from the BUNDLED list answers a different question, and
   *  reported every stored-only layer — a published template — as
   *  unconfigured. */
  unconfiguredKeys: Set<string>;
}

/**
 * Which layers the dashboard editor offers, from three sources in
 * descending authority:
 *
 *  1. what the BFF loaded — every layer shipping a bundled JSON;
 *  2. layers that exist ONLY as a stored OAP row. A bundled default is not
 *     a precondition for editing: a template published from this page for
 *     a layer that never shipped one, or one whose services are not
 *     reporting right now, is still the operator's configuration and has
 *     to be reachable. Omitting it did not merely hide the layer — its
 *     deep link then selected a DIFFERENT one, silently, and edits meant
 *     for the published template were written to that other one;
 *  3. layers the roster reports with no template at all, opened from a
 *     blank and becoming real on first save.
 *
 * A stored-only layer is carried in as its stored CONTENT rather than a
 * blank: opening it empty would flatten its published widgets on save.
 */
export function composeLayerPickerList(
  bundled: readonly AdminLayerTemplate[],
  remoteNames: readonly string[],
  remoteContent: (name: string) => AdminLayerTemplate | null,
  roster: readonly RosterLayer[],
  blankFor: (key: string, alias: string, color?: string) => AdminLayerTemplate,
): LayerPickerList {
  const present = new Set(bundled.map((t) => t.key.toUpperCase()));
  const stored: AdminLayerTemplate[] = [];
  for (const name of remoteNames) {
    const key = layerKeyFromEditName(name);
    if (!key || present.has(key.toUpperCase())) continue;
    const content = remoteContent(name);
    if (!content?.key) continue;
    present.add(key.toUpperCase());
    stored.push(content);
  }
  stored.sort((a, b) => a.key.localeCompare(b.key));
  const synthesized = roster
    .filter((L) => !present.has(L.key.toUpperCase()))
    .map((L) => blankFor(L.key.toUpperCase(), L.name, L.color))
    .sort((a, b) => a.key.localeCompare(b.key));
  // `unconfigured` counts the blanks alone. A stored-only layer IS
  // configured — by the operator, on this page — and folding it in here
  // reported their own published template back to them as missing.
  return {
    list: [...bundled, ...stored, ...synthesized],
    unconfigured: synthesized.length,
    unconfiguredKeys: new Set(synthesized.map((t) => t.key.toUpperCase())),
  };
}
