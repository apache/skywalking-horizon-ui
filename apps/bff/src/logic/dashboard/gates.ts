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
 * Widget visibility gates (`visibleWhen`).
 *
 * `mqe` gates are existential over the WHOLE result — every labeled series
 * (relabels / histogram), every bucket — so `flattenValues` collapses an
 * MqeResultShape to its non-null numeric value set and the op tests "at least
 * one value …". `entity` gates read the selected instance's attribute bag.
 * `flattenTabWidgets` expands `tab` containers so the pipeline only sees leaves.
 */

import type { DashboardWidget, VisibleWhen } from '@skywalking-horizon-ui/api-client';
import type { MqeResultShape } from './mqe.js';

/** Every non-null numeric value across all labeled series + buckets. */
export function flattenValues(r: MqeResultShape | undefined): number[] {
  if (!r || r.error) return [];
  const out: number[] = [];
  for (const rs of r.results ?? []) {
    for (const v of rs.values ?? []) {
      if (v.value === null || v.value === undefined) continue;
      const n = Number(v.value);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

export function mqeGatePass(op: 'exists' | 'gt' | 'lt', value: number | undefined, vals: number[]): boolean {
  if (op === 'gt') return value !== undefined && vals.some((v) => v > value);
  if (op === 'lt') return value !== undefined && vals.some((v) => v < value);
  return vals.length > 0; // exists
}

/** Attribute lookup for the selected instance: `language` + named
 *  attributes, keyed lower-case. Empty values are dropped so `exists`
 *  means present-AND-non-empty (OAP reports `namespace`/`cluster` as
 *  empty-string keys). */
export function buildAttrMap(
  language: string | null | undefined,
  attrs: Array<{ name: string; value: string }>,
): Map<string, string> {
  const m = new Map<string, string>();
  if (language && language.trim()) m.set('language', language.trim());
  for (const a of attrs) {
    const v = a.value == null ? '' : String(a.value);
    if (v.trim() !== '') m.set(a.name.toLowerCase(), v);
  }
  return m;
}

/** Evaluate an entity gate. `attrs === null` means "no entity context"
 *  (non-Instance scope / probe failed) → no-op (visible). */
export function entityGatePass(
  vw: Extract<VisibleWhen, { kind: 'entity' }>,
  attrs: Map<string, string> | null,
): boolean {
  if (!attrs) return true;
  const val = attrs.get(vw.attribute.toLowerCase());
  if (vw.op === 'eq') return val !== undefined && val.toLowerCase() === vw.value.toLowerCase();
  return val !== undefined; // exists (map already excludes empties)
}

/** Normalize a widget's gate — overlay-sourced widgets may still carry a
 *  legacy string; anything that isn't the structured object is no gate. */
export function vwOf(w: DashboardWidget): VisibleWhen | undefined {
  const vw = w.visibleWhen as unknown;
  return vw && typeof vw === 'object' && 'kind' in (vw as object) ? (vw as VisibleWhen) : undefined;
}

/** A `mqe` gate whose expression the widget already queries — evaluated
 *  from the widget's own batch result (no extra probe, no skip). */
export function isSelfGate(w: DashboardWidget, vw: VisibleWhen): boolean {
  return vw.kind === 'mqe' && w.expressions.includes(vw.expression);
}

/** Expand `tab` containers to their leaf children so the pipeline only sees
 *  queryable leaves (a tab carries no MQE). Covers the template-resolved
 *  fallback + direct API callers; the SPA already flattens to the active tab.
 *  Emits only the FIRST (default-active) panel — matching the lazy contract,
 *  so a tab group never fans into a larger OAP request than the UI issues. */
export function flattenTabWidgets(widgets: DashboardWidget[]): DashboardWidget[] {
  const out: DashboardWidget[] = [];
  for (const w of widgets) {
    if (w.type === 'tab') {
      const firstPanel = (w.tabs ?? [])[0];
      for (const child of firstPanel?.widgets ?? []) {
        if (child.type !== 'tab') out.push(child);
      }
    } else {
      out.push(w);
    }
  }
  return out;
}
