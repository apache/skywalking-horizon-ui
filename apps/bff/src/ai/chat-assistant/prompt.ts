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
 * The bundled system prompt + starter prompts, loaded from resource files under
 * `ai/lib/skills/` (NOT inlined here as template literals) so the prose
 * reads and reviews as content. Both are OVERRIDABLE from horizon.yaml
 * (`ai.systemPrompt`, `ai.starters`) — `resolveSystemPrompt` / `resolveStarters`
 * fall back to these bundled defaults when the config leaves them empty. The
 * system prompt is provider-AGNOSTIC (one text for every backend).
 */

import type { AiConfig } from '../../config/schema.js';
import { readResource } from '../lib/skills/loader.js';
import { systemPromptWithOverride } from '../lib/skills/prompt.js';


/** The bundled starter chips — `ai/lib/skills/starters.json`. */
export const BUNDLED_STARTERS: string[] = JSON.parse(readResource('starters.json')) as string[];

/** The system prompt in effect. An override replaces the shared core; the
 *  panel's presentation section is always appended, so operator wording cannot
 *  drop the rule that stops the model narrating figures it never drew. */
export function resolveSystemPrompt(ai: Pick<AiConfig, 'systemPrompt'>): string {
  return systemPromptWithOverride('panel', ai.systemPrompt);
}

/** The starter prompts in effect: the operator override when non-empty, else bundled. */
export function resolveStarters(ai: Pick<AiConfig, 'starters'>): string[] {
  return ai.starters.length ? ai.starters : BUNDLED_STARTERS;
}
