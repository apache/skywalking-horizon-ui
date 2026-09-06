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
import { windowMinutesOf } from './instance.js';

describe('windowMinutesOf', () => {
  it('keeps the recent default when the caller says nothing, or nonsense', () => {
    expect(windowMinutesOf(undefined)).toBe(60);
    expect(windowMinutesOf('')).toBe(60);
    expect(windowMinutesOf('soon')).toBe(60);
    expect(windowMinutesOf('-5')).toBe(60);
  });

  it('honours a window of days and caps it at 90 days', () => {
    expect(windowMinutesOf('10080')).toBe(10080);
    expect(windowMinutesOf('129600')).toBe(129600);
    expect(windowMinutesOf('999999')).toBe(129600);
    expect(windowMinutesOf('61.9')).toBe(61);
  });
});
