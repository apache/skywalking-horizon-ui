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
 * rca skill — the root-cause playbook catalog as retrieval tools. Pure guidance
 * (no OAP access): the agent lists the playbooks, fetches the one matching the
 * question, and follows its steps — which is how it learns to SEQUENCE the data
 * tools. Kept out of the system prompt so many playbooks scale without bloat.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { PLAYBOOKS } from './playbooks.js';

export function rcaTools(): StructuredToolInterface[] {
  const list = tool(
    async (): Promise<string> =>
      JSON.stringify(PLAYBOOKS.map((p) => ({ id: p.id, title: p.title, whenToUse: p.whenToUse }))),
    {
      name: 'list_playbooks',
      description:
        'List the available root-cause investigation playbooks (id + title + when-to-use). Call this at the START of any "why is X wrong / what is the root cause" investigation, then get_playbook the best-matching one and FOLLOW it.',
      schema: z.object({}),
    },
  );

  const get = tool(
    async ({ id }): Promise<string> => {
      const p = PLAYBOOKS.find((x) => x.id === id);
      if (!p) return `No playbook "${id}". Call list_playbooks for the available ids.`;
      return p.body;
    },
    {
      name: 'get_playbook',
      description:
        'Fetch a root-cause playbook by id (from list_playbooks) — a step-by-step method that sequences the data tools. Load the matching playbook before investigating, then follow its steps in order.',
      schema: z.object({
        id: z
          .string()
          .describe('playbook id, e.g. root-cause, latency, errors-sla, saturation, middleware-remote, k8s, mesh'),
      }),
    },
  );

  return [list, get];
}
