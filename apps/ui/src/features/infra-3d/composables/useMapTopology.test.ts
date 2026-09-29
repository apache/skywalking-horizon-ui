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
import { buildSceneGraph, type MapLayer, type MapTopology } from './useMapTopology';

const layer = (key: string): MapLayer => ({ key, name: key, level: null, group: null, serviceCount: 1, color: null });
const svc = (id: string) => ({ id, name: id, normal: true });
const peer = (layerName: string, id: string) => ({ layer: layerName, services: [{ ...svc(id), role: 'lower' }] });

function topo(layers: MapLayer[], services: Record<string, string[]>, hierarchy: MapTopology['hierarchy']): MapTopology {
  return {
    capturedAt: '',
    source: 'test',
    layers,
    servicesByLayer: Object.fromEntries(Object.entries(services).map(([k, ids]) => [k, ids.map(svc)])),
    hierarchy,
    topologies: {},
  };
}

// OAP names a hierarchy peer by its layer; on a layer split by service group
// the peer's cube sits under its group's entry.
describe('buildSceneGraph hierarchy tubes', () => {
  it('join services on two split layers through their group entries', () => {
    const g = buildSceneGraph(
      topo(
        [layer('general/payments'), layer('general/'), layer('k8s_service/payments')],
        { 'general/payments': ['pay'], 'general/': ['audit'], 'k8s_service/payments': ['pay-k8s'] },
        [{ fromLayer: 'general/payments', fromService: svc('pay'), peers: [peer('K8S_SERVICE', 'pay-k8s')] }],
      ),
    );
    expect(g.hierarchyEdges).toEqual([{ fromNodeId: 'GENERAL/PAYMENTS::pay', toNodeId: 'K8S_SERVICE/PAYMENTS::pay-k8s' }]);
  });

  it('draw none between two entries of the same layer', () => {
    const g = buildSceneGraph(
      topo(
        [layer('general/payments'), layer('general/')],
        { 'general/payments': ['pay'], 'general/': ['audit'] },
        [{ fromLayer: 'general/payments', fromService: svc('pay'), peers: [peer('GENERAL', 'audit')] }],
      ),
    );
    expect(g.hierarchyEdges).toEqual([]);
  });
});
