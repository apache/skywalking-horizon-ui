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
 * Collapse state for the main navigation sidebar. Shared between the
 * shell grid (AppShell drives the `.sw` column width) and the sidebar
 * itself (AppSidebar renders the expand/collapse affordance). Sticky
 * per browser via localStorage so the operator's fold choice survives
 * reloads. Defaults expanded.
 */

import { ref, watch } from 'vue';

const STORAGE_KEY = 'horizon:sidebarCollapsed:v1';
const WIDTH_KEY = 'horizon:sidebarWidth:v1';

/** Expanded sidebar width bounds (px). The grab handle clamps to these;
 *  `SIDEBAR_DEFAULT_WIDTH` matches the `--sw-side-w` fallback in tokens.css. */
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 220;

function detectInitial(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === '1';
}

function detectWidth(): number {
  if (typeof localStorage === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
  const raw = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(raw) && raw >= SIDEBAR_MIN_WIDTH && raw <= SIDEBAR_MAX_WIDTH
    ? raw
    : SIDEBAR_DEFAULT_WIDTH;
}

const collapsed = ref<boolean>(detectInitial());
const width = ref<number>(detectWidth());

watch(collapsed, (on) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* private mode / quota — degrade silently */
  }
});

watch(width, (w) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* private mode / quota — degrade silently */
  }
});

/** Set the expanded sidebar width, clamped to the [min, max] bounds. */
function setWidth(px: number): void {
  width.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)));
}

export function useSidebar(): {
  collapsed: typeof collapsed;
  width: typeof width;
  toggle: () => void;
  setWidth: (px: number) => void;
  resetWidth: () => void;
} {
  return {
    collapsed,
    width,
    toggle: () => {
      collapsed.value = !collapsed.value;
    },
    setWidth,
    resetWidth: () => setWidth(SIDEBAR_DEFAULT_WIDTH),
  };
}
