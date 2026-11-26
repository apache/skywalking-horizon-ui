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

import type { PairingCaptureResponse, PairingsResponse } from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.otlpPairing` — OAP `/trace-pairing-debugging/*` proxies: start and stop the shared pairing capture, and
 *  read what it found. A read keeps the capture running. */
export class OtlpPairingApi {
  constructor(private readonly bff: BffClient) {}

  start(): Promise<PairingCaptureResponse> {
    return this.bff.request<PairingCaptureResponse>('POST', '/api/otlp-pairing/start');
  }

  stop(): Promise<PairingCaptureResponse> {
    return this.bff.request<PairingCaptureResponse>('POST', '/api/otlp-pairing/stop');
  }

  /** A read; `signal` cancels it, as when the page leaves. */
  pairings(limit?: number, signal?: AbortSignal): Promise<PairingsResponse> {
    const qs = limit === undefined ? '' : `?limit=${limit}`;
    return this.bff.request<PairingsResponse>('GET', `/api/otlp-pairing/pairings${qs}`, undefined, undefined, signal);
  }
}
