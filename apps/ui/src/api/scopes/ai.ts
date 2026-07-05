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

// AI assistant façade. The chat STREAM is not a normal JSON request, so it lives
// in `ai/aiStream.ts` (owns its own fetch + SSE parse); this scope carries only
// the non-streaming `config` probe the launcher gates + seeds starters from.

import type { BffClient } from '../client';

export interface AiConfigResponse {
  enabled: boolean;
  /** Feature is on AND serviceable (a complete central credential set). */
  ready: boolean;
  provider: string;
  /** Starter prompts (bundled defaults or the operator's `ai.starters`). */
  starters: string[];
}

export class AiApi {
  constructor(private readonly bff: BffClient) {}

  config(): Promise<AiConfigResponse> {
    return this.bff.request<AiConfigResponse>('GET', '/api/ai/config');
  }
}
