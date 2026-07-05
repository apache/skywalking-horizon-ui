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
 * `ai/resources/prompts/` (NOT inlined here as template literals) so the prose
 * reads and reviews as content. Both are OVERRIDABLE from horizon.yaml
 * (`ai.systemPrompt`, `ai.starters`) — `resolveSystemPrompt` / `resolveStarters`
 * fall back to these bundled defaults when the config leaves them empty. The
 * system prompt is provider-AGNOSTIC (one text for every backend).
 */

import type { AiConfig } from '../../config/schema.js';
import { readResource } from '../resources/loader.js';

/** The bundled default system prompt: the frame (`prompts/system.md`) + the
 *  always-present skill guides (`prompts/skills.md`). Both are ALWAYS sent, so
 *  they're one static block (fewer files, identical tokens) — and a clean cache
 *  prefix. Situational skill guidance (the RCA playbooks) is NOT here; it's
 *  retrieved on demand via list_playbooks / get_playbook.
 *
 *  CACHE INVARIANT — keep this BYTE-STABLE across requests. Provider prompt
 *  caching (OpenAI / DeepSeek-API auto-cache the stable prefix; Bedrock Claude/
 *  Nova via cache_control) only fires when the system prompt + tool schemas are
 *  identical turn-to-turn. NEVER interpolate per-request data (a service name, a
 *  timestamp, the window) into this prompt or any tool description — do that in
 *  the user message / tool arguments, never in the static prefix. */
const SYSTEM_PROMPT_PARTS = ['prompts/system.md', 'prompts/skills.md'];
export const BUNDLED_SYSTEM_PROMPT: string = SYSTEM_PROMPT_PARTS.map((p) => readResource(p).trim()).join('\n\n');

/** The bundled starter chips — `ai/resources/prompts/starters.json`. */
export const BUNDLED_STARTERS: string[] = JSON.parse(readResource('prompts/starters.json')) as string[];

/** The system prompt in effect: the operator override when set, else bundled. */
export function resolveSystemPrompt(ai: Pick<AiConfig, 'systemPrompt'>): string {
  return ai.systemPrompt.trim() ? ai.systemPrompt : BUNDLED_SYSTEM_PROMPT;
}

/** The starter prompts in effect: the operator override when non-empty, else bundled. */
export function resolveStarters(ai: Pick<AiConfig, 'starters'>): string[] {
  return ai.starters.length ? ai.starters : BUNDLED_STARTERS;
}
