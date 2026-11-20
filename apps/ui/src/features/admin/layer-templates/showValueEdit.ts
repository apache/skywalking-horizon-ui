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
 * The editor's changes to a line widget's `showValue`, from the raw values
 * its controls report. An option set back to its default is removed rather
 * than stored, so a widget only carries what differs from the defaults.
 */

import {
  LINE_VALUE_CALCULATIONS,
  LINE_VALUE_DEFAULTS,
  LINE_VALUE_LAYOUTS,
  type DashboardWidget,
} from '@skywalking-horizon-ui/api-client';

/** Picking a calculation turns the number on and keeps the options already
 *  set; anything else (the "none" choice) removes the whole block. */
export function setShowValueCalculation(w: DashboardWidget, raw: string): void {
  const calculation = LINE_VALUE_CALCULATIONS.find((c) => c === raw);
  if (calculation) w.showValue = { ...w.showValue, calculation };
  else delete w.showValue;
}

export type ShowValueOption = 'layout' | 'topMargin' | 'axes' | 'split';

/** Bounds a typed number is clamped into, matching what a push accepts. */
const RANGE = { topMargin: [0, 400], split: [15, 70] } as const;

export function setShowValueOption(w: DashboardWidget, key: ShowValueOption, raw: string): void {
  const sv = w.showValue;
  if (!sv) return;
  if (key === 'layout') {
    const layout = LINE_VALUE_LAYOUTS.find((l) => l === raw);
    if (!layout || layout === LINE_VALUE_DEFAULTS.layout) delete sv.layout;
    else sv.layout = layout;
    return;
  }
  if (key === 'axes') {
    if (raw === 'shown') sv.axes = true;
    else delete sv.axes;
    return;
  }
  const n = Math.round(Number(raw));
  if (raw.trim() === '' || !Number.isFinite(n)) {
    delete sv[key];
    return;
  }
  const [lo, hi] = RANGE[key];
  const v = Math.min(hi, Math.max(lo, n));
  if (v === LINE_VALUE_DEFAULTS[key]) delete sv[key];
  else sv[key] = v;
}
