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
 * AI resource loader. The assistant's PROSE — the system prompt, the RCA
 * playbooks — lives as plain .md / .json content under this directory, NOT as
 * template literals in the TS source, so it reads like documentation and can be
 * reviewed / edited as content. Files are read at runtime (same approach as
 * `bundled_templates`) with a candidate-path resolver that works in both the dev
 * source tree and the packaged bundle:
 *   - dev (tsx): this loader IS `src/ai/lib/skills/loader.ts`, so `<HERE>` is the
 *     skills dir itself and `<HERE>/<rel>` resolves directly.
 *   - packaged bundle: esbuild inlines this file into `dist/server.js`, so
 *     `<HERE>` is `dist/`; `scripts/package.mjs` copies this dir to
 *     `dist/skills`, so `<HERE>/skills/<rel>` resolves.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

// Ordered by how the code is running; the first that exists wins.
const BASES = [
  HERE, // dev source tree: <src>/ai/lib/skills
  join(HERE, 'skills'), // packaged bundle: <dist>/skills
  join(process.cwd(), 'skills'), // a relocated dist run from its own dir
];

/** Read a skill file (relative to the skills dir), e.g.
 *  `system.md` or `rca/latency.md`. Throws a clear error if the
 *  file can't be found in any candidate base — a fail-fast at boot beats a
 *  silently empty prompt. */
export function readResource(relPath: string): string {
  let lastErr: unknown;
  for (const base of BASES) {
    try {
      return readFileSync(join(base, relPath), 'utf8');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `AI resource not found: ${relPath} (looked in ${BASES.map((b) => join(b, relPath)).join(', ')}) — ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

// ── Externalized tool prompts ────────────────────────────────────────────────
// The LLM-facing tool manifest — each tool's `description` + per-param hints —
// lives in `resources/tools/<skill>.yaml`, NOT hardcoded in the tool factory, so
// it's editable like system.md/skills.md (one source, no code↔prose drift). Read
// once per skill at boot and cached: the strings must stay byte-stable, since the
// tool schemas are part of the provider prompt-cache prefix (see agent/prompt.ts).

interface ToolPromptEntry {
  description: string;
  params?: Record<string, string>;
}
const skillPromptCache = new Map<string, Record<string, ToolPromptEntry>>();

function loadSkillPrompts(skill: string): Record<string, ToolPromptEntry> {
  let entry = skillPromptCache.get(skill);
  if (!entry) {
    entry = (YAML.parse(readResource(`tools/${skill}.yaml`)) ?? {}) as Record<string, ToolPromptEntry>;
    skillPromptCache.set(skill, entry);
  }
  return entry;
}

/**
 * The externalized prompt for one tool: its `description` and a `p(param)` hint
 * lookup, read from `resources/tools/<skill>.yaml`. Fail-fast at boot if a tool
 * or a param hint is missing — a silent empty description mis-guides the model.
 * Usage in a skill factory: `const t = toolPrompt('context', 'list_services')`
 * → `description: t.description`, `z.string().describe(t.p('layer'))`.
 */
/**
 * How to READ one card kind's payload, for the model that analyses it.
 *
 * Sent only for the kinds a reply actually contains, so a figure answer never
 * pays for the trace note. Missing is a hard error for the same reason a missing
 * tool description is: the model would be handed rows with no way to know what
 * they mean, and would guess.
 */
export function cardPrompt(kind: string): string {
  const entry = loadSkillPrompts('cards')[kind];
  if (!entry?.description) throw new Error(`AI card prompt missing: tools/cards.yaml → ${kind}.description`);
  return entry.description;
}

export function toolPrompt(skill: string, name: string): { description: string; p(param: string): string } {
  const entry = loadSkillPrompts(skill)[name];
  if (!entry?.description) throw new Error(`AI tool prompt missing: tools/${skill}.yaml → ${name}.description`);
  return {
    description: entry.description,
    p(param: string): string {
      const hint = entry.params?.[param];
      if (hint === undefined) throw new Error(`AI tool param hint missing: tools/${skill}.yaml → ${name}.params.${param}`);
      return hint;
    },
  };
}
