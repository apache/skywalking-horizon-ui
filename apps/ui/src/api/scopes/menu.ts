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

import type { MenuResponse, OapInfo, PreflightResult } from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.menu` — platform meta: sidebar/menu tree, OAP build info,
 *  preflight selectors. */
export class MenuApi {
  constructor(private readonly bff: BffClient) {}

  get(): Promise<MenuResponse> {
    return this.bff.request<MenuResponse>('GET', '/api/menu');
  }
  oapInfo(): Promise<OapInfo> {
    return this.bff.request<OapInfo>('GET', '/api/oap/info');
  }
  preflight(force = false): Promise<PreflightResult> {
    return this.bff.request<PreflightResult>('GET', force ? '/api/preflight?refresh=1' : '/api/preflight');
  }
}
