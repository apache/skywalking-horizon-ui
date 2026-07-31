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
  EvaluationRecordFacetsResponse,
  EvaluationRecordsResponse,
  LogTagFilter,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

export interface EvaluationRecordQueryRequest {
  service?: string;
  serviceId?: string | null;
  serviceInstanceId?: string | null;
  endpointId?: string | null;
  traceId?: string | null;
  tags?: LogTagFilter[];
  page?: number;
  pageSize?: number;
  windowMinutes?: number;
  startTime?: string;
  endTime?: string;
}

export class EvaluationRecordApi {
  constructor(private readonly bff: BffClient) {}

  list(layerKey: string, body: EvaluationRecordQueryRequest = {}): Promise<EvaluationRecordsResponse> {
    return this.bff.request<EvaluationRecordsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/evaluation-records`,
      body,
    );
  }

  facets(
    layerKey: string,
    body: EvaluationRecordQueryRequest & { sampleSize?: number } = {},
  ): Promise<EvaluationRecordFacetsResponse> {
    return this.bff.request<EvaluationRecordFacetsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/evaluation-records/facets`,
      body,
    );
  }
}
