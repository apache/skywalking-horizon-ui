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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../../../../logic/layers/capabilities.js', () => ({
  layerCapabilities: vi.fn(async () => ({
    components: ['traceProfiling', 'asyncProfiling', 'pprofProfiling', 'ebpfProfiling'],
  })),
}));
vi.mock('../../../../util/window.js', () => ({
  getServerOffsetMinutes: vi.fn(async () => 0),
}));
vi.mock('../../../../logic/layers/effective.js', () => ({
  resolveEffectiveLayer: vi.fn(async () => ({ template: null, blocked: false })),
}));
vi.mock('../../../../logic/oap/profiling.js', () => ({
  listServiceInstances: vi.fn(async () => [
    { id: 'i-1', name: 'inst-1', language: 'java' },
    { id: 'i-2', name: 'inst-2', language: 'java' },
  ]),
  findInstanceWithProcesses: vi.fn(async () => ({ instance: { id: 'i-1', name: 'inst-1', language: 'java' }, checked: 1, total: 1, failed: 0 })),
  analyzeProfiling: vi.fn(),
  analyzeNetworkProfiling: vi.fn(),
  MAX_PROCESS_PROBES: 60,
  serviceCanEbpfProfile: vi.fn(async () => ({ could: true })),
}));

import { triggerTools } from './tools.js';
import { layerCapabilities } from '../../../../logic/layers/capabilities.js';
import { resolveEffectiveLayer } from '../../../../logic/layers/effective.js';
import { findInstanceWithProcesses, listServiceInstances, serviceCanEbpfProfile } from '../../../../logic/oap/profiling.js';
import type { ToolContext } from '../../tool-context.js';

function mockCtx(hasVerb: boolean) {
  const emitProposal = vi.fn();
  const ctx = {
    hasVerb: () => hasVerb,
    emitProposal,
    emitProfiling: vi.fn(),
    emitProcessTopology: vi.fn(),
    uiTemplateClient: {},
    opts: {},
    window: { start: 's', end: 'e', step: 'MINUTE' },
  } as unknown as ToolContext;
  return { ctx, emitProposal };
}

const base = {
  layer: 'general',
  serviceId: 'svc-1',
  service: 'agent::frontend',
  durationMinutes: 5,
  cause: 'p99 spike localised to one instance, but metrics do not name the hot path',
  rationale: 'metrics + traces cannot pinpoint the slow method',
  expectation: 'a hot method or lock contention in the call tree',
};

