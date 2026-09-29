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
import { alarmKey, cubeAlarmKey } from './useInfra3dAlarms';

describe('the key an alarm reddens a cube by', () => {
  it('finds a cube of a layer split by service group under the layer alone', () => {
    // An alarm is keyed by the plain layer; the cube by its sidebar entry.
    expect(cubeAlarmKey('general/payments', 'payments::checkout')).toBe(alarmKey('GENERAL', 'payments::checkout'));
    expect(cubeAlarmKey('general', 'payments::checkout')).toBe(alarmKey('GENERAL', 'payments::checkout'));
    expect(cubeAlarmKey('general/payments', 'payments::checkout')).not.toBe(alarmKey('MESH', 'payments::checkout'));
  });
});
