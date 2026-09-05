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
import { buildMqeEntity } from './mqeEntity';

describe('buildMqeEntity', () => {
  it('builds both complete ProcessRelation endpoints and omits scope', () => {
    const entity = buildMqeEntity(
      'process-relation',
      { serviceName: 'frontend', normal: true, instanceName: 'frontend-1', processName: 'nginx' },
      { serviceName: 'orders', normal: false, instanceName: 'orders-1', processName: 'java' },
    );
    expect(entity).toEqual({
      serviceName: 'frontend',
      normal: true,
      serviceInstanceName: 'frontend-1',
      processName: 'nginx',
      destServiceName: 'orders',
      destNormal: false,
      destServiceInstanceName: 'orders-1',
      destProcessName: 'java',
    });
    expect('scope' in entity).toBe(false);
  });

  it('uses an explicit scope for a single instance', () => {
    expect(buildMqeEntity(
      'instance',
      { serviceName: 'frontend', normal: true, instanceName: 'frontend-1' },
      null,
    )).toMatchObject({ scope: 'ServiceInstance', serviceInstanceName: 'frontend-1' });
  });

  it('keeps deployment relations inside the source service', () => {
    expect(buildMqeEntity(
      'deployment-relation',
      { serviceName: 'banyandb', normal: true, instanceName: 'liaison-1' },
      { serviceName: 'wrong-peer', normal: false, instanceName: 'data-1' },
    )).toMatchObject({ destServiceName: 'banyandb', destNormal: true, destServiceInstanceName: 'data-1' });
  });
});
