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
  ActiveSessionsResponse,
  SessionReadOptions,
  SessionResponse,
  StartSessionArgs,
  StartSessionResponse,
  StopSessionResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient, ClusterDebugStatus } from '../client';
import { BffApiError } from '../client';

/** `bff.liveDebug` — SWIP-13 `/dsl-debugging/*` proxies: start / poll /
 *  stop a session, list active sessions, per-node status fan-out. */
export class LiveDebugApi {
  constructor(private readonly bff: BffClient) {}

  start(args: StartSessionArgs): Promise<StartSessionResponse> {
    return this.bff.request<StartSessionResponse>('POST', '/api/debug/session', args);
  }

  /** Returns `null` when the session id has been collected or expired.
   *  With `capturedSince`, only the records captured at or after it. */
  async session(id: string, options: SessionReadOptions = {}): Promise<SessionResponse | null> {
    const params = new URLSearchParams();
    if (options.capturedSince) params.set('capturedSince', options.capturedSince);
    if (options.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
    const query = params.toString();
    try {
      return await this.bff.request<SessionResponse>(
        'GET',
        `/api/debug/session/${encodeURIComponent(id)}${query ? `?${query}` : ''}`,
      );
    } catch (err) {
      if (err instanceof BffApiError && err.status === 404) return null;
      throw err;
    }
  }

  stop(id: string): Promise<StopSessionResponse> {
    return this.bff.request<StopSessionResponse>(
      'POST',
      `/api/debug/session/${encodeURIComponent(id)}/stop`,
    );
  }

  sessions(): Promise<ActiveSessionsResponse> {
    return this.bff.request<ActiveSessionsResponse>('GET', '/api/debug/sessions');
  }

  status(): Promise<ClusterDebugStatus> {
    return this.bff.request<ClusterDebugStatus>('GET', '/api/debug/status');
  }
}
