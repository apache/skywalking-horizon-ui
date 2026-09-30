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
import { alarmPinMatches, formatAlarmPin, parseAlarmPin } from './alarm-pages.js';

describe('alarm pins', () => {
  it('reads a pin the way a grant qualifies a verb', () => {
    expect(parseAlarmPin('general')).toEqual({ layer: 'GENERAL' });
    expect(parseAlarmPin('GENERAL[payments, -]')).toEqual({ layer: 'GENERAL', groups: ['payments', ''] });
    expect(parseAlarmPin('GENERAL[Payments]')?.groups).toEqual(['Payments']);
    for (const bad of ['', 'GENERAL[]', 'GENERAL[a,,b]', 'GENERAL[a]x', 'GENERAL~a', 'GEN ERAL']) {
      expect(parseAlarmPin(bad)).toBeNull();
    }
    expect(formatAlarmPin({ layer: 'GENERAL', groups: ['payments', ''] })).toBe('GENERAL[payments, -]');
    expect(formatAlarmPin({ layer: 'MESH' })).toBe('MESH');
  });

  it('counts a whole-layer pin by layer, and a group pin by the services the alarm concerns', () => {
    const row = {
      layerKeys: ['GENERAL', 'MESH'],
      owners: [
        { layer: 'GENERAL', group: 'payments' },
        { layer: 'MESH', group: 'risk' },
      ],
    };
    expect(alarmPinMatches({ layer: 'GENERAL' }, row)).toBe(true);
    expect(alarmPinMatches({ layer: 'GENERAL', groups: ['payments'] }, row)).toBe(true);
    // The pair decides: payments is in GENERAL, not in MESH.
    expect(alarmPinMatches({ layer: 'MESH', groups: ['payments'] }, row)).toBe(false);
    expect(alarmPinMatches({ layer: 'GENERAL', groups: [''] }, { layerKeys: ['GENERAL'], owners: [{ layer: 'GENERAL', group: '' }] })).toBe(true);
    expect(alarmPinMatches({ layer: 'GENERAL', groups: ['payments'] }, { layerKeys: ['GENERAL'] })).toBe(false);
  });
});
