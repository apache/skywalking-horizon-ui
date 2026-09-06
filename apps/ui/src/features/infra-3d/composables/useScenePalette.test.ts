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

import { afterEach, describe, expect, it } from 'vitest';
import { readScenePalette } from './useScenePalette';

afterEach(() => {
  const root = document.documentElement;
  for (const p of ['--sw-bg-0', '--sw-bg-2', '--sw-line-3', '--sw-bg-3', '--sw-fg-2', '--sw-fg-3']) root.style.removeProperty(p);
  root.removeAttribute('data-appearance');
});

describe('readScenePalette', () => {
  it('reads the scene neutrals from the theme tokens and the appearance from the root', () => {
    const root = document.documentElement;
    root.style.setProperty('--sw-bg-0', '#F7F7FA');
    root.style.setProperty('--sw-bg-2', '#eef0f4');
    root.style.setProperty('--sw-line-3', '#b8bfcc');
    root.style.setProperty('--sw-fg-2', '#5f6878');
    root.setAttribute('data-appearance', 'light');
    const p = readScenePalette();
    expect(p).toMatchObject({ appearance: 'light', bg0: '#f7f7fa', slab: '#eef0f4', slabRim: '#b8bfcc', edge: '#5f6878' });
  });

  it('keeps the dark default for a token that is missing or is not a hex colour', () => {
    document.documentElement.style.setProperty('--sw-bg-0', 'rgba(0, 0, 0, 0.5)');
    const p = readScenePalette();
    expect(p.bg0).toBe('#0a0d12');
    expect(p.frame).toBe('#5b6373');
    expect(p.appearance).toBe('dark');
    expect(readScenePalette(null).slab).toBe('#151a23');
  });
});
