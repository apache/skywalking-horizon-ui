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
 * Wire shape for the per-layer customization persisted by the BFF.
 *
 * Eventually these configs will live in OAP via `addTemplate` mutations
 * (under the `horizon-` ID prefix) — see PLAN.md "Locked decisions" #2.
 * Until then, the BFF stores them in a JSON file on disk. The UI and
 * server agree on this shape so the swap is a one-place change.
 */

import type { LayerCaps, LayerSlots } from './menu.js';

export interface LandingColumn {
  /** MQE-result key. */
  metric: string;
  /** Short header label (e.g. `cpm`). */
  label: string;
  /** Suffix unit (`%`, `ms`, etc.). */
  unit?: string;
}

export interface LandingConfig {
  /** Lower number → higher on the Overview. */
  priority: number;
  /** Number of services to surface in the landing card, clamped 5..8. */
  topN: number;
  /** Metric key used to rank the top-N. */
  orderBy: string;
  columns: LandingColumn[];
  /** Optional sparkline column. */
  spark?: { metric: string; height: number };
  style: 'table' | 'bar' | 'mini-topology';
}

export interface LayerConfig {
  /** Override display name (defaults to OAP `getMenuItems.title`). */
  displayName?: string;
  slots: LayerSlots;
  caps: LayerCaps;
  landing: LandingConfig;
}

export interface SetupResponse {
  generatedAt: number;
  /** Layer key → operator-overridden config. Layers without an override
   *  fall through to horizon-side defaults at render time. */
  layers: Record<string, LayerConfig>;
}

export interface SetupSavePayload {
  layers: Record<string, LayerConfig>;
}
