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
 * Edits to the 3D-map draft that keep it holding only what the map reads.
 * Group membership decides a grouped layer's tier (see useInfra3dConfig), so
 * a tier pin on a grouped layer never applies and is not kept.
 */

import type { Infra3dConfig, InfraGroupSpec } from '@/api/client';

/** Fold the deprecated `topology` / `load` into the single `metric`, drop
 *  the stored `pipeline` block, and drop tier pins of grouped layers.
 *  Mutates in place. */
export function normalizeInfra3dDraft(cfg: Infra3dConfig): void {
  for (const spec of Object.values(cfg.layers)) {
    if (!spec.metric) {
      const m = spec.topology?.server ?? spec.topology?.client ?? spec.load;
      if (m) spec.metric = m;
    }
    delete spec.topology;
    delete spec.load;
  }
  // The fan-out limits live in horizon.yaml and the config route injects
  // them, so a stored copy is never read.
  delete (cfg as { pipeline?: unknown }).pipeline;
  const grouped = new Set(Object.keys(groupsByLayer(cfg)));
  for (const lvl of cfg.levels) {
    lvl.layers = lvl.layers.filter((k) => !grouped.has(k.toUpperCase()));
  }
}

/** Layer key (upper) → its logic group, first match as the renderer reads it. */
export function groupsByLayer(cfg: Infra3dConfig): Record<string, InfraGroupSpec> {
  const out: Record<string, InfraGroupSpec> = {};
  for (const g of cfg.groups ?? []) {
    for (const k of g.layers) {
      const u = k.toUpperCase();
      if (!out[u]) out[u] = g;
    }
  }
  return out;
}

/** A layer joins at most one group, and joining drops its tier pin. */
export function addLayerToGroup(cfg: Infra3dConfig, group: InfraGroupSpec, key: string): void {
  const u = key.toUpperCase();
  if (!u || groupsByLayer(cfg)[u]) return;
  group.layers.push(u);
  for (const lvl of cfg.levels) {
    lvl.layers = lvl.layers.filter((k) => k.toUpperCase() !== u);
  }
}

/** A metric with all three fields blank says nothing and the push refuses
 *  it; one partly filled in is work in progress and stays. */
export function dropBlankMetrics(cfg: Infra3dConfig): void {
  for (const spec of Object.values(cfg.layers)) {
    const m = spec.metric;
    if (m && !m.mqe.trim() && !m.label.trim() && !m.unit.trim()) delete spec.metric;
  }
}
