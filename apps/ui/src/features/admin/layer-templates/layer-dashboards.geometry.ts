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
 * Grid geometry for the layer-dashboard admin canvas — shared by the
 * widget grid-style helpers and the drag/resize handlers in
 * `LayerDashboardsAdmin.vue`.
 */

import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';

/** Top-level canvas grid: 12 columns, fixed row height + gap (px). */
export const CANVAS_COLS = 12;
export const CANVAS_ROW_PX = 120;
export const CANVAS_GAP_PX = 8;
/** Nested tab-widget sub-grid (same column count, tighter rows). */
export const SUBGRID_ROW_PX = 84;
export const SUBGRID_GAP_PX = 6;
/** Width (px) of the floating widget-edit drawer, anchored to the canvas. */
export const DRAWER_COL = 360;

export function widgetSpan(w: DashboardWidget): number {
  return Math.min(CANVAS_COLS, Math.max(1, w.span ?? 4));
}
export function widgetRowSpan(w: DashboardWidget): number {
  return Math.max(1, w.rowSpan ?? 2);
}
export function widgetGridStyle(w: DashboardWidget): Record<string, string> {
  return {
    gridColumn: `span ${widgetSpan(w)}`,
    gridRow: `span ${widgetRowSpan(w)}`,
  };
}
