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

vi.mock('../../../logic/layers/capabilities.js', () => ({
  layerCapabilities: vi.fn(async () => ({
    components: ['traceProfiling', 'asyncProfiling', 'pprofProfiling', 'ebpfProfiling'],
  })),
}));
vi.mock('../../../util/window.js', () => ({
  getServerOffsetMinutes: vi.fn(async () => 0),
}));
vi.mock('../../../logic/layers/effective.js', () => ({
  resolveEffectiveLayer: vi.fn(async () => ({ template: null, blocked: false })),
}));
vi.mock('../../../logic/oap/profiling.js', () => ({
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
import { layerCapabilities } from '../../../logic/layers/capabilities.js';
import { resolveEffectiveLayer } from '../../../logic/layers/effective.js';
import { findInstanceWithProcesses, listServiceInstances, serviceCanEbpfProfile } from '../../../logic/oap/profiling.js';
import type { AiRequestContext } from '../../context.js';

function mockCtx(hasVerb: boolean) {
  const emitProposal = vi.fn();
  const ctx = {
    hasVerb: () => hasVerb,
    emitProposal,
    uiTemplateClient: {},
    opts: {},
    window: { start: 's', end: 'e', step: 'MINUTE' },
  } as unknown as AiRequestContext;
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

  it('clamps async duration to the 10-minute (600s) server cap', async () => {
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    await propose.invoke({ ...base, profilingType: 'async', durationMinutes: 15 });
    expect(emitProposal.mock.calls[0][0].durationMinutes).toBe(10);
  });

  it('refuses pprof (Go) when the instances report a JVM language', async () => {
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'pprof' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/Go-only|match the profiler/i);
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

  // ...but it IS the right gate for eBPF CPU profiling, which is what OAP's own
  // create form checks.
  it('refuses eBPF profiling when no process advertises eBPF support', async () => {
    (serviceCanEbpfProfile as unknown as Mock).mockResolvedValueOnce({ could: false });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'ebpf' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/eBPF-profiling support|Rover/i);
  });

  // A complete scan that finds nothing IS conclusive for network profiling.
  it('reports network profiling unavailable only when the scan was complete and clean', async () => {
    (findInstanceWithProcesses as unknown as Mock).mockResolvedValueOnce({
      instance: null, checked: 2, total: 2, failed: 0,
    });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'network' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/looks unavailable for/i);
    expect(String(out)).not.toMatch(/not conclusive/i);
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
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/could not|failed/i);
    expect(String(out)).not.toMatch(/needs a Rover eBPF agent/i);
  });

  // A capped probe must say what it actually checked, and a failed lookup is not
  // evidence of absence.
  it('reports the truncation and any failed lookups rather than a bare negative', async () => {
    (findInstanceWithProcesses as unknown as Mock).mockResolvedValueOnce({
      instance: null, checked: 60, total: 90, failed: 3,
    });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'network' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/only checked 60 of its 90 instances/i);
    expect(String(out)).toMatch(/3 lookup\(s\) failed/i);
    expect(String(out)).toMatch(/not conclusive/i);
    expect(String(out)).not.toMatch(/looks unavailable for/i);
  });

  it('refuses when capabilities cannot be read (template store blocked)', async () => {
    (layerCapabilities as unknown as Mock).mockResolvedValueOnce(null);
    (resolveEffectiveLayer as unknown as Mock).mockResolvedValueOnce({ template: null, blocked: true });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'ebpf' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/could not read|cannot confirm/i);
  });

  // No template ≠ unsupported: still propose, but say support is unconfirmed.
  it('proposes with an unconfirmed note when the layer ships no template', async () => {
    (layerCapabilities as unknown as Mock).mockResolvedValueOnce(null);
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'ebpf' });
    expect(emitProposal).toHaveBeenCalledTimes(1);
    expect(String(out)).toMatch(/could NOT confirm/);
  });

  it('refuses a type the layer does not declare', async () => {
    (layerCapabilities as unknown as Mock).mockResolvedValueOnce({ components: ['traceProfiling'] });
    const { ctx, emitProposal } = mockCtx(true);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'ebpf' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/does not support/i);
  });

  it('does NOT propose (or emit) without profile:enable', async () => {
    const { ctx, emitProposal } = mockCtx(false);
    const [propose] = triggerTools(ctx);
    const out = await propose.invoke({ ...base, profilingType: 'trace' });
    expect(emitProposal).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/permission|profile:enable/i);
  });
});
