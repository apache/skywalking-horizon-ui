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

import type { NativeSpan, TraceKeyValue, ZipkinSpan } from '@skywalking-horizon-ui/api-client';

/**
 * Which spans OAP's LLM-as-Judge samples — mirrored so the related-trace picker
 * highlights exactly the spans an evaluation record can point at.
 *
 * Source, in apache/skywalking's ai-evaluation analyzer: a native span is
 * sampled when its layer is GenAI and it carries `gen_ai.response.model`
 * (GenAIEvaluationAnalysisListener); a Zipkin/OTLP span on the tag alone
 * (AIEvaluationSpanListener). The provider label follows GenAIContextResolver:
 * `gen_ai.provider.name`, else the older `gen_ai.system`.
 */
export const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
const GEN_AI_SYSTEM = 'gen_ai.system';

export interface GenAISpanContext {
  model: string;
  provider: string | null;
}

function contextOf(tag: (key: string) => string | undefined): GenAISpanContext | null {
  const model = tag(GEN_AI_RESPONSE_MODEL)?.trim();
  if (!model) return null;
  const provider = tag(GEN_AI_PROVIDER_NAME)?.trim() || tag(GEN_AI_SYSTEM)?.trim() || null;
  return { model, provider };
}

export function genAIContextOfNativeSpan(span: Pick<NativeSpan, 'layer' | 'tags'>): GenAISpanContext | null {
  if ((span.layer ?? '').toLowerCase() !== 'genai') return null;
  const tags: TraceKeyValue[] = span.tags ?? [];
  return contextOf((key) => tags.find((t) => t.key === key)?.value);
}

export function genAIContextOfZipkinSpan(span: Pick<ZipkinSpan, 'tags'>): GenAISpanContext | null {
  const tags = span.tags ?? {};
  return contextOf((key) => tags[key]);
}