describe('propose_profiling', () => {
  beforeEach(() => {
    (layerCapabilities as unknown as Mock).mockResolvedValue({
      components: ['traceProfiling', 'asyncProfiling', 'pprofProfiling', 'ebpfProfiling', 'networkProfiling'],
    });
    (resolveEffectiveLayer as unknown as Mock).mockResolvedValue({ template: null, blocked: false });
    (findInstanceWithProcesses as unknown as Mock).mockResolvedValue({
      instance: { id: 'i-1', name: 'inst-1', language: 'java' },
      checked: 1,
      total: 1,
      failed: 0,
    });
    (serviceCanEbpfProfile as unknown as Mock).mockResolvedValue({ could: true });
  });

  // OAP's ProfileTaskCreationRequest.endpointName is String! and rejects an empty
  // one, so an endpoint-less trace card could only ever fail on approve.
  it('refuses a trace proposal with no endpoint instead of emitting a doomed card', async () => {
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'trace' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/endpoint/i);
  });

  it('emits a trace decision card (no instance resolution) with profile:enable', async () => {
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'trace', endpoint: '/api/x' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(emitProposal.mock.calls[0][0]).toMatchObject({
      kind: 'profiling',
      profilingType: 'trace',
      layer: 'GENERAL',
      endpoint: '/api/x',
    });
    expect(emitProposal.mock.calls[0][0].instanceIds).toBeUndefined();
    expect(String(out)).toMatch(/NOT running|approve/i);
  });

  it('resolves target instances + default event for async', async () => {
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    await propose.invoke({ ...base, profilingType: 'async' });
    expect(emitProposal.mock.calls[0][0]).toMatchObject({
      profilingType: 'async',
      instanceIds: ['i-1', 'i-2'],
      instanceLabel: '2 instances',
      events: ['CPU'],
    });
  });

  it('still proposes async when instances report UNKNOWN language (trusts the agent)', async () => {
    (listServiceInstances as unknown as Mock).mockResolvedValueOnce([
      { id: 'i-1', name: 'inst-1', language: 'UNKNOWN' },
    ]);
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    await propose.invoke({ ...base, profilingType: 'async' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(emitProposal.mock.calls[0][0]).toMatchObject({ profilingType: 'async' });
  });

  // OAP's only async duration rule is `duration <= 0` — there is no 600s cap to
  // honour, so a proposed window must reach the card unchanged.
  it('passes the async duration through — OAP sets no upper bound', async () => {
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    await propose.invoke({ ...base, profilingType: 'async', durationMinutes: 15 });
    expect(emitProposal.mock.calls[0][0].durationMinutes).toBe(15);
  });

  // The runtime mismatch is real, but it is OURS: OAP's pprof create validates
  // serviceId/events/duration/dumpPeriod only. So warn and still show the card.
  it('warns but still proposes pprof when the instances report a JVM language', async () => {
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'pprof' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(String(out)).toMatch(/Go-only/i);
    expect(String(out)).toMatch(/collect nothing/i);
  });

  // A mixed-language fleet must not be sent a profiler its runtime can't run —
  // the Go pods would just fail the async task.
  it('targets only the JVM instances for async in a mixed fleet', async () => {
    (listServiceInstances as unknown as Mock).mockResolvedValueOnce([
      { id: 'i-1', name: 'inst-1', language: 'java' },
      { id: 'i-2', name: 'inst-2', language: 'go' },
      { id: 'i-3', name: 'inst-3', language: 'UNKNOWN' },
    ]);
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    await propose.invoke({ ...base, profilingType: 'async' });
    expect(emitProposal.mock.calls[0][0]).toMatchObject({
      instanceIds: ['i-1', 'i-3'],
      instanceLabel: '2 of 3 instances (JVM runtime)',
    });
  });

  it('targets a network task at an instance whose processes report', async () => {
    (findInstanceWithProcesses as unknown as Mock).mockResolvedValueOnce({
      instance: { id: 'i-2', name: 'inst-2', language: 'go' },
      checked: 2,
      total: 2,
      failed: 0,
    });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    await propose.invoke({ ...base, profilingType: 'network' });
    expect(emitProposal.mock.calls[0][0]).toMatchObject({
      profilingType: 'network',
      instanceIds: ['i-2'],
      instanceLabel: 'inst-2',
    });
  });

  // queryPrepareCreateEBPFProfilingTaskData counts processes advertising
  // SUPPORT_EBPF_PROFILING, but a NETWORK task only needs any non-virtual
  // process — so couldProfiling=false must NOT block a network proposal.
  it('does not consult the eBPF-support gate for network profiling', async () => {
    (serviceCanEbpfProfile as unknown as Mock).mockClear();
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    await propose.invoke({ ...base, profilingType: 'network' });
    expect(serviceCanEbpfProfile).not.toHaveBeenCalled();
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(emitProposal.mock.calls[0][0]).toMatchObject({ profilingType: 'network', instanceIds: ['i-1'] });
  });

  // queryPrepareCreateEBPFProfilingTaskData is what OAP's own create FORM checks
  // before enabling its button — createEBPFProfilingFixedTimeTask never runs it.
  // So a false is a readiness hint to relay, not grounds to withhold the card.
  it('warns but still proposes eBPF when no process advertises eBPF support', async () => {
    (serviceCanEbpfProfile as unknown as Mock).mockResolvedValueOnce({ could: false });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'ebpf' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(String(out)).toMatch(/Rover/i);
    expect(String(out)).toMatch(/does not consult it|may still run/i);
  });

  // OAP's network create counts processes with NO time window, so a miss in our
  // rolling probe is weaker evidence than OAP's own gate — target an instance
  // and let `getProcessCount` give the real answer.
  it('still proposes network profiling when the process probe finds nothing', async () => {
    (findInstanceWithProcesses as unknown as Mock).mockResolvedValueOnce({
      instance: null, checked: 2, total: 2, failed: 0,
    });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'network' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(emitProposal.mock.calls[0][0]).toMatchObject({ instanceIds: ['i-1'] });
    expect(String(out)).toMatch(/without a time window/i);
    expect(String(out)).toMatch(/Do not claim that before approval/i);
  });

  // A failed lookup is NOT evidence of a missing Rover agent — reporting it as
  // "network profiling is unavailable here" would be a false diagnosis.
  it('does not blame a missing Rover agent when the process lookup failed', async () => {
    (findInstanceWithProcesses as unknown as Mock).mockResolvedValueOnce({
      instance: null,
      checked: 2,
      total: 2,
      failed: 2,
      error: 'connect ECONNREFUSED',
    });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'network' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(String(out)).toMatch(/every process lookup failed/i);
    expect(String(out)).toMatch(/ECONNREFUSED/);
  });

  // A capped probe must say what it actually checked — the caveat carries the
  // scope so the model cannot present a partial scan as a whole-fleet negative.
  it('reports the truncation and any failed lookups in the caveat', async () => {
    (findInstanceWithProcesses as unknown as Mock).mockResolvedValueOnce({
      instance: null, checked: 60, total: 90, failed: 3,
    });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'network' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(String(out)).toMatch(/only 60 of 90 instances were checked/i);
    expect(String(out)).toMatch(/3 lookup\(s\) failed/i);
  });

  // An unreadable layer template says nothing about the BACKEND, so it cannot
  // withhold the card either.
  it('proposes with a caveat when capabilities cannot be read (template store blocked)', async () => {
    (layerCapabilities as unknown as Mock).mockResolvedValueOnce(null);
    (resolveEffectiveLayer as unknown as Mock).mockResolvedValueOnce({ template: null, blocked: true });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'ebpf' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(String(out)).toMatch(/unreachable or disabled/i);
    expect(String(out)).toMatch(/says nothing about whether OAP accepts/i);
  });

  it('proposes with a caveat when the layer ships no template', async () => {
    (layerCapabilities as unknown as Mock).mockResolvedValueOnce(null);
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'ebpf' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(String(out)).toMatch(/ships no layer template/i);
  });

  // The template's `components` list is Horizon config; OAP applies no layer
  // gate to any profiling create. A missing flag must not veto the card.
  it('proposes a type the layer does not declare, flagging it as Horizon-side config', async () => {
    (layerCapabilities as unknown as Mock).mockResolvedValueOnce({ components: ['traceProfiling'] });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'ebpf' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(String(out)).toMatch(/does not list ebpf profiling/i);
    expect(String(out)).toMatch(/OAP applies no layer gate/i);
    expect(String(out)).toMatch(/NOT that the deployment cannot do it/i);
  });

  it('does NOT propose (or emit) without profile:enable', async () => {
    const { ctx, emitProposal } = mockCtx(false);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'trace' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/permission|profile:enable/i);
  });

  // The create routes REJECT more than MAX_TARGET_INSTANCES rather than
  // slicing, so a card above the cap would advertise a fleet the fired task
  // never covers. Refusing to emit it, and saying how to narrow, is the fix.
  it('refuses to emit a card above the per-task instance cap', async () => {
    (listServiceInstances as unknown as Mock).mockResolvedValueOnce(
      Array.from({ length: 40 }, (_, i) => ({ id: `i-${i}`, name: `inst-${i}`, language: 'java' })),
    );
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'async' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/40 matching instances/);
    expect(String(out)).toMatch(/at most 32/);
    expect(String(out)).toMatch(/"instances" argument/);
  });

  // A fleet above the cap becomes proposable by naming a subset explicitly.
  it('proposes a capped fleet once narrowed by the "instances" argument', async () => {
    (listServiceInstances as unknown as Mock).mockResolvedValueOnce(
      Array.from({ length: 40 }, (_, i) => ({ id: `i-${i}`, name: `inst-${i}`, language: 'java' })),
    );
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    await propose.invoke({ ...base, profilingType: 'async', instances: ['inst-3', 'inst-7'] });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(emitProposal.mock.calls[0][0]).toMatchObject({ instanceIds: ['i-3', 'i-7'] });
  });

  // An explicit name must be checked against the FULL instance list, not the
  // language-filtered subset — naming an instance because its reported
  // language is believed wrong is the entire point of narrowing explicitly.
  it('honours an explicitly named instance the language heuristic would have excluded', async () => {
    (listServiceInstances as unknown as Mock).mockResolvedValueOnce([
      { id: 'i-1', name: 'inst-1', language: 'java' },
      { id: 'i-2', name: 'inst-2', language: 'go' },
    ]);
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    await propose.invoke({ ...base, profilingType: 'async', instances: ['inst-2'] });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(emitProposal.mock.calls[0][0]).toMatchObject({ instanceIds: ['i-2'] });
  });

  // A name that matches nothing rejects the WHOLE selection rather than
  // silently proceeding with only the names that did match.
  it('rejects the whole selection when one named instance does not exist, rather than dropping it silently', async () => {
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'async', instances: ['inst-1', 'no-such-instance'] });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/no-such-instance/);
    expect(String(out)).toMatch(/no instance with that name exists/);
  });
});

