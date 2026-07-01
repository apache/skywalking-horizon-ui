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

import type { BffClient } from '../client';
import type { EventsQueryRequest, EventsResponse } from '@skywalking-horizon-ui/api-client';

/**
 * Per-service events feed — OAP `queryEvents`. One `query` call returns the raw
 * newest-first event stream for a window + layer/service filters; the popout
 * lays them out as an instance × time swimlane.
 */
export class EventsApi {
  constructor(private readonly bff: BffClient) {}

  query(body: EventsQueryRequest = {}): Promise<EventsResponse> {
    return this.bff.request<EventsResponse>('POST', '/api/events', body);
  }
}
