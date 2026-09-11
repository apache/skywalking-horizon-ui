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

import { describe, expect, it } from 'vitest';
import { genAIContextOfNativeSpan, genAIContextOfZipkinSpan } from './genaiSpan';

describe('genaiSpan — the spans OAP judges', () => {
  it('takes a native span only when its layer is GenAI AND it names the response model', () => {
    const tags = [{ key: 'gen_ai.response.model', value: 'gpt-4.1-mini' }, { key: 'gen_ai.provider.name', value: 'openai' }];
    expect(genAIContextOfNativeSpan({ layer: 'GenAI', tags })).toEqual({ model: 'gpt-4.1-mini', provider: 'openai' });
    expect(genAIContextOfNativeSpan({ layer: 'Http', tags })).toBeNull();
    expect(genAIContextOfNativeSpan({ layer: 'GenAI', tags: [{ key: 'gen_ai.response.model', value: ' ' }] })).toBeNull();
    expect(genAIContextOfNativeSpan({ layer: 'GenAI', tags: [] })).toBeNull();
  });

  it('takes a Zipkin/OTLP span on the model tag alone, and falls back to gen_ai.system for the provider', () => {
    expect(genAIContextOfZipkinSpan({ tags: { 'gen_ai.response.model': 'gpt-4.1-mini', 'gen_ai.system': 'openai' } }))
      .toEqual({ model: 'gpt-4.1-mini', provider: 'openai' });
    expect(genAIContextOfZipkinSpan({ tags: { 'gen_ai.response.model': 'm', 'gen_ai.provider.name': 'p', 'gen_ai.system': 's' } }))
      .toEqual({ model: 'm', provider: 'p' });
    expect(genAIContextOfZipkinSpan({ tags: { 'gen_ai.response.model': 'm' } })).toEqual({ model: 'm', provider: null });
    expect(genAIContextOfZipkinSpan({ tags: { 'http.method': 'GET' } })).toBeNull();
    expect(genAIContextOfZipkinSpan({})).toBeNull();
  });
});
