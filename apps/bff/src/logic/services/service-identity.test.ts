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
import { entityServiceName, serviceIdOf, serviceIdOfChild } from './service-identity.js';

describe('service identity', () => {
  it('names the blank service as OAP keys its data, not as an empty entity', () => {
    expect(entityServiceName('')).toBe('_blank');
    expect(entityServiceName('  ')).toBe('_blank');
    expect(entityServiceName('\u0000\t')).toBe('_blank');
    expect(entityServiceName('payments::a')).toBe('payments::a');
    // Java's trim() keeps U+00A0, so OAP files that name under its own id.
    expect(entityServiceName('\u00a0')).toBe('\u00a0');
  });

  it('files a blank name under `_blank`, as OAP builds the id', () => {
    expect(serviceIdOf('', true)).toBe(serviceIdOf('_blank', true));
    expect(serviceIdOf(' \t', false)).toBe(serviceIdOf('_blank', false));
    expect(serviceIdOf('\u00a0', true)).not.toBe(serviceIdOf('_blank', true));
  });

  it('finds the owning service in an instance or endpoint id', () => {
    const svc = serviceIdOf('payments::a', true);
    expect(serviceIdOfChild(`${svc}_${Buffer.from('i-1').toString('base64')}`)).toBe(svc);
    expect(serviceIdOfChild('no-owner')).toBeNull();
  });
});
