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
 * Shared store for per-cube traffic-MQE values produced by stage 5 of
 * the loading pipeline. The Scene reads `valueFor(node)` /
 * `unitFor(node)` to decorate each cube with a small chip; the pipeline
 * (in Infra3DView) writes via `setValues()` chunk-by-chunk so the
 * cubes light up progressively as the timeline advances.
 *
 *   - Keys are `${LAYER}::${serviceName}` (canonical upper-case layer).
 *     Matches the BFF response shape and `SceneServiceNode.nodeId`.
 *   - Values: `number | null` — null means "OAP returned no data" or
 *     "the layer has no MQE configured". The chip is hidden in either
 *     case, not rendered as "0".
 *   - Unit string comes from the layer's resolved MQE; cached separately
 *     so the chip can pick a sensible suffix ("rpm" / "qps" / "%") even
 *     when the layer has many services sharing the same MQE.
 */

import { readonly, shallowRef } from 'vue';

const values = shallowRef<Map<string, number | null>>(new Map());
const units = shallowRef<Map<string, string>>(new Map()); // key: layerKey upper-case

export function useInfra3dMetrics() {
  return {
    values: readonly(values),
    units: readonly(units),
    setValues,
    setUnitForLayer,
    valueFor,
    unitFor,
    reset,
  };
}

export function setValues(partial: Record<string, number | null>): void {
  const next = new Map(values.value);
  for (const [k, v] of Object.entries(partial)) next.set(k, v);
  values.value = next;
}

export function setUnitForLayer(layerKey: string, unit: string): void {
  const k = layerKey.toUpperCase();
  if (units.value.get(k) === unit) return;
  const next = new Map(units.value);
  next.set(k, unit);
  units.value = next;
}

export function valueFor(layer: string, serviceName: string): number | null | undefined {
  return values.value.get(`${layer.toUpperCase()}::${serviceName}`);
}

export function unitFor(layer: string): string {
  return units.value.get(layer.toUpperCase()) ?? '';
}

export function reset(): void {
  values.value = new Map();
  units.value = new Map();
}

/** Format a metric value for the cube chip. Small numbers render
 *  with 1 decimal; ≥100 collapse to integers; ≥1000 use k-suffix.
 *  Null / undefined return null so the caller can hide the chip. */
export function formatMetricValue(v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
