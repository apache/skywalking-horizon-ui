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

import { describe, it, expect, vi } from 'vitest';
import { triggerTools } from './tools.js';
import type { AiRequestContext } from '../../context.js';

function mockCtx(hasVerb: boolean) {
  const emitProposal = vi.fn();
  const ctx = { hasVerb: () => hasVerb, emitProposal } as unknown as AiRequestContext;
  return { ctx, emitProposal };
}

const input = {
  layer: 'general',
  serviceId: 'svc-1',
  service: 'agent::frontend',
  endpoint: '/api/x',
  durationMinutes: 5,
  cause: 'p99 spike localised to one instance, but metrics do not name the hot path',
  rationale: 'metrics + traces cannot pinpoint the slow method',
  expectation: 'a hot method or lock contention in the call tree',
};

describe('propose_profiling', () => {
  it('emits a decision card (with the reasoning) when the caller has profile:enable', async () => {
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke(input);
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(emitProposal.mock.calls[0][0]).toMatchObject({
      kind: 'profiling',
      profilingType: 'trace',
      layer: 'GENERAL',
      service: 'agent::frontend',
      endpoint: '/api/x',
      durationMinutes: 5,
      cause: input.cause,
      rationale: input.rationale,
      expectation: input.expectation,
    });
    // The tool must NOT claim it started — it stops for user approval.
    expect(String(out)).toMatch(/NOT running|approve/i);
  });

  it('does NOT propose (or emit) without profile:enable', async () => {
    const { ctx, emitProposal } = mockCtx(false);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke(input);
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/permission|profile:enable/i);
  });
});
