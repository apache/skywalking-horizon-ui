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
  AiConversationsQueryRequest,
  AiConversationsResponse,
} from '@skywalking-horizon-ui/api-client';
import type { BffClient } from '../client';

/** `bff.aiConversation` — the AI agent conversations of an `AI_AGENT` layer
 *  service, one row per conversation. The conversation document itself is
 *  read by the conversation page, not through this scope: it is a streamed
 *  relay of tens of megabytes, which the JSON façade is not built for. */
export class AiConversationApi {
  constructor(private readonly bff: BffClient) {}

  list(
    layerKey: string,
    body: AiConversationsQueryRequest,
    signal?: AbortSignal,
  ): Promise<AiConversationsResponse> {
    return this.bff.request<AiConversationsResponse>(
      'POST',
      `/api/layer/${encodeURIComponent(layerKey)}/ai-conversations`,
      body,
      undefined,
      signal,
    );
  }
}
