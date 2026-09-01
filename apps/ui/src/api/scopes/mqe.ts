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

import type { MqeExecRequest, MqeExecResponse } from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.mqe` — run one MQE expression and get OAP's answer untouched.
 *
 *  Distinct from `bff.inspect.exec`: this one takes an epoch-ms window
 *  (the BFF converts to OAP-local time), resolves a blank expression from
 *  the metric catalog, and rides `metrics:read` rather than `inspect:read`. */
export class MqeApi {
  constructor(private readonly bff: BffClient) {}

  exec(req: MqeExecRequest, signal?: AbortSignal): Promise<MqeExecResponse> {
    return this.bff.request<MqeExecResponse>('POST', '/api/mqe/exec', req, undefined, signal);
  }
}
