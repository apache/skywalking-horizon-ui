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

import type {
  EntitiesResponse,
  ExpressionResult,
  InspectExecRequest,
  InspectStep,
} from '@skywalking-horizon-ui/api-client';
import type {
  BffClient,
  InspectCatalogResponse,
  InspectServerTimeResponse,
} from '../client';

/** `bff.inspect` — SWIP-14 metric-catalog browse + ad-hoc MQE exec. */
export class InspectApi {
  constructor(private readonly bff: BffClient) {}

  catalog(refresh = false): Promise<InspectCatalogResponse> {
    const path = refresh ? '/api/inspect/catalog?refresh=true' : '/api/inspect/catalog';
    return this.bff.request<InspectCatalogResponse>('GET', path);
  }

  entities(args: {
    metric: string;
    start: string;
    end: string;
    step: InspectStep;
    limit?: number;
  }): Promise<EntitiesResponse> {
    const params = new URLSearchParams({
      metric: args.metric,
      start: args.start,
      end: args.end,
      step: args.step,
    });
    if (args.limit !== undefined) params.set('limit', String(args.limit));
    return this.bff.request<EntitiesResponse>(
      'GET',
      `/api/inspect/entities?${params.toString()}`,
    );
  }

  exec(req: InspectExecRequest): Promise<ExpressionResult> {
    return this.bff.request<ExpressionResult>('POST', '/api/inspect/exec', req);
  }

  serverTime(refresh = false): Promise<InspectServerTimeResponse> {
    const path = refresh ? '/api/inspect/server-time?refresh=true' : '/api/inspect/server-time';
    return this.bff.request<InspectServerTimeResponse>('GET', path);
  }
}
