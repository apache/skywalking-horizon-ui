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

/**
 * Process-relation edge metrics. A metric SAYS which end of the conversation
 * it describes, because not every one has an end — the HTTP/1.x families
 * describe the exchange — and because reading the side off the metric's name
 * cannot express that, nor survive a rename.
 */

import { describe, expect, it } from 'vitest';
import { resolveEdgeMetrics } from './topology.js';

const m = (id: string, mqe: string) => ({ id, label: id, mqe, aggregation: 'avg' as const });

describe('edge metrics', () => {
  it('reads a template that still spells the sides as two lists', () => {
    // Stored templates written before the one list, resolved rather than
    // migrated — the editor writes the new spelling on the first edit.
    expect(resolveEdgeMetrics({
      edgeClientMetrics: [m('write', 'process_relation_client_write_cpm')],
      edgeServerMetrics: [m('read', 'process_relation_server_read_cpm')],
    })).toEqual([
      { ...m('write', 'process_relation_client_write_cpm'), side: 'client' },
      { ...m('read', 'process_relation_server_read_cpm'), side: 'server' },
    ]);
  });

  it('keeps a metric that belongs to neither side', () => {
    const http1 = m('http1_request_cpm', 'process_relation_http1_request_cpm');
    expect(resolveEdgeMetrics({ edgeMetrics: [http1] })).toEqual([http1]);
  });

  it('prefers the one list when a template carries both spellings', () => {
    const one = { ...m('a', 'x'), side: 'client' as const };
    expect(resolveEdgeMetrics({
      edgeMetrics: [one],
      edgeClientMetrics: [m('stale', 'y')],
    })).toEqual([one]);
  });

  it('takes an empty list as "this layer has none"', () => {
    // Deleting the last metric must not revive the older side lists: the
    // editor would read empty while the page went on querying them.
    expect(resolveEdgeMetrics({
      edgeMetrics: [],
      edgeClientMetrics: [m('write', 'process_relation_client_write_cpm')],
    })).toEqual([]);
  });

  it('answers empty for a layer that declares none', () => {
    // There is no built-in set to fall back on: a panel showing metrics no
    // template named is one the editor cannot show, which is how the two
    // drifted apart.
    expect(resolveEdgeMetrics({})).toEqual([]);
    expect(resolveEdgeMetrics(null)).toEqual([]);
  });
});
