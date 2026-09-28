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
import { instanceNodeFragment, nodeFragment, relationFragment } from './topology-mqe.js';

const w = { start: '2026-09-28 1000', end: '2026-09-28 1015', step: 'MINUTE' as const };
const m = { id: 'cpm', label: 'Load', mqe: 'top_n(service_cpm,5,des)' };

describe('graph MQE entities', () => {
  it('name the blank service `_blank`, as OAP keys it, never as an empty name that reads every service', () => {
    for (const q of [
      nodeFragment('a', m, '', true, w, false),
      instanceNodeFragment('a', m, '', 'pod-1', true, w, false),
      relationFragment('a', m, '', true, '', true, w, false),
    ]) {
      expect(q).toContain('serviceName: "_blank"');
      expect(q).not.toContain('serviceName: ""');
    }
    expect(nodeFragment('a', m, 'payments::a', true, w, false)).toContain('serviceName: "payments::a"');
  });
});
