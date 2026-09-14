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
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { buildSidebarEntries } from './sidebarEntries';

function layer(key: string, name: string, group?: string): LayerDef {
  return {
    key,
    name,
    group,
    color: '#fff',
    serviceCount: 1,
    active: true,
    level: null,
    slots: {},
    caps: { dashboards: true },
  };
}

describe('buildSidebarEntries', () => {
  it('places singleton groups beside standalone layers and keeps multiple layers grouped', () => {
    const mq = layer('ACTIVEMQ', 'ActiveMQ', 'MQ');
    const ai = layer('AI_AGENT', 'AI Agents');
    const browser = layer('BROWSER', 'Browser');
    const mysql = layer('MYSQL', 'MySQL / MariaDB', 'Databases');
    const postgres = layer('POSTGRESQL', 'PostgreSQL', 'Databases');

    expect(buildSidebarEntries([mq, ai, browser, mysql, postgres])).toEqual([
      { kind: 'single', layer: mq },
      { kind: 'single', layer: ai },
      { kind: 'single', layer: browser },
      { kind: 'group', label: 'Databases', layers: [mysql, postgres] },
    ]);
  });

  it('collects nonadjacent group members at the first member position', () => {
    const browser = layer('BROWSER', 'Browser');
    const mq = layer('ACTIVEMQ', 'ActiveMQ', 'MQ');
    const ai = layer('AI_AGENT', 'AI Agents');
    const mysql = layer('MYSQL', 'MySQL / MariaDB', 'Databases');
    const kafka = layer('KAFKA', 'Kafka', 'MQ');
    const postgres = layer('POSTGRESQL', 'PostgreSQL', 'Databases');

    expect(buildSidebarEntries([browser, mq, ai, mysql, kafka, postgres])).toEqual([
      { kind: 'single', layer: browser },
      { kind: 'group', label: 'MQ', layers: [mq, kafka] },
      { kind: 'single', layer: ai },
      { kind: 'group', label: 'Databases', layers: [mysql, postgres] },
    ]);
  });

  it('rebuilds the hierarchy as visible membership changes without mutating input or previous results', () => {
    const mq = Object.freeze(layer('ACTIVEMQ', 'ActiveMQ', 'MQ'));
    const kafka = Object.freeze(layer('KAFKA', 'Kafka', 'MQ'));
    const ai = Object.freeze(layer('AI_AGENT', 'AI Agents'));
    const oneMember = Object.freeze([mq, ai]);
    const twoMembers = Object.freeze([mq, ai, kafka]);

    const initial = buildSidebarEntries(oneMember);
    const expanded = buildSidebarEntries(twoMembers);
    const reduced = buildSidebarEntries(oneMember);

    expect(initial).toEqual([
      { kind: 'single', layer: mq },
      { kind: 'single', layer: ai },
    ]);
    expect(expanded).toEqual([
      { kind: 'group', label: 'MQ', layers: [mq, kafka] },
      { kind: 'single', layer: ai },
    ]);
    expect(reduced).toEqual(initial);
    expect(mq.group).toBe('MQ');
    expect(kafka.group).toBe('MQ');
    expect(oneMember).toEqual([mq, ai]);
    expect(twoMembers).toEqual([mq, ai, kafka]);
  });

  it('treats absent and empty group labels as standalone layers', () => {
    const ai = layer('AI_AGENT', 'AI Agents');
    const browser = layer('BROWSER', 'Browser', '');

    expect(buildSidebarEntries([ai, browser])).toEqual([
      { kind: 'single', layer: ai },
      { kind: 'single', layer: browser },
    ]);
    expect(buildSidebarEntries([])).toEqual([]);
  });
});
