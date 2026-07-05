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

/**
 * Pluggable LLM provider — the ONE place a chat model is constructed. Keeps
 * the agent + tools vendor-neutral: they see a `BaseChatModel` and never know
 * which backend answered. Two providers today: any OpenAI-compatible endpoint
 * (default, via baseUrl) and Amazon Bedrock Converse.
 *
 * Credentials are resolved per request (never module-global) — the Bedrock
 * bearer key is passed to the constructor explicitly rather than via
 * `AWS_BEARER_TOKEN_BEDROCK`, so concurrent requests don't race a shared env.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI } from '@langchain/openai';
import type { AiConfig } from '../../config/schema.js';

export type AiProvider = AiConfig['provider'];

/** Resolved, ready-to-use credentials for ONE chat request, assembled from the
 *  central `config.ai` — the factory only ever sees this normalized shape. */
export interface AiCredentials {
  provider: AiProvider;
  model: string;
  apiKey: string;
  /** OpenAI-compatible base URL (provider='openai-compatible'). */
  baseUrl?: string;
  /** AWS region (provider='bedrock'); optional — falls back to the AWS env. */
  region?: string;
}

/** A provider-config problem the route can turn into a clean 4xx/503 instead
 *  of leaking an SDK stack (missing key/region/baseUrl/model). */
export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

/** True when `config.ai` alone carries a complete central credential set (the
 *  org-key path). Provider-specific: bedrock can take `region` from AWS
 *  env/config; openai-compatible also needs `baseUrl`; all need `model` +
 *  `apiKey`. */
export function centralCredentialsComplete(ai: AiConfig): boolean {
  if (!ai.model || !ai.apiKey) return false;
  // Bedrock resolves its region from the AWS env when `ai.region` is blank, so
  // model + bearer key is a complete central set; openai-compatible needs baseUrl.
  if (ai.provider === 'bedrock') return true;
  return ai.baseUrl !== '';
}

/** The launcher-gating readiness signal exposed on bootstrap: the feature is
 *  enabled AND a request can be served from a complete CENTRAL credential set. */
export function aiEffectivelyReady(ai: AiConfig): boolean {
  return ai.enabled && centralCredentialsComplete(ai);
}

/** The resolved credential set for a chat request, taken from the central
 *  `config.ai`. */
export function resolveCredentials(ai: AiConfig): AiCredentials {
  return {
    provider: ai.provider,
    model: ai.model,
    apiKey: ai.apiKey,
    baseUrl: ai.baseUrl || undefined,
    region: ai.region || undefined,
  };
}

/** Construct the streaming chat model for the resolved credentials. Streaming
 *  is always on (the SSE route consumes token deltas); temperature is fixed at
 *  0 for tool-calling determinism. Output-token caps are left to the gateway /
 *  provider. Throws `AiConfigError` on any missing provider-required field. */
export function buildChatModel(creds: AiCredentials): BaseChatModel {
  const { provider, model, apiKey } = creds;
  if (!model) throw new AiConfigError('ai.model is not set');

  if (provider === 'bedrock') {
    if (!apiKey) throw new AiConfigError('ai.apiKey (Bedrock bearer key) is required');
    // Region: pinned in config, else the standard AWS env. Resolve it here so a
    // missing region is a clean AiConfigError (→ 503), not the SDK's opaque throw.
    const region = creds.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new AiConfigError('ai.region (or AWS_REGION env) is required for the bedrock provider');
    }
    return new ChatBedrockConverse({
      model,
      region,
      // ABSK bearer key passed explicitly — no AWS_BEARER_TOKEN_BEDROCK env
      // mutation, so concurrent requests stay isolated.
      bedrockBearerToken: apiKey,
      temperature: 0,
      streaming: true,
    });
  }

  // openai-compatible (default)
  if (!creds.baseUrl) {
    throw new AiConfigError('ai.baseUrl is required for the openai-compatible provider');
  }
  if (!apiKey) throw new AiConfigError('ai.apiKey is required for the openai-compatible provider');
  return new ChatOpenAI({
    model,
    apiKey,
    temperature: 0,
    streaming: true,
    configuration: { baseURL: creds.baseUrl },
    // Routing hint for OpenAI-compatible prompt caching: a stable key keeps our
    // shared static prefix (system prompt + tool schemas) on the same cache pool
    // across requests. Caching itself is automatic server-side (OpenAI /
    // DeepSeek API); this just improves the hit rate. No-op on endpoints that
    // ignore it.
    promptCacheKey: 'skywalking-horizon-ai',
  });
}
