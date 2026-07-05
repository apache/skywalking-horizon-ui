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
 * triggers skill — the ONE place the assistant can drive a mutating action, and
 * it never fires it directly. `propose_profiling` presents a DECISION CARD (the
 * analyzed cause, why profiling, what it expects to reveal) that the user
 * approves or dismisses in a popout; only on approve does the UI call the
 * existing verb-gated profile-create route. Gated on profile:enable so the
 * assistant never proposes what the caller couldn't approve.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AiRequestContext } from '../../context.js';

export function triggerTools(ctx: AiRequestContext): StructuredToolInterface[] {
  const propose = tool(
    async ({ layer, serviceId, service, endpoint, durationMinutes, cause, rationale, expectation }): Promise<string> => {
      if (!ctx.hasVerb('profile:enable')) {
        return 'You lack permission to start profiling (profile:enable). Do not propose it; explain what a profiling task would reveal instead.';
      }
      ctx.emitProposal({
        kind: 'profiling',
        profilingType: 'trace',
        layer: layer.toUpperCase(),
        serviceId,
        service,
        endpoint,
        durationMinutes,
        cause,
        rationale,
        expectation,
      });
      return 'Proposed a trace-profiling task to the user as a decision card. It is NOT running — the user must approve it. Do not analyze results now; stop here and tell the user to approve it, and that you will analyze the profile once it has collected data (ask you to analyze when ready).';
    },
    {
      name: 'propose_profiling',
      description:
        'PROPOSE a trace-profiling task (does NOT start it — the user approves a decision card first). Use only when metrics + traces cannot localise the cause and profiling would confirm a specific hypothesis (a hot method, lock contention, a slow call). You MUST supply cause (what you found), rationale (why profiling), and expectation (what it should reveal) — the user reads these before approving. Provide the service and, when possible, the specific endpoint to profile.',
      schema: z.object({
        layer: z.string().describe('OAP layer key, e.g. GENERAL'),
        serviceId: z.string().describe('OAP service id (from list_services)'),
        service: z.string().describe('service NAME'),
        endpoint: z.string().optional().describe('endpoint (API) name to profile, when known'),
        durationMinutes: z.number().int().min(1).max(15).describe('collection window in minutes (e.g. 5)'),
        cause: z.string().describe('the analyzed cause SO FAR — what the investigation found'),
        rationale: z.string().describe('why profiling is the right next step'),
        expectation: z.string().describe('what the profile is expected to reveal or confirm'),
      }),
    },
  );

  return [propose];
}
