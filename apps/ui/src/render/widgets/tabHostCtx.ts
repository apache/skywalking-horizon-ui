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

import type {
  DashboardWidget,
  DashboardTableRow,
  DashboardTopItem,
} from '@skywalking-horizon-ui/api-client';

/** A widget moved INTO a tab must render identically to a top-level widget —
 *  including the multi-entity compare view and the top/record pop-out. Rather
 *  than re-derive that logic inside the tab component (which drifts), the host
 *  (LayerDashboardsView) passes its own render helpers down through this
 *  context. These mirror the helpers the top-level grid already uses. */

/** One overlaid line per locked entity (mirrors the host's `multiLineSeries`). */
export interface CompareSeries {
  label: string;
  data: Array<number | null>;
  yAxisIndex?: number;
  unit?: string;
  color: string;
}
/** A per-entity (or "All") sorted list group (mirrors `multiTopGroups`). */
export interface CompareTopGroup {
  label: string;
  expression: string;
  items: DashboardTopItem[];
}
/** A locked entity tagged for TableWidget's grouped compare rendering. */
export interface CompareEntity {
  key: string;
  name: string;
  hue: string;
}

/** Compare-mode helpers — present only while a cohort is locked. */
export interface TabCompareCtx {
  entities: string[];
  tableEntities: CompareEntity[];
  loading: boolean;
  hue: (key: string) => string;
  label: (key: string) => string;
  cardText: (w: DashboardWidget, key: string) => string;
  cardValue: (id: string, key: string) => number | null;
  lineSeries: (id: string) => CompareSeries[];
  lineLen: (id: string) => number;
  topGroups: (id: string) => CompareTopGroup[];
  hasTop: (id: string) => boolean;
  tableRows: (id: string) => Array<DashboardTableRow & { entityKey: string }>;
}

/** The full render context the host hands a TabWidget so its children behave
 *  like top-level widgets. `compare` is null in single-entity mode. */
export interface TabHostCtx {
  widgetColor: (w: DashboardWidget) => string;
  /** Register a top/record TopList instance so the host can pop it out. */
  setTopListRef: (id: string, el: unknown) => void;
  popOutTopList: (id: string) => void;
  hasTopData: (w: DashboardWidget) => boolean;
  /** The host's canonical `visibleWhen` filter (single-entity flag; compare =
   *  per-entity union). Tab children reuse it rather than re-checking primary. */
  isHidden: (id: string) => boolean;
  compare: TabCompareCtx | null;
}
