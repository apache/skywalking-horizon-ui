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

import { describe, it, expect } from 'vitest';
import { configSchema, type AiConfig } from '../../config/schema.js';
import {
  buildChatModel,
  resolveCredentials,
  centralCredentialsComplete,
  aiEffectivelyReady,
  AiConfigError,
  type AiCredentials,
} from './model.js';

// Complete bedrock central set (region present but optional).
const AI_BEDROCK: AiConfig = {
  enabled: true,
  provider: 'bedrock',
  model: 'deepseek.v3.2',
  baseUrl: '',
  region: 'us-west-2',
  apiKey: 'secret',
  systemPrompt: '',
  starters: [],
};
const AI_OAI: AiConfig = {
  ...AI_BEDROCK,
  provider: 'openai-compatible',
  region: '',
  baseUrl: 'https://gateway/v1',
};

describe('ai config schema', () => {
  it('defaults to openai-compatible + feature OFF when the block is omitted', () => {
    const cfg = configSchema.parse({});
    expect(cfg.ai).toEqual({
      enabled: false,
      provider: 'openai-compatible',
      model: '',
      baseUrl: '',
      region: '',
      apiKey: '',
      systemPrompt: '',
      starters: [],
    });
  });

  it('rejects a provider outside {openai-compatible, bedrock}', () => {
    expect(() => configSchema.parse({ ai: { provider: 'anthropic' } })).toThrow();
    expect(() => configSchema.parse({ ai: { provider: 'gemini' } })).toThrow();
  });
});

describe('centralCredentialsComplete', () => {
  it('bedrock needs model + apiKey (region is optional — AWS env fallback)', () => {
    expect(centralCredentialsComplete(AI_BEDROCK)).toBe(true);
    expect(centralCredentialsComplete({ ...AI_BEDROCK, region: '' })).toBe(true);
    expect(centralCredentialsComplete({ ...AI_BEDROCK, apiKey: '' })).toBe(false);
    expect(centralCredentialsComplete({ ...AI_BEDROCK, model: '' })).toBe(false);
  });

  it('openai-compatible additionally needs baseUrl', () => {
    expect(centralCredentialsComplete(AI_OAI)).toBe(true);
    expect(centralCredentialsComplete({ ...AI_OAI, baseUrl: '' })).toBe(false);
  });
});

describe('aiEffectivelyReady', () => {
  it('false when disabled', () => {
    expect(aiEffectivelyReady({ ...AI_OAI, enabled: false })).toBe(false);
  });
  it('true from a complete central key', () => {
    expect(aiEffectivelyReady(AI_OAI)).toBe(true);
  });
  it('false when no central key', () => {
    expect(aiEffectivelyReady({ ...AI_OAI, apiKey: '' })).toBe(false);
  });
});

describe('resolveCredentials', () => {
  it('maps the central config, blank optional fields resolve to undefined', () => {
    const bedrock = resolveCredentials(AI_BEDROCK);
    expect(bedrock.model).toBe('deepseek.v3.2');
    expect(bedrock.apiKey).toBe('secret');
    expect(bedrock.region).toBe('us-west-2');
    expect(bedrock.provider).toBe('bedrock');
    const oai = resolveCredentials(AI_OAI);
    expect(oai.region).toBeUndefined();
    expect(oai.baseUrl).toBe('https://gateway/v1');
  });
});

describe('buildChatModel', () => {
  const ok = (over: Partial<AiCredentials>): AiCredentials => ({
    provider: 'openai-compatible',
    model: 'm',
    apiKey: 'k',
    baseUrl: 'https://gateway/v1',
    ...over,
  });

  it('throws AiConfigError on missing required fields', () => {
    expect(() => buildChatModel(ok({ model: '' }))).toThrow(AiConfigError);
    expect(() => buildChatModel(ok({ baseUrl: undefined }))).toThrow(/baseUrl/);
    expect(() => buildChatModel(ok({ apiKey: '' }))).toThrow(/apiKey/);
    expect(() => buildChatModel(ok({ provider: 'bedrock', apiKey: '' }))).toThrow(/apiKey/);
  });

  it('constructs a tool-bindable model for each provider (no network)', () => {
    for (const creds of [
      ok({ provider: 'openai-compatible' }),
      ok({ provider: 'bedrock', region: 'us-west-2' }),
    ]) {
      const model = buildChatModel(creds);
      expect(typeof model.bindTools).toBe('function');
    }
  });

  it('bedrock region falls back to AWS_REGION env, else AiConfigError', () => {
    const prev = process.env.AWS_REGION;
    const prevDef = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      expect(() => buildChatModel(ok({ provider: 'bedrock', region: undefined }))).toThrow(/region/);
      process.env.AWS_REGION = 'us-east-1';
      expect(typeof buildChatModel(ok({ provider: 'bedrock', region: undefined })).bindTools).toBe('function');
    } finally {
      if (prev === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = prev;
      if (prevDef === undefined) delete process.env.AWS_DEFAULT_REGION;
      else process.env.AWS_DEFAULT_REGION = prevDef;
    }
  });
});
