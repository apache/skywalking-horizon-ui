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
import { alarmPinMatches } from '@skywalking-horizon-ui/api-client';
import type { AlarmMessage } from '@/api/client';
import { alarmOwners, mergeIncidents, splitForList } from './alarmIncidents';

function row(p: Partial<AlarmMessage> & Pick<AlarmMessage, 'startTime'>): AlarmMessage {
  return {
    id: 'cGF5.1',
    scope: 'Service',
    name: 'payments::checkout',
    recoveryTime: null,
    message: 'slow',
    tags: [],
    snapshot: { expression: 'rule-a', metrics: [] },
    layerKeys: ['GENERAL'],
    owners: [{ layer: 'GENERAL', group: 'payments' }],
    layerKey: 'GENERAL',
    ...p,
  };
}

describe('alarm incidents carry the layer-and-group pairs of their latest event', () => {
  it('merges firings into one incident with the latest event\'s owners', () => {
    const [inc] = mergeIncidents([
      row({ startTime: 1, owners: [{ layer: 'GENERAL', group: 'old' }] }),
      row({ startTime: 2 }),
    ]);
    expect(inc!.owners).toEqual([{ layer: 'GENERAL', group: 'payments' }]);
    expect(alarmPinMatches({ layer: 'GENERAL', groups: ['payments'] }, inc!)).toBe(true);
    expect(alarmPinMatches({ layer: 'GENERAL', groups: ['old'] }, inc!)).toBe(false);
  });

  it('keeps them on every list row, firing or recovered', () => {
    const rows = splitForList([row({ startTime: 1 }), row({ startTime: 2, recoveryTime: 3 })]);
    const payments = [{ layer: 'GENERAL', group: 'payments' }];
    expect(rows.map((r) => r.owners)).toEqual([payments, payments]);
  });

  it('reads a row without owners as having none, so it matches no pin with groups', () => {
    const legacy: Partial<AlarmMessage> = row({ startTime: 1 });
    delete legacy.owners;
    expect(alarmOwners(legacy)).toEqual([]);
    const [inc] = mergeIncidents([legacy as AlarmMessage]);
    expect(alarmPinMatches({ layer: 'GENERAL', groups: ['payments'] }, inc!)).toBe(false);
    expect(alarmPinMatches({ layer: 'GENERAL' }, inc!)).toBe(true);
  });
});
