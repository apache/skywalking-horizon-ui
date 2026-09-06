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
 * The neutral colours of the 3D scene, read from the active theme's tokens.
 *
 * WebGL cannot read a CSS variable, so the scene's background and the
 * materials that are "surface" rather than "signal" (the tier slab and its
 * rim, the ghost box, cube edges, cluster frames, hierarchy lines) take
 * their colour from `--sw-*` at mount and again when the theme changes.
 * Layer colours and alarm reds are signals and stay as they are.
 */
export interface ScenePalette {
  appearance: 'dark' | 'light';
  /** The canvas clear colour — `--sw-bg-0`. */
  bg0: string;
  /** The tier slab — `--sw-bg-2`. */
  slab: string;
  /** The slab's rim — `--sw-line-3`. */
  slabRim: string;
  /** The ghost box of a hidden tier — `--sw-bg-3`. */
  ghost: string;
  /** Cube outlines and hierarchy lines — `--sw-fg-2`. */
  edge: string;
  /** Cluster frames — `--sw-fg-3`. */
  frame: string;
}

/** The dark theme's values, for a document without the tokens (tests). */
const DARK: ScenePalette = {
  appearance: 'dark',
  bg0: '#0a0d12',
  slab: '#151a23',
  slabRim: '#3a4456',
  ghost: '#1c222d',
  edge: '#818a9c',
  frame: '#5b6373',
};

const TOKEN: Record<Exclude<keyof ScenePalette, 'appearance'>, string> = {
  bg0: '--sw-bg-0',
  slab: '--sw-bg-2',
  slabRim: '--sw-line-3',
  ghost: '--sw-bg-3',
  edge: '--sw-fg-2',
  frame: '--sw-fg-3',
};

/** Only a hex colour can be handed to three.js; a token that resolves to
 *  anything else (or nothing) keeps the dark default. */
function hexOf(v: string): string | null {
  const s = v.trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

export function readScenePalette(root: Element | null = typeof document === 'undefined' ? null : document.documentElement): ScenePalette {
  if (!root) return { ...DARK };
  const style = getComputedStyle(root);
  const out: ScenePalette = { ...DARK };
  for (const k of Object.keys(TOKEN) as Array<keyof typeof TOKEN>) {
    const hex = hexOf(style.getPropertyValue(TOKEN[k]));
    if (hex) out[k] = hex;
  }
  out.appearance = root.getAttribute('data-appearance') === 'light' ? 'light' : 'dark';
  return out;
}