describe('analyze_profiling', () => {
  it('threads the optional event argument through to analyzeProfiling', async () => {
    const { analyzeProfiling } = await import('../../../../logic/oap/profiling.js');
    (analyzeProfiling as unknown as Mock).mockResolvedValueOnce({
      profilingType: 'async',
      taskId: 't-1',
      trees: [],
      metricKey: 'count',
      tip: null,
      logs: [],
      summary: { service: 'agent::frontend', frameCount: 0 },
      reachable: true,
    });
    const { ctx } = mockCtx(true);
    const [, analyze] = triggerTools(ctx);
    await analyze.invoke({ layer: 'general', service: 'agent::frontend', profilingType: 'async', event: 'ALLOC' });
    expect(analyzeProfiling).toHaveBeenCalledWith(
      expect.objectContaining({ profilingType: 'async', event: 'ALLOC' }),
    );
  });

  // A CPU+ALLOC task whose CPU side collected nothing must not be reported
  // as "no analyzable stacks, do not retry" while its ALLOC data goes unread —
  // `tip` names the other event precisely so this branch does not have to guess.
  it('points at the other captured event instead of declaring an async task empty', async () => {
    const { analyzeProfiling } = await import('../../../../logic/oap/profiling.js');
    (analyzeProfiling as unknown as Mock).mockResolvedValueOnce({
      profilingType: 'async',
      taskId: 't-1',
      trees: [],
      metricKey: 'count',
      tip: 'showing the CPU profile only — this task also captured ALLOC, and those use different units (samples / bytes / nanoseconds), so they cannot share one flame. Call analyze_profiling again with event set to one of: ALLOC.',
      logs: [{ instanceName: 'i-1', operationType: 'EXECUTION_FINISHED', operationTime: 1 }],
      summary: { service: 'agent::frontend', frameCount: 0, instances: ['i-1'] },
      reachable: true,
    });
    const { ctx } = mockCtx(true);
    const [, analyze] = triggerTools(ctx);
    const out = await analyze.invoke({ layer: 'general', service: 'agent::frontend', profilingType: 'async' });
    expect(String(out)).toMatch(/also captured ALLOC/);
    expect(String(out)).toMatch(/Call analyze_profiling again with that event/);
    expect(String(out)).not.toMatch(/do not retry indefinitely/i);
  });

  // The same "finished, empty" shape for trace/eBPF must NOT be reinterpreted
  // as "try a different event" — their `tip` means something else entirely
  // (an OAP truncation notice), and neither takes an `event` argument.
  it('does not misapply the "try another event" framing to a trace tip', async () => {
    const { analyzeProfiling } = await import('../../../../logic/oap/profiling.js');
    (analyzeProfiling as unknown as Mock).mockResolvedValueOnce({
      profilingType: 'trace',
      taskId: 't-2',
      trees: [],
      metricKey: 'duration',
      tip: 'OAP only analyzed part of this trace',
      logs: [],
      summary: { service: 'agent::frontend', frameCount: 0, segmentCount: 3 },
      reachable: true,
    });
    const { ctx } = mockCtx(true);
    const [, analyze] = triggerTools(ctx);
    const out = await analyze.invoke({ layer: 'general', service: 'agent::frontend', profilingType: 'trace' });
    expect(String(out)).toMatch(/do not retry indefinitely/i);
    expect(String(out)).not.toMatch(/Call analyze_profiling again with that event/);
  });
});
