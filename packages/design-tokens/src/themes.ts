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
 * The bundled themes, one entry per `[data-theme="<id>"]` block in
 * `themes.css`. This is the list a host outside Horizon reads to pick a theme
 * — the AI Sessionizer's viewer, or anything else that embeds the conversation
 * renderer on these tokens — and the list Horizon's own picker is checked
 * against, so the two cannot drift.
 *
 * `appearance` is what `<html data-appearance>` carries: the one thing the
 * palette alone cannot express (a logo swap, a light-background code path).
 */
export interface ThemeEntry {
  id: string;
  label: string;
  appearance: 'dark' | 'light';
}

export const THEMES: readonly ThemeEntry[] = [
  { id: 'horizon', label: 'Horizon', appearance: 'dark' },
  { id: 'meridian', label: 'Meridian', appearance: 'dark' },
  { id: 'obsidian', label: 'Obsidian', appearance: 'dark' },
  { id: 'daybreak', label: 'Daybreak', appearance: 'light' },
  { id: 'aurora', label: 'Aurora', appearance: 'dark' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

/** The default when nothing chose one — the `:root` palette in `tokens.css`. */
export const DEFAULT_THEME: ThemeId = 'horizon';
