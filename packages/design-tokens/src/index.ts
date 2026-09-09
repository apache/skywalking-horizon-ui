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

// TS mirror of the CSS custom properties in `tokens.css`. Useful when JS code
// (charts, D3 layouts, ECharts theme generation) needs the same values without
// reading them off the DOM.

export const tokens = {
  bg: {
    0: '#0a0d12',
    1: '#0f131a',
    2: '#151a23',
    3: '#1c222d',
    4: '#232a37',
  },
  line: {
    1: '#232a37',
    2: '#2e3645',
    3: '#3a4456',
  },
  fg: {
    0: '#e8ecf3',
    1: '#b6bdcc',
    2: '#818a9c',
    3: '#5b6373',
  },
  accent: {
    base: '#f97316',
    light: '#fb923c',
    soft: 'rgba(249,115,22,0.14)',
    line: 'rgba(249,115,22,0.4)',
  },
  semantic: {
    ok: '#22c55e',
    warn: '#eab308',
    err: '#ef4444',
    info: '#38bdf8',
    purple: '#a855f7',
    pink: '#ec4899',
    cyan: '#22d3ee',
  },
  font: {
    sans: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    mono: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
  },
} as const;

// A color scale suitable for chart series. Ordered so adjacent series stay
// distinguishable.
export const chartPalette = [
  tokens.accent.base,
  tokens.semantic.info,
  tokens.semantic.ok,
  tokens.semantic.purple,
  tokens.semantic.warn,
  tokens.semantic.pink,
  tokens.semantic.cyan,
  tokens.semantic.err,
  tokens.accent.light,
] as const;

export { THEMES, DEFAULT_THEME, type ThemeEntry, type ThemeId } from './themes.js';
