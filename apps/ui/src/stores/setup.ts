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

import { defineStore } from 'pinia';
import { reactive } from 'vue';
import type { LayerCaps, LayerSlots } from '@skywalking-horizon-ui/api-client';

/** Per-layer landing-card configuration. See docs/design/landing-composition.md. */
export interface LandingConfig {
  enabled: boolean;
  /** Lower number → higher on the page. Defaults seeded from priority table. */
  priority: number;
  /** 5..8. */
  topN: number;
  /** MQE key used to rank the top-N services for this layer. */
  orderBy: string;
  /** Columns shown per service row in the card. */
  columns: Array<{ metric: string; label: string; unit?: string }>;
  /** Optional sparkline column metric. */
  spark?: { metric: string; height: number };
  style: 'table' | 'bar' | 'mini-topology';
}

/** Editable per-layer config the setup page mutates. Mirrors what the
 *  Phase 7 admin UI will persist via the BFF. */
export interface LayerConfig {
  /** Override display name (defaults to the menu title from OAP). */
  displayName?: string;
  /** Term aliases — overrides slots from /api/menu. */
  slots: LayerSlots;
  /** Feature toggles — start from /api/menu defaults, operator can disable. */
  caps: LayerCaps;
  landing: LandingConfig;
}

/** Default-priority table per the design (General → Virtual* → Mesh → K8s). */
function defaultPriority(layerKey: string): number {
  const k = layerKey.toLowerCase();
  if (k === 'general') return 10;
  if (k.startsWith('virtual_')) return 20;
  if (k === 'mesh' || k === 'mesh_cp' || k === 'mesh_dp') return 30;
  if (k === 'k8s' || k === 'k8s_service') return 40;
  return 99;
}

/** Default-columns table per layer category. Concrete MQE metric names are
 *  illustrative until Stage 2.4 wires them up — adjust per layer admin. */
function defaultColumns(_layerKey: string): LandingConfig['columns'] {
  return [
    { metric: 'cpm', label: 'cpm' },
    { metric: 'p99', label: 'p99', unit: 'ms' },
    { metric: 'sla', label: 'SLA', unit: '%' },
    { metric: 'err', label: 'err', unit: '%' },
  ];
}

export function defaultLandingFor(layerKey: string): LandingConfig {
  return {
    enabled: false, // operator opts-in per layer in the setup page
    priority: defaultPriority(layerKey),
    topN: 5,
    orderBy: 'cpm',
    columns: defaultColumns(layerKey),
    spark: { metric: 'cpm', height: 28 },
    style: 'table',
  };
}

export function defaultLayerConfig(
  layerKey: string,
  defaults: { slots: LayerSlots; caps: LayerCaps },
): LayerConfig {
  return {
    slots: { ...defaults.slots },
    caps: { ...defaults.caps },
    landing: defaultLandingFor(layerKey),
  };
}

export const useSetupStore = defineStore('setup', () => {
  /** Layer key → edited config. Phase 2.4 will persist this via BFF. */
  const configs = reactive<Record<string, LayerConfig>>({});

  function ensure(
    layerKey: string,
    defaults: { slots: LayerSlots; caps: LayerCaps },
  ): LayerConfig {
    if (!configs[layerKey]) configs[layerKey] = defaultLayerConfig(layerKey, defaults);
    return configs[layerKey];
  }

  function reset(layerKey: string, defaults: { slots: LayerSlots; caps: LayerCaps }): void {
    configs[layerKey] = defaultLayerConfig(layerKey, defaults);
  }

  return { configs, ensure, reset };
});
