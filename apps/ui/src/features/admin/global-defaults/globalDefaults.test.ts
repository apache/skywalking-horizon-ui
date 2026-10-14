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

import { describe, expect, it } from 'vitest';
import { MAX_DEFAULT_WINDOW_MINUTES, planGlobalDefaultsSave, windowMinutesProblem } from './globalDefaults';

describe('windowMinutesProblem', () => {
  it('accepts whole minutes from 1 to 31 days', () => {
    expect(windowMinutesProblem(1)).toBeNull();
    expect(windowMinutesProblem(60)).toBeNull();
    expect(windowMinutesProblem(MAX_DEFAULT_WINDOW_MINUTES)).toBeNull();
  });

  it('refuses a cleared input, a non-number and anything out of range', () => {
    for (const v of ['', '15', null, undefined, Number.NaN, 0, -5, MAX_DEFAULT_WINDOW_MINUTES + 1, Infinity]) {
      expect(windowMinutesProblem(v)).toBe('range');
    }
  });

  it('refuses a fraction', () => {
    expect(windowMinutesProblem(1.5)).toBe('whole');
  });
});

describe('planGlobalDefaultsSave', () => {
  const isTheme = (id: string) => ['horizon', 'meridian'].includes(id);
  const orig = { themeId: 'horizon', minutes: 60 };

  it('writes only the sections that changed', () => {
    expect(planGlobalDefaultsSave({ themeId: 'meridian', minutes: 60 }, orig, isTheme)).toEqual({ themeId: 'meridian' });
    expect(planGlobalDefaultsSave({ themeId: 'horizon', minutes: 15 }, orig, isTheme)).toEqual({ minutes: 15 });
    expect(planGlobalDefaultsSave({ themeId: 'meridian', minutes: 15 }, orig, isTheme)).toEqual({ themeId: 'meridian', minutes: 15 });
    expect(planGlobalDefaultsSave(orig, orig, isTheme)).toEqual({});
  });

  it('writes neither section when the minutes are invalid, even with a new theme', () => {
    expect(planGlobalDefaultsSave({ themeId: 'meridian', minutes: '' }, orig, isTheme)).toBeNull();
    expect(planGlobalDefaultsSave({ themeId: 'meridian', minutes: 2.5 }, orig, isTheme)).toBeNull();
  });

  it('writes neither section when the theme is unknown', () => {
    expect(planGlobalDefaultsSave({ themeId: 'nope', minutes: 15 }, orig, isTheme)).toBeNull();
  });
});
