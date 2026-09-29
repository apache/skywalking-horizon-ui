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
import { chipKeyOf, canonicalPin } from './useAlarmPins';

describe('the chip key a URL names', () => {
  it('canonicalises the layer and keeps the groups as written', () => {
    expect(chipKeyOf('general[Payments, -]')).toBe('GENERAL[Payments, -]');
    expect(chipKeyOf('database')).toBe('VIRTUAL_DATABASE');
    expect(chipKeyOf('other')).toBe('OTHER');
  });

  it('names nothing for an absent or malformed value', () => {
    expect(chipKeyOf(undefined)).toBe('');
    expect(chipKeyOf('')).toBe('');
    expect(chipKeyOf(['GENERAL'])).toBe('');
    expect(chipKeyOf('GENERAL[]')).toBe('');
    expect(chipKeyOf('GENERAL~payments')).toBe('');
  });

  it('reads the ungrouped marker as the empty group', () => {
    expect(canonicalPin('mesh[-]')).toEqual({ layer: 'MESH', groups: [''] });
  });
});
