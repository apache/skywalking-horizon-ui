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

/** Shared Inspect types + scope helpers used by the board view and the
 *  catalog drawer. */
import type { InspectForeignValueType, InspectScope } from '@skywalking-horizon-ui/api-client';

export type Source = 'OAL' | 'MAL·OTEL' | 'MAL·Telegraf' | 'LAL→MAL' | 'unknown';

export const INSPECT_SOURCES: Source[] = ['OAL', 'MAL·OTEL', 'MAL·Telegraf', 'LAL→MAL', 'unknown'];

/** Scopes the foreign /inspect/entities path accepts (mirrors OAP's
 *  isSupportedScope). Process / All are out of scope on the OAP side. */
export const FOREIGN_SCOPES: InspectScope[] = [
  'Service',
  'ServiceInstance',
  'Endpoint',
  'ServiceRelation',
  'ServiceInstanceRelation',
  'EndpointRelation',
];

/** A foreign-metric spec the operator typed by hand (it isn't in OAP's
 *  catalog). Carries everything `/inspect/entities` + `/inspect/values`
 *  need to enumerate and read the metric from shared storage. */
export interface ForeignForm {
  name: string;
  scope: InspectScope;
  valueColumn: string;
  valueType: InspectForeignValueType;
}

export function scopeShort(scope: InspectScope): string {
  switch (scope) {
    case 'ServiceInstance': return 'Instance';
    case 'ServiceRelation': return 'Svc→Svc';
    case 'ServiceInstanceRelation': return 'Instance→Instance';
    case 'EndpointRelation': return 'Endpoint→Endpoint';
    default: return scope;
  }
}
