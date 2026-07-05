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
 * Root-cause playbooks — GUIDANCE the agent loads (via list_playbooks /
 * get_playbook) to sequence its data tools; the playbooks never call APIs
 * themselves. A master method (root service → calling chain → error stack;
 * upstream-first; catalog MQE verbatim) plus symptom- and layer-specialised
 * refinements. Each playbook is a self-contained resource file under
 * `ai/resources/skills/rca/<id>.md` (frontmatter + body) — the prose lives as
 * content, not TS source; this module just loads and orders them.
 */

import { readResource } from '../../resources/loader.js';

export interface Playbook {
  id: string;
  title: string;
  /** One or two sentences the agent matches a user's question against. */
  whenToUse: string;
  body: string;
}

// The order the agent sees them in list_playbooks (master first, then refinements).
const PLAYBOOK_IDS = [
  'root-cause',
  'latency',
  'errors-sla',
  'saturation',
  'middleware-remote',
  'k8s',
  'mesh',
] as const;

/** Split a `--- key: value --- body` resource into its metadata + body. Values
 *  are single-line (id / title / whenToUse) — everything after the first colon. */
function loadPlaybook(id: string): Playbook {
  const raw = readResource(`skills/rca/${id}.md`);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`Malformed playbook resource: skills/rca/${id}.md (missing frontmatter)`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { id: meta.id || id, title: meta.title ?? '', whenToUse: meta.whenToUse ?? '', body: m[2].trim() };
}

export const PLAYBOOKS: Playbook[] = PLAYBOOK_IDS.map(loadPlaybook);
