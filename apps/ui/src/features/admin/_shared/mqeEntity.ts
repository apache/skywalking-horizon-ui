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

import type { MqeEntity } from '@skywalking-horizon-ui/api-client';
import type { PickedEntity } from './MqeEntityPicker.vue';

/**
 * How a template field's expression is really evaluated when the product runs
 * it. The set is fixed by the editor's own sections, not by anything the
 * operator types.
 *
 * `*-relation` sites are queried with the entity's `scope` OMITTED — OAP
 * senses it from the metric name, and forcing it empties the result on some
 * versions — so they carry a destination side as well as a source.
 */
export type MqeSiteScope =
  | 'service'
  | 'instance'
  | 'endpoint'
  | 'service-relation'
  | 'instance-relation'
  | 'endpoint-relation'
  | 'process-relation'
  /** ServiceInstanceRelation confined to ONE service — the deployment graph is
   *  intra-service, so both sides share a service name and only the instances
   *  differ. Offering two free service pickers there would build an entity that
   *  graph never produces. */
  | 'deployment-relation';

/**
 * Which scopes name two entities rather than one.
 *
 * Spelled out per member rather than inferred from the name: a `Record` keyed
 * by the union is exhaustive, so adding a scope without deciding this fails to
 * compile — where a suffix test would silently guess for it.
 */
const IS_RELATION: Record<MqeSiteScope, boolean> = {
  service: false,
  instance: false,
  endpoint: false,
  'service-relation': true,
  'instance-relation': true,
  'endpoint-relation': true,
  'process-relation': true,
  'deployment-relation': true,
};

export function isRelationScope(scope: MqeSiteScope): boolean {
  return IS_RELATION[scope];
}

/** Build the exact GraphQL Entity used by the run panel. Kept pure so every
 *  scope — especially ProcessRelation's full source/destination tuple — can
 *  be regression-tested without mounting roster queries and a teleported UI. */
export function buildMqeEntity(
  siteScope: MqeSiteScope,
  source: PickedEntity,
  dest: PickedEntity | null,
): MqeEntity {
  const relation = isRelationScope(siteScope);
  const wireScope = relation
    ? undefined
    : siteScope === 'instance'
      ? 'ServiceInstance'
      : siteScope === 'endpoint'
        ? 'Endpoint'
        : 'Service';

  // A layer-wide pick sends NO service name. top_n(...) ranks across the
  // layer, and naming one service makes OAP reject rather than narrow it.
  const entity: MqeEntity = source.serviceName
    ? { serviceName: source.serviceName, normal: source.normal }
    : { normal: true };
  if (wireScope) entity.scope = wireScope;
  if (source.instanceName) entity.serviceInstanceName = source.instanceName;
  if (source.endpointName) entity.endpointName = source.endpointName;
  if (source.processName) entity.processName = source.processName;

  if (!relation || !dest) return entity;
  const crossService = siteScope !== 'deployment-relation';
  const destName = crossService ? dest.serviceName : source.serviceName;
  if (destName) {
    entity.destServiceName = destName;
    entity.destNormal = crossService ? dest.normal : source.normal;
  }
  if (dest.instanceName) entity.destServiceInstanceName = dest.instanceName;
  if (dest.endpointName) entity.destEndpointName = dest.endpointName;
  if (dest.processName) entity.destProcessName = dest.processName;
  return entity;
}
