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
 * Inspect — foreign-metric helpers. A foreign metric is one the connected OAP
 * doesn't define (another OAP wrote it to shared storage); the operator
 * supplies its scope + value column/type by hand. These pure functions
 * synthesize the catalog-entry shell and rebuild the re-queryable MQE entity
 * the value path needs.
 */
import type {
  InspectForeignValueType,
  InspectScope,
  MqeEntity,
} from '@skywalking-horizon-ui/api-client';
import type { InspectCatalogEntry } from '@/api/client';

/** Synthesize a catalog-entry shell for a foreign metric the operator typed
 *  by hand (it isn't in OAP's catalog). Only `name` + `scope` +
 *  `valueColumnName` are load-bearing downstream; the rest is filler so the
 *  widget code can treat foreign and catalog metrics uniformly. */
export function makeForeignMetric(
  name: string,
  scope: InspectScope,
  valueColumn: string,
  valueType: InspectForeignValueType,
): InspectCatalogEntry {
  return {
    name,
    type: valueType === 'LABELED' ? 'LABELED_VALUE' : 'REGULAR_VALUE',
    catalog: '',
    scopeId: 0,
    scope,
    valueColumnName: valueColumn,
    downsamplings: ['MINUTE', 'HOUR', 'DAY'],
    attribution: { source: 'unknown', file: null },
  };
}

/** Reconstruct a re-queryable MQE entity for a FOREIGN row. The foreign
 *  `/inspect/entities` path returns `scope:null` and no `mqeEntity` (the metric
 *  isn't defined here), only structurally-decoded names — so we rebuild the
 *  entity from the operator-chosen scope plus those names. `isReal` defaults to
 *  true; the 2nd-level decode emits a generic `name` leaf (instance vs endpoint
 *  is byte-identical), which the scope disambiguates. */
export function buildForeignMqeEntity(decoded: Record<string, unknown>, scope: InspectScope): MqeEntity {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const real = (v: unknown): boolean => v !== false;
  const side = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const e: MqeEntity = { scope };
  switch (scope) {
    case 'Service':
      e.serviceName = str(decoded.serviceName);
      e.normal = real(decoded.isReal);
      break;
    case 'ServiceInstance':
      e.serviceName = str(decoded.serviceName);
      e.normal = real(decoded.isReal);
      e.serviceInstanceName = str(decoded.name) ?? str(decoded.serviceInstanceName);
      break;
    case 'Endpoint':
      e.serviceName = str(decoded.serviceName);
      e.normal = real(decoded.isReal);
      e.endpointName = str(decoded.name) ?? str(decoded.endpointName);
      break;
    case 'ServiceRelation': {
      const s = side(decoded.source);
      const d = side(decoded.destination);
      e.serviceName = str(s.serviceName);
      e.normal = real(s.isReal);
      e.destServiceName = str(d.serviceName);
      e.destNormal = real(d.isReal);
      break;
    }
    case 'ServiceInstanceRelation': {
      const s = side(decoded.source);
      const d = side(decoded.destination);
      e.serviceName = str(s.serviceName);
      e.normal = real(s.isReal);
      e.serviceInstanceName = str(s.name);
      e.destServiceName = str(d.serviceName);
      e.destNormal = real(d.isReal);
      e.destServiceInstanceName = str(d.name);
      break;
    }
    case 'EndpointRelation': {
      const s = side(decoded.source);
      const d = side(decoded.destination);
      e.serviceName = str(s.serviceName);
      e.normal = real(s.isReal);
      e.endpointName = str(s.name);
      e.destServiceName = str(d.serviceName);
      e.destNormal = real(d.isReal);
      e.destEndpointName = str(d.name);
      break;
    }
  }
  return e;
}
