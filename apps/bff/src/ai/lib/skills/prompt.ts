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
 * System-prompt assembly: one shared core plus a per-surface presentation
 * section.
 *
 * What to investigate and how OAP behaves is identical for every consumer, so
 * `system.md` + `skills.md` are one copy. What differs is only where output
 * LANDS, and that difference is not cosmetic — the panel's "SHOW, don't
 * describe" rule tells the model that calling a show_* tool is what renders a
 * figure, which is true in the chat panel and false in a terminal, where
 * obeying it literally produces the wall of text the rule exists to prevent.
 * So the presentation section is swapped, never the core.
 */

import { readResource } from './loader.js';

/** What the client can display. Selected by which consumer is assembling
 *  (panel), or by MCP capability negotiation on initialize (terminal/inline). */
export type Surface = 'panel' | 'terminal' | 'inline';

const CORE = ['system.md', 'skills.md'];

/**
 * CACHE INVARIANT — each surface's prompt must be BYTE-STABLE across requests.
 * Provider prompt caching only fires when the system prompt and tool schemas
 * are identical turn-to-turn, so the variants are computed once and memoised
 * rather than reassembled per call. Never interpolate per-request data (a
 * service name, a timestamp, the window) into any of these files.
 */
const cache = new Map<Surface, string>();

/** The bundled prompt for a surface: shared core, then its presentation. */
export function bundledSystemPrompt(surface: Surface): string {
  const hit = cache.get(surface);
  if (hit) return hit;
  const parts = [...CORE, `presentation.${surface}.md`];
  const text = parts.map((p) => readResource(p).trim()).join('\n\n');
  cache.set(surface, text);
  return text;
}

/**
 * An operator override replaces the CORE only — the presentation section is
 * always appended. Someone tuning the panel's wording should not be able to
 * delete, by omission, the rule that stops the model claiming it drew a chart
 * it never drew.
 */
const overrideCache = new Map<string, string>();

export function systemPromptWithOverride(surface: Surface, override: string): string {
  const trimmed = override.trim();
  if (!trimmed) return bundledSystemPrompt(surface);
  // Memoised for the same reason the bundled variants are: this runs per chat
  // request, and an unmemoised path would do a blocking read every turn for a
  // byte-identical result — and a result that must stay byte-identical for the
  // provider's prompt cache to hit at all.
  const key = `${surface}\u0000${trimmed}`;
  const hit = overrideCache.get(key);
  if (hit) return hit;
  const text = [trimmed, readResource(`presentation.${surface}.md`).trim()].join('\n\n');
  overrideCache.set(key, text);
  return text;
}
