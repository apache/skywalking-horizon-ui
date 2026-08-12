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
 * `analyzeProfiling` — find a completed profiling task and map its result into
 * the single `ProfileAnalyzationTree[]` shape `ProfileFlameGraph` renders,
 * hiding each flavor's different fetch (trace needs segments, eBPF needs
 * schedules) and stack-element shape. Network profiling is a topology, not a
 * flame, and is out of scope here. Never throws: a bad round-trip degrades to
 * `reachable:false`, a not-yet-collected task to empty `trees` — the honest
 * no-data states, not a reason to retry.
 */

import type {
  ProcessCall,
  ProcessNode,
  ProcessTopologyResponse,
  ProfileAnalyzationElement,
  ProfileAnalyzationTree,
  ProfileSpan,
} from '@skywalking-horizon-ui/api-client';
import type { GraphqlOptions } from '../../client/graphql.js';
import { graphqlPost } from '../../client/graphql.js';
import { fmtMinute } from '../../util/window.js';

export type ProfilingType = 'trace' | 'pprof' | 'async' | 'ebpf';

export interface ProfilingLogLine {
  instanceName: string;
  operationType: string;
  operationTime: number;
}

/** Structured task facts for the result-block header (the flame carries no context). */
export interface ProfilingSummary {
  service: string;
  endpoint?: string | null;
  instances?: string[];
  events?: string[];
  durationLabel?: string | null;
  /** The collection window in SECONDS — `durationLabel` is display-only. */
  durationSec?: number | null;
  startTime?: number | null;
  segmentCount?: number | null;
  /** Total stack frames across all trees — 0 ⇒ nothing collected yet. */
  frameCount: number;
}

/** trace only — the slowest profiled segment's trace, for the span waterfall
 *  shown beside the flame (the trace+profiling combination). */
export interface TraceContext {
  traceId: string;
  spans: ProfileSpan[];
}

export interface ProfilingAnalysis {
  profilingType: ProfilingType;
  taskId: string | null;
  /** Common flame input; empty when the task collected no data (or unreachable). */
  trees: ProfileAnalyzationTree[];
  metricKey: 'count' | 'duration';
  /** OAP's partial-data notice (a large snapshot only partly analyzed). */
  tip: string | null;
  logs: ProfilingLogLine[];
  summary: ProfilingSummary;
  traceContext?: TraceContext;
  reachable: boolean;
  error?: string;
}

// async-profiler events fold into one JFR tree type; pick it to select which
// tree the analyze returns. Inlined (not imported from the http route) to keep
// the logic→client direction clean.
// One capture event can yield MORE THAN ONE JFR tree, and a task legitimately
// carries several events — so this maps to a LIST and every entry is read.
// ALLOC is the trap: OAP's JFRConverter splits each AllocationSample on
// `tlabSize != 0` into OBJECT_ALLOCATION_IN_NEW_TLAB vs _OUTSIDE_TLAB, so
// reading only the in-TLAB half silently drops every large-object allocation
// path — the one an allocation profile is usually opened to find.
export const ASYNC_EVENT_TO_JFR: Record<string, string[]> = {
  CPU: ['EXECUTION_SAMPLE'],
  WALL: ['EXECUTION_SAMPLE'],
  CTIMER: ['EXECUTION_SAMPLE'],
  ITIMER: ['EXECUTION_SAMPLE'],
  LOCK: ['LOCK'],
  ALLOC: ['OBJECT_ALLOCATION_IN_NEW_TLAB', 'OBJECT_ALLOCATION_OUTSIDE_TLAB'],
};

function jfrKeyOf(event: string): string {
  return (ASYNC_EVENT_TO_JFR[event] ?? ['EXECUTION_SAMPLE']).join(',');
}

/** Which captured event this call renders (`wantEvent` if the task actually
 *  has it, else the task's first), and which of the REST are worth naming as
 *  "call again to see this one" — only those resolving to a DIFFERENT
 *  underlying JFR request. CPU / WALL / CTIMER / ITIMER all produce the exact
 *  same EXECUTION_SAMPLE query, so a task capturing two of them has ONE
 *  dataset, not two; advertising the sibling as a distinct result to fetch
 *  would return the identical tree and read as a broken "try again". This
 *  applies to the "other" events AMONG THEMSELVES too, not just against the
 *  primary — a CPU+WALL+ALLOC task analyzed as ALLOC must offer ONE of
 *  {CPU, WALL} as the follow-up, not both. */
export function pickAnalyzedEvent(
  events: readonly string[],
  wantEvent: string | undefined,
): { primaryEvent: string; otherEvents: string[] } {
  const primaryEvent = wantEvent && events.includes(wantEvent) ? wantEvent : (events[0] ?? 'CPU');
  const seenJfrKeys = new Set([jfrKeyOf(primaryEvent)]);
  const otherEvents: string[] = [];
  for (const e of events) {
    if (e === primaryEvent) continue;
    const key = jfrKeyOf(e);
    if (seenJfrKeys.has(key)) continue;
    seenJfrKeys.add(key);
    otherEvents.push(e);
  }
  return { primaryEvent, otherEvents };
}

/** ALL captured events, primaryEvent first — for the task-fact summary. NOT
 *  `pickAnalyzedEvent`'s `otherEvents`, which drops same-JFR siblings (CPU +
 *  WALL) because reading them again is redundant for RE-ANALYSIS purposes.
 *  That is a different question from "what did this task capture" — a task
 *  that recorded both must still say so. */
export function summaryEventOrder(events: readonly string[], primaryEvent: string): string[] {
  return [primaryEvent, ...events.filter((e) => e !== primaryEvent)];
}

// Cap the trace analyze fan-out: each profiled span becomes one analyze query,
// and OAP snapshots the request (returns `tip` when it only analyzes part). We
// take the slowest segments first so the busiest call paths dominate the flame.
const MAX_TRACE_ANALYZE_QUERIES = 100;

// OAP's EBPFProfilingAnalyzer.FETCH_DATA_DURATION — the chunk size it splits
// every submitted eBPF time range into. Ours only has to MATCH it to budget the
// fan-out; OAP still does the splitting.
const EBPF_CHUNK_MS = 10_000;
const MAX_EBPF_ANALYZE_CHUNKS = 600;

const LIST_SERVICES_FOR_RESOLVE = /* GraphQL */ `
  query ListServicesForProfilingResolve($layer: String!) {
    services: listServices(layer: $layer) { id name normal }
  }
`;

const GET_PROFILE_TASK_LIST = /* GraphQL */ `
  query AiGetProfileTaskList($serviceId: ID) {
    taskList: getProfileTaskList(serviceId: $serviceId) {
      id serviceId endpointName startTime duration
    }
  }
`;

const GET_PROFILE_TASK_SEGMENTS = /* GraphQL */ `
  query AiGetProfileTaskSegments($taskID: ID!) {
    segmentList: getProfileTaskSegments(taskID: $taskID) {
      traceId duration
      spans {
        spanId parentSpanId segmentId
        refs { traceId parentSegmentId parentSpanId type }
        serviceCode serviceInstanceName startTime endTime endpointName
        type peer component isError layer profiled
      }
    }
  }
`;

const GET_PROFILE_TASK_LOGS = /* GraphQL */ `
  query AiGetProfileTaskLogs($taskID: String) {
    taskLogs: getProfileTaskLogs(taskID: $taskID) {
      instanceName operationType operationTime
    }
  }
`;

const GET_PROFILE_ANALYZE = /* GraphQL */ `
  query AiGetProfileAnalyze($queries: [SegmentProfileAnalyzeQuery!]!) {
    analyze: getSegmentsProfileAnalyze(queries: $queries) {
      tip
      trees { elements { id parentId codeSignature duration durationChildExcluded count } }
    }
  }
`;

const GET_PPROF_TASK_LIST = /* GraphQL */ `
  query AiGetPprofTaskList($request: PprofTaskListRequest!) {
    pprofTaskList: queryPprofTaskList(request: $request) {
      tasks { id serviceInstanceIds createTime events duration }
    }
  }
`;

const GET_PPROF_PROGRESS = /* GraphQL */ `
  query AiGetPprofProgress($taskId: String!) {
    taskProgress: queryPprofTaskProgress(taskId: $taskId) {
      logs { instanceName operationType operationTime }
    }
  }
`;

const GET_PPROF_ANALYZE = /* GraphQL */ `
  query AiGetPprofAnalyze($request: PprofAnalyzationRequest!) {
    analysisResult: queryPprofAnalyze(request: $request) {
      tree { elements { id parentId symbol: codeSignature dumpCount: total self } }
    }
  }
`;

const GET_ASYNC_TASK_LIST = /* GraphQL */ `
  query AiGetAsyncTaskList($request: AsyncProfilerTaskListRequest!) {
    asyncTaskList: queryAsyncProfilerTaskList(request: $request) {
      tasks { id serviceInstanceIds createTime events duration }
    }
  }
`;

const GET_ASYNC_PROGRESS = /* GraphQL */ `
  query AiGetAsyncProgress($taskId: String!) {
    taskProgress: queryAsyncProfilerTaskProgress(taskId: $taskId) {
      logs { instanceName operationType operationTime }
    }
  }
`;

const GET_ASYNC_ANALYZE = /* GraphQL */ `
  query AiGetAsyncAnalyze($request: AsyncProfilerAnalyzationRequest!) {
    analysisResult: queryAsyncProfilerAnalyze(request: $request) {
      tree { elements { id parentId symbol: codeSignature dumpCount: total self } }
    }
  }
`;

// Shared by ON_CPU/OFF_CPU (flame) and NETWORK (topology) reads — the instance
// fields are null on a service-scoped ON_CPU task and carry the watched pod on a
// network task, which is the only handle on WHERE that task's data lives.
const QUERY_EBPF_TASKS = /* GraphQL */ `
  query AiQueryEBPFTasks($serviceId: ID, $targets: [EBPFProfilingTargetType!], $triggerType: EBPFProfilingTriggerType) {
    tasks: queryEBPFProfilingTasks(serviceId: $serviceId, targets: $targets, triggerType: $triggerType) {
      taskId targetType taskStartTime fixedTriggerDuration serviceInstanceId serviceInstanceName
    }
  }
`;

const QUERY_EBPF_PREPARE = /* GraphQL */ `
  query AiEbpfPrepare($serviceId: ID!) {
    prepare: queryPrepareCreateEBPFProfilingTaskData(serviceId: $serviceId) {
      couldProfiling
    }
  }
`;

const QUERY_EBPF_SCHEDULES = /* GraphQL */ `
  query AiQueryEBPFSchedules($taskId: ID!) {
    schedules: queryEBPFProfilingSchedules(taskId: $taskId) {
      scheduleId startTime endTime
    }
  }
`;

const ANALYSIS_EBPF_RESULT = /* GraphQL */ `
  query AiAnalysisEBPF($scheduleIdList: [ID!]!, $timeRanges: [EBPFProfilingAnalyzeTimeRange!]!, $aggregateType: EBPFProfilingAnalyzeAggregateType) {
    result: analysisEBPFProfilingResult(scheduleIdList: $scheduleIdList, timeRanges: $timeRanges, aggregateType: $aggregateType) {
      tip
      trees { elements { id parentId symbol stackType dumpCount } }
    }
  }
`;

const LIST_INSTANCES = /* GraphQL */ `
  query AiListServiceInstances($serviceId: ID!, $duration: Duration!) {
    instances: listInstances(serviceId: $serviceId, duration: $duration) { id name language }
  }
`;

export interface ServiceInstanceInfo {
  id: string;
  name: string;
  language: string | null;
}

/** Resolve a service's instances (with runtime language) — the propose tool fills
 *  async/pprof/network target ids from this and reads language to match the profiler. */
export async function listServiceInstances(
  opts: GraphqlOptions,
  serviceId: string,
  window: { start: string; end: string; step: string },
): Promise<ServiceInstanceInfo[]> {
  const data = await graphqlPost<{ instances: Array<{ id: string; name: string; language?: string | null }> }>(
    opts,
    LIST_INSTANCES,
    { serviceId, duration: { start: window.start, end: window.end, step: window.step } },
  );
  return (data.instances ?? []).map((i) => ({ id: i.id, name: i.name, language: i.language ?? null }));
}

const GET_PROCESS_TOPOLOGY = /* GraphQL */ `
  query AiProcessTopology($serviceInstanceId: ID!, $duration: Duration!) {
    topology: getProcessTopology(serviceInstanceId: $serviceInstanceId, duration: $duration) {
      nodes { id name isReal serviceName serviceId serviceInstanceId serviceInstanceName }
      calls { id source target detectPoints sourceComponents targetComponents }
    }
  }
`;

const LIST_INSTANCE_PROCESSES = /* GraphQL */ `
  query AiListInstanceProcesses($instanceId: ID!, $duration: Duration!) {
    processes: listProcesses(instanceId: $instanceId, duration: $duration) { id detectType }
  }
`;

export interface NetworkProfilingResult {
  instanceName: string | null;
  /** The NETWORK task this read was scoped to — null ⇒ none exists (or none
   *  usable) and the read fell back to probing instances over the chat window. */
  taskId: string | null;
  /** The OAP-local Duration actually queried (the task's own execution window, or
   *  the chat window on the fallback path) — callers must report which was used. */
  queried: { start: string; end: string };
  /** The captured process-conversation graph — frozen render input for
   *  ProcessTopologyGraph, so the block replays without re-querying. */
  topology: ProcessTopologyResponse;
}

export interface AnalyzeNetworkProfilingInput {
  opts: GraphqlOptions;
  layerKey: string;
  service: string;
  /** FALLBACK scope only — used when no NETWORK task pins an instance + window. */
  window: { start: string; end: string; step: string };
  /** Epoch-ms mirror of `window`, so the process-graph probe can be re-cut at
   *  MINUTE granularity (see `minuteWindow`). */
  rangeMs: { startMs: number; endMs: number };
  /** OAP-server UTC offset, to render a task's epoch-ms window OAP-local. */
  offsetMinutes: number;
  /** Read this task; when absent, the service's most recent NETWORK task. */
  taskId?: string;
}

// Rover watches processes per instance, so only part of a fleet may report a
// graph — probe a few instances instead of judging the service by its first.
const MAX_NETWORK_TOPOLOGY_PROBES = 5;

interface NetworkTask {
  taskId: string;
  serviceInstanceId: string | null;
  serviceInstanceName: string | null;
  taskStartTime: number;
  fixedTriggerDuration: number | null;
}

/** Every eBPF task for a service, newest first, across BOTH trigger types —
 *  `queryEBPFProfilingTasks` defaults a missing `triggerType` to FIXED_TIME, so
 *  one call misses everything a continuous policy started. */
async function ebpfTasksBothTriggers<T extends { taskStartTime?: number }>(
  opts: GraphqlOptions,
  vars: Record<string, unknown>,
): Promise<T[]> {
  // Not caught — see the note in ebpf.ts. A swallowed failure here makes the
  // assistant answer "no eBPF-profiling task found" for an OAP that is simply
  // unreachable, which is a wrong answer rather than a missing one.
  const ask = (triggerType: string) =>
    graphqlPost<{ tasks: T[] }>(opts, QUERY_EBPF_TASKS, { ...vars, triggerType }).then(
      (d) => d.tasks ?? [],
    );
  const [fixed, continuous] = await Promise.all([ask('FIXED_TIME'), ask('CONTINUOUS_PROFILING')]);
  return [...fixed, ...continuous].sort((a, b) => (b.taskStartTime ?? 0) - (a.taskStartTime ?? 0));
}

async function findNetworkTask(
  opts: GraphqlOptions,
  serviceId: string,
  wantTaskId: string | undefined,
): Promise<NetworkTask | null> {
  const tasks = await ebpfTasksBothTriggers<NetworkTask>(opts, {
    serviceId,
    targets: ['NETWORK'],
  });
  return (wantTaskId ? tasks.find((t) => t.taskId === wantTaskId) : tasks[0]) ?? null;
}

// A task's data only exists for the span it ran, on the instance it watched. A
// still-running (keep-alive) task reports no duration — read it up to now, the
// same rule the network-profiling view applies.
function minuteWindow(
  range: { startMs: number; endMs: number },
  offsetMinutes: number,
): { start: string; end: string; step: 'MINUTE' } {
  return {
    start: fmtMinute(range.startMs, offsetMinutes),
    end: fmtMinute(range.endMs, offsetMinutes),
    step: 'MINUTE',
  };
}

function taskDuration(task: NetworkTask, offsetMinutes: number): { start: string; end: string; step: 'MINUTE' } {
  const durMs = (task.fixedTriggerDuration ?? 0) * 1000;
  const endMs = durMs > 0 ? task.taskStartTime + durMs : Date.now();
  return {
    start: fmtMinute(task.taskStartTime, offsetMinutes),
    end: fmtMinute(endMs, offsetMinutes),
    step: 'MINUTE',
  };
}

async function fetchProcessTopology(
  opts: GraphqlOptions,
  serviceInstanceId: string,
  duration: { start: string; end: string; step: string },
): Promise<{ nodes: ProcessNode[]; calls: ProcessCall[] }> {
  const data = await graphqlPost<{ topology: { nodes: ProcessNode[]; calls: ProcessCall[] } | null }>(
    opts,
    GET_PROCESS_TOPOLOGY,
    { serviceInstanceId, duration },
  );
  return { nodes: data.topology?.nodes ?? [], calls: data.topology?.calls ?? [] };
}

interface TopologyProbe {
  instance: ServiceInstanceInfo;
  nodes: ProcessNode[];
  calls: ProcessCall[];
}

async function probeProcessTopology(
  opts: GraphqlOptions,
  instances: ServiceInstanceInfo[],
  duration: { start: string; end: string; step: string },
): Promise<{ hit: TopologyProbe | null; error: string | null }> {
  let error: string | null = null;
  for (const instance of instances.slice(0, MAX_NETWORK_TOPOLOGY_PROBES)) {
    try {
      const g = await fetchProcessTopology(opts, instance.id, duration);
      if (g.nodes.length) return { hit: { instance, ...g }, error: null };
    } catch (err) {
      // One bad instance doesn't condemn the fleet — keep probing, report the
      // first failure only if no instance produced a graph.
      if (!error) error = err instanceof Error ? err.message : String(err);
    }
  }
  return { hit: null, error };
}

// listProcesses is a per-instance metadata read — far cheaper than the topology
// build the graph probe does — so this walks deeper into a fleet before giving
// up. Still bounded: it runs on a chat turn, one round-trip per instance.
export const MAX_PROCESS_PROBES = 60;
/** Probes run concurrently in batches, so a wider sweep costs round-trip ROUNDS,
 *  not one per instance. */
const PROCESS_PROBE_CONCURRENCY = 6;
/** Look-back for target discovery — the default the network task-creation flow
 *  uses (it clamps 5..180 around 30). */
const PROCESS_PROBE_WINDOW_MIN = 30;

// OAP's create gate counts NON-virtual processes (EBPFProfilingMutationService →
// getProcessCount, which excludes ProcessDetectType.VIRTUAL — those are minted
// only to draw the topology's remote peers and are documented as not
// profileable), while listProcesses returns them. Mirror the gate's filter.
function hasProfilableProcess(processes: Array<{ detectType: string }>): boolean {
  return processes.some((p) => p.detectType !== 'VIRTUAL');
}

/** The first probed instance that reports a profilable process. OAP refuses a
 *  network task on an instance with none ("The instance doesn't have processes",
 *  EBPFProfilingMutationService) — it gates on the process COUNT, not on the
 *  process topology, which only materializes once those processes have talked to
 *  each other — so the propose path picks with this instead of firing at the
 *  fleet's first instance blind. Never throws. */
export interface ProcessProbeResult {
  /** The instance to target, or null when none of the probed ones qualified. */
  instance: ServiceInstanceInfo | null;
  /** How many were actually probed vs how many exist — a truncated probe must
   *  not be reported as "the fleet has none". */
  checked: number;
  total: number;
  /** Probes whose read FAILED. Distinct from "returned no processes": with even
   *  one failure the negative is not conclusive, so the caller must not present
   *  it as one. */
  failed: number;
  /** Set only when EVERY probe failed — nothing was learned at all. */
  error?: string;
}

/** Does this service have a process that can run eBPF CPU profiling? One exact
 *  query — OAP counts processes advertising SUPPORT_EBPF_PROFILING over the last
 *  10 minutes, which is precisely the gate its own eBPF create-task form uses.
 *
 *  ONLY valid for ON_CPU / OFF_CPU. NETWORK profiling is a weaker requirement —
 *  its create check is `getProcessCount(instanceId)`, which takes any non-virtual
 *  process with no profiling-support filter and no time bucket — so a false here
 *  does NOT mean a network task would be rejected. */
export async function serviceCanEbpfProfile(
  opts: GraphqlOptions,
  serviceId: string,
): Promise<{ could: boolean; error?: string }> {
  try {
    const data = await graphqlPost<{ prepare: { couldProfiling: boolean } | null }>(
      opts,
      QUERY_EBPF_PREPARE,
      { serviceId },
    );
    return { could: !!data.prepare?.couldProfiling };
  } catch (err) {
    return { could: false, error: err instanceof Error ? err.message : String(err) };
  }
}
export async function findInstanceWithProcesses(
  opts: GraphqlOptions,
  instances: ServiceInstanceInfo[],
  offsetMinutes: number,
): Promise<ProcessProbeResult> {
  // Discovery uses its OWN short rolling window, never the chat's range: the
  // assistant's range reaches 7 days, and a process that last reported six days
  // ago is not a live target — pointing a task at its instance would create one
  // against something no longer running. Matches the network task-creation flow,
  // which looks back 30 minutes from now.
  const endMs = Date.now();
  const duration = {
    start: fmtMinute(endMs - PROCESS_PROBE_WINDOW_MIN * 60_000, offsetMinutes),
    end: fmtMinute(endMs, offsetMinutes),
    step: 'MINUTE',
  };
  const probe = instances.slice(0, MAX_PROCESS_PROBES);
  let failed = 0;
  let firstError: string | undefined;
  // Probe in bounded-concurrency batches with an early exit: serial round-trips
  // are what forced the old cap down to a size a real fleet could hide behind.
  for (let i = 0; i < probe.length; i += PROCESS_PROBE_CONCURRENCY) {
    const batch = probe.slice(i, i + PROCESS_PROBE_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (instance) => {
        try {
          const data = await graphqlPost<{ processes: Array<{ id: string; detectType: string }> | null }>(
            opts,
            LIST_INSTANCE_PROCESSES,
            { instanceId: instance.id, duration },
          );
          return { instance, hit: hasProfilableProcess(data.processes ?? []) };
        } catch (err) {
          return { instance, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    for (const r of settled) {
      if ('error' in r && r.error) {
        failed += 1;
        firstError ??= r.error;
      }
    }
    const hit = settled.find((r) => 'hit' in r && r.hit);
    if (hit) return { instance: hit.instance, checked: probe.length, total: instances.length, failed };
  }
  return {
    instance: null,
    checked: probe.length,
    total: instances.length,
    failed,
    ...(probe.length > 0 && failed === probe.length ? { error: firstError ?? 'process lookup failed' } : {}),
  };
}

/** Network profiling's result is a process-conversation graph. Scope it to the
 *  TASK — its own instance and its own execution window, both of which outlive
 *  the chat's time range — and return it as CAPTURED render data; the block
 *  freezes + replays it, never a live tab. With no task, degrade to the live
 *  view: probe instances over the chat window. Empty ⇒ no Rover eBPF agent
 *  reporting for that scope. */
export async function analyzeNetworkProfiling(input: AnalyzeNetworkProfilingInput): Promise<NetworkProfilingResult> {
  const { opts, layerKey, service, window, offsetMinutes } = input;
  const result: NetworkProfilingResult = {
    instanceName: null,
    taskId: null,
    queried: { start: window.start, end: window.end },
    topology: { nodes: [], calls: [], reachable: true },
  };
  const fail = (error: string): NetworkProfilingResult => {
    result.topology.reachable = false;
    result.topology.error = error;
    return result;
  };
  try {
    const serviceId = await resolveServiceId(opts, layerKey, service);
    if (!serviceId) return fail(`Unknown service "${service}" in layer ${layerKey}.`);
    const task = await findNetworkTask(opts, serviceId, input.taskId);
    if (input.taskId && !task) {
      return fail(`No NETWORK profiling task "${input.taskId}" on ${service}.`);
    }
    // A task without an instance or a start time can't scope anything — fall
    // through to the live probe rather than querying a half-known window.
    if (task?.serviceInstanceId && task.taskStartTime > 0) {
      const duration = taskDuration(task, offsetMinutes);
      result.taskId = task.taskId;
      result.instanceName = task.serviceInstanceName;
      result.queried = { start: duration.start, end: duration.end };
      const g = await fetchProcessTopology(opts, task.serviceInstanceId, duration);
      result.topology.nodes = g.nodes;
      result.topology.calls = g.calls;
      return result;
    }
    const insts = await listServiceInstances(opts, serviceId, window);
    if (!insts.length) return result;
    // The process graph is built from ProcessRelation metrics, which OAP
    // persists at MINUTE granularity ONLY (`supportDownSampling = false`), so
    // an HOUR/DAY-stepped chat window reads a bucket that was never written and
    // comes back empty — which we would then report as "no Rover agent". Re-cut
    // the same instant range at MINUTE before probing. The task-scoped path
    // above already builds its own MINUTE window.
    const probeWindow = minuteWindow(input.rangeMs, offsetMinutes);
    result.queried = { start: probeWindow.start, end: probeWindow.end };
    const probe = await probeProcessTopology(opts, insts, probeWindow);
    if (probe.hit) {
      result.instanceName = probe.hit.instance.name;
      result.topology.nodes = probe.hit.nodes;
      result.topology.calls = probe.hit.calls;
      return result;
    }
    return probe.error ? fail(probe.error) : result;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const ENCODED_ID = /^[A-Za-z0-9+/=]+\.\d+$/;

async function resolveServiceId(opts: GraphqlOptions, layerKey: string, serviceArg: string): Promise<string | null> {
  if (ENCODED_ID.test(serviceArg)) return serviceArg;
  const data = await graphqlPost<{ services: Array<{ id: string; name: string }> }>(
    opts,
    LIST_SERVICES_FOR_RESOLVE,
    { layer: layerKey.toUpperCase() },
  );
  return data.services.find((s) => s.name === serviceArg)?.id ?? data.services.find((s) => s.id === serviceArg)?.id ?? null;
}

function frameCount(trees: ProfileAnalyzationTree[]): number {
  return trees.reduce((n, t) => n + t.elements.length, 0);
}

type WireStack = { id: string; parentId: string; symbol: string; dumpCount: number; self: number };
type EbpfStack = { id: string; parentId: string; symbol: string; stackType: string; dumpCount: number };

// pprof / async share the symbol/dumpCount/self element; map dumpCount→count
// (drives flame width) and self→durationChildExcluded (drives the self-time
// highlight), matching the existing per-type composables.
function mapWireTree(elements: WireStack[]): ProfileAnalyzationTree {
  return {
    elements: elements.map(
      (e): ProfileAnalyzationElement => ({
        id: e.id,
        parentId: e.parentId,
        codeSignature: e.symbol,
        count: e.dumpCount,
        duration: e.dumpCount,
        durationChildExcluded: e.self,
      }),
    ),
  };
}

// eBPF has no self-time; every metric is the dump count.
function mapEbpfTree(elements: EbpfStack[]): ProfileAnalyzationTree {
  return {
    elements: elements.map(
      (e): ProfileAnalyzationElement => ({
        id: e.id,
        parentId: e.parentId,
        codeSignature: e.symbol,
        count: e.dumpCount,
        duration: e.dumpCount,
        durationChildExcluded: e.dumpCount,
      }),
    ),
  };
}

// A pprof HEAP / GOROUTINE / ALLOCS / THREADCREATE task is a point-in-time
// snapshot: OAP validates (and the agent honours) `duration` only for CPU /
// BLOCK / MUTEX, so the field lands as 0 for the others. Rendering that as
// "0 min" reads as a task that collected for no time — the opposite of what a
// snapshot event means.
function durationMinLabel(minutes: number | null | undefined): string | null {
  if (minutes == null) return null;
  return minutes > 0 ? `${minutes} min` : 'point-in-time snapshot';
}
function durationSecLabel(seconds: number | null | undefined): string | null {
  return seconds == null ? null : `${seconds} s`;
}

export interface AnalyzeProfilingInput {
  opts: GraphqlOptions;
  profilingType: ProfilingType;
  layerKey: string;
  service: string;
  /** Target a specific task; when absent, the most recent task of this type. */
  taskId?: string;
  /** async only — which captured event to analyze when the task recorded more
   *  than one (its units are not shared, so only one renders per call). Absent
   *  or unrecognised falls back to the task's first event. */
  event?: string;
}

export async function analyzeProfiling(input: AnalyzeProfilingInput): Promise<ProfilingAnalysis> {
  const { opts, profilingType, layerKey, service } = input;
  const base: ProfilingAnalysis = {
    profilingType,
    taskId: input.taskId ?? null,
    trees: [],
    metricKey: 'count',
    tip: null,
    logs: [],
    summary: { service, frameCount: 0 },
    reachable: true,
  };
  try {
    const serviceId = await resolveServiceId(opts, layerKey, service);
    if (!serviceId) {
      base.reachable = false;
      base.error = `Unknown service "${service}" in layer ${layerKey}.`;
      return base;
    }
    switch (profilingType) {
      case 'trace':
        return await analyzeTrace(opts, serviceId, service, input.taskId, base);
      case 'pprof':
        return await analyzeStackList(opts, GET_PPROF_TASK_LIST, GET_PPROF_ANALYZE, GET_PPROF_PROGRESS, serviceId, input.taskId, base, false);
      case 'async':
        return await analyzeStackList(opts, GET_ASYNC_TASK_LIST, GET_ASYNC_ANALYZE, GET_ASYNC_PROGRESS, serviceId, input.taskId, base, true, input.event);
      case 'ebpf':
        return await analyzeEbpf(opts, serviceId, input.taskId, base);
    }
  } catch (err) {
    base.reachable = false;
    base.error = err instanceof Error ? err.message : String(err);
    return base;
  }
}

async function analyzeTrace(
  opts: GraphqlOptions,
  serviceId: string,
  service: string,
  wantTaskId: string | undefined,
  base: ProfilingAnalysis,
): Promise<ProfilingAnalysis> {
  const tl = await graphqlPost<{
    taskList: Array<{ id: string; endpointName: string; startTime: number; duration: number }>;
  }>(opts, GET_PROFILE_TASK_LIST, { serviceId });
  const tasks = tl.taskList ?? [];
  const task = wantTaskId ? tasks.find((t) => t.id === wantTaskId) : tasks[0];
  if (!task) {
    base.error = 'No trace-profiling task found for this service.';
    return base;
  }
  base.taskId = task.id;
  base.summary = {
    service,
    endpoint: task.endpointName || null,
    durationLabel: durationMinLabel(task.duration),
    durationSec: task.duration ? task.duration * 60 : null,
    startTime: task.startTime || null,
    segmentCount: 0,
    frameCount: 0,
  };

  const segs = await graphqlPost<{
    segmentList: Array<{ traceId: string; duration: number; spans: ProfileSpan[] }>;
  }>(opts, GET_PROFILE_TASK_SEGMENTS, { taskID: task.id });
  const segments = segs.segmentList ?? [];
  base.summary.segmentCount = segments.length;

  // Slowest segments first, then ONE analyze query per profiled SEGMENT — which
  // is the granularity OAP stamps `profiled` at (ProfileTaskQueryService marks
  // every span of a profiled segment, it does not select individual spans). One
  // query per span instead asked the same segment N times over sub-ranges of the
  // same snapshot stream: it burned the cap N× faster, and inflated OAP's
  // totalSequenceCount enough to trip its "analyzed only part of the snapshots"
  // tip, which we then relayed as a truncated profile that was never truncated.
  const bySlowest = [...segments].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
  const queries: Array<{ segmentId: string; timeRange: { start: number; end: number } }> = [];
  const seen = new Set<string>();
  outer: for (const seg of bySlowest) {
    const bySegmentId = new Map<string, ProfileSpan[]>();
    for (const span of seg.spans ?? []) {
      if (!span.profiled) continue;
      const list = bySegmentId.get(span.segmentId);
      if (list) list.push(span);
      else bySegmentId.set(span.segmentId, [span]);
    }
    for (const [segmentId, spans] of bySegmentId) {
      if (seen.has(segmentId)) continue;
      seen.add(segmentId);
      queries.push({
        segmentId,
        timeRange: {
          start: Math.min(...spans.map((s) => s.startTime)),
          end: Math.max(...spans.map((s) => s.endTime)),
        },
      });
      if (queries.length >= MAX_TRACE_ANALYZE_QUERIES) break outer;
    }
  }

  // Carry the slowest profiled segment's trace for the waterfall beside the flame.
  const waterfallSeg = bySlowest.find((s) => (s.spans ?? []).some((sp) => sp.profiled));
  if (waterfallSeg) base.traceContext = { traceId: waterfallSeg.traceId, spans: waterfallSeg.spans };

  base.logs = await fetchTraceLogs(opts, task.id);
  if (!queries.length) return base; // task exists but nothing profiled yet

  const an = await graphqlPost<{ analyze: { tip: string | null; trees: ProfileAnalyzationTree[] } | null }>(
    opts,
    GET_PROFILE_ANALYZE,
    { queries },
  );
  base.tip = an.analyze?.tip ?? null;
  base.trees = an.analyze?.trees ?? [];
  base.summary.frameCount = frameCount(base.trees);
  return base;
}

async function fetchTraceLogs(opts: GraphqlOptions, taskId: string): Promise<ProfilingLogLine[]> {
  try {
    const l = await graphqlPost<{ taskLogs: ProfilingLogLine[] }>(opts, GET_PROFILE_TASK_LOGS, { taskID: taskId });
    return l.taskLogs ?? [];
  } catch {
    return [];
  }
}

// pprof + async: one task-list query, one analyze query (with instanceIds and,
// for async, a JFR eventType), one progress query for the logs.
async function analyzeStackList(
  opts: GraphqlOptions,
  listQuery: string,
  analyzeQuery: string,
  progressQuery: string,
  serviceId: string,
  wantTaskId: string | undefined,
  base: ProfilingAnalysis,
  isAsync: boolean,
  wantEvent?: string,
): Promise<ProfilingAnalysis> {
  const key = isAsync ? 'asyncTaskList' : 'pprofTaskList';
  const tl = await graphqlPost<Record<string, { tasks: Array<{ id: string; serviceInstanceIds: string[]; createTime: number; events: string | string[]; duration: number }> } | null>>(
    opts,
    listQuery,
    { request: { serviceId, limit: 500 } },
  );
  const tasks = tl[key]?.tasks ?? [];
  const task = wantTaskId ? tasks.find((t) => t.id === wantTaskId) : tasks[0];
  if (!task) {
    base.error = `No ${base.profilingType}-profiling task found for this service.`;
    return base;
  }
  const events = Array.isArray(task.events) ? task.events : task.events ? [task.events] : [];
  // Computed here, before `summary` is built, so `summary.events[0]` — what
  // `summarizeProfile` reads to label the unit — names the event actually
  // rendered below rather than always the task's first captured one.
  const { primaryEvent, otherEvents } = isAsync
    ? pickAnalyzedEvent(events, wantEvent)
    : { primaryEvent: '', otherEvents: [] as string[] };
  base.taskId = task.id;
  base.summary = {
    service: base.summary.service,
    instances: task.serviceInstanceIds ?? [],
    // ALL captured events, primaryEvent first — `otherEvents` is JFR-deduped
    // (drops CPU-family siblings sharing EXECUTION_SAMPLE) for the RETRY tip
    // below, but the task fact shown to the operator must not lose an event
    // it genuinely captured just because reading it again would be redundant.
    events: isAsync ? summaryEventOrder(events, primaryEvent) : events,
    // Different units on the wire: async-profiler's task duration is seconds,
    // pprof's is minutes (OAP task-creation schemas).
    durationLabel: isAsync ? durationSecLabel(task.duration) : durationMinLabel(task.duration),
    durationSec: task.duration ? (isAsync ? task.duration : task.duration * 60) : null,
    startTime: task.createTime || null,
    frameCount: 0,
  };

  const instanceIds = task.serviceInstanceIds ?? [];
  base.logs = await fetchProgressLogs(opts, progressQuery, task.id);
  if (!instanceIds.length) {
    base.error = 'The task targets no instances — nothing to analyze.';
    return base;
  }
  // ONE capture event per analysis, because the flame merges every tree it is
  // given into a single scale and async-profiler's events do not share a unit:
  // OAP aggregates EXECUTION_SAMPLE by sample count, ALLOC by BYTES and LOCK by
  // NANOSECONDS. Summing those produces percentages of a meaningless total.
  // ALLOC's two TLAB trees ARE merged — both are bytes, and reading only the
  // in-TLAB half silently drops every large-object path.
  const jfrTypes = isAsync ? (ASYNC_EVENT_TO_JFR[primaryEvent] ?? ['EXECUTION_SAMPLE']) : [];
  const requests = isAsync
    ? (jfrTypes.length ? jfrTypes : ['EXECUTION_SAMPLE']).map((eventType) => ({ taskId: task.id, instanceIds, eventType }))
    : [{ taskId: task.id, instanceIds }];
  const results = await Promise.all(
    requests.map((request) =>
      graphqlPost<{ analysisResult: { tree: { elements: WireStack[] } | null } | null }>(opts, analyzeQuery, {
        request,
      }),
    ),
  );
  // OAP merges the dumps under a synthesized zero-sample root, so an uncollected
  // task still analyzes to one all-zero element — that's empty, not a 1-frame profile.
  base.trees = results
    .map((an) => an.analysisResult?.tree?.elements ?? [])
    .filter((elements) => elements.length > 1 && elements.some((e) => e.dumpCount > 0))
    .map((elements) => mapWireTree(elements));
  base.summary.frameCount = frameCount(base.trees);
  if (otherEvents.length) {
    base.tip = `showing the ${primaryEvent} profile only — this task also captured ${otherEvents.join(', ')}, and those use different units (samples / bytes / nanoseconds), so they cannot share one flame. Call analyze_profiling again with event set to one of: ${otherEvents.join(', ')}.`;
  }
  return base;
}

async function fetchProgressLogs(opts: GraphqlOptions, progressQuery: string, taskId: string): Promise<ProfilingLogLine[]> {
  try {
    const p = await graphqlPost<{ taskProgress: { logs: ProfilingLogLine[] } | null }>(opts, progressQuery, { taskId });
    return p.taskProgress?.logs ?? [];
  } catch {
    return [];
  }
}

async function analyzeEbpf(
  opts: GraphqlOptions,
  serviceId: string,
  wantTaskId: string | undefined,
  base: ProfilingAnalysis,
): Promise<ProfilingAnalysis> {
  const tasks = await ebpfTasksBothTriggers<{
    taskId: string;
    targetType: string;
    taskStartTime: number;
    fixedTriggerDuration: number | null;
  }>(opts, { serviceId, targets: ['ON_CPU', 'OFF_CPU'] });
  const task = wantTaskId ? tasks.find((t) => t.taskId === wantTaskId) : tasks[0];
  if (!task) {
    base.error = 'No eBPF-profiling task found for this service.';
    return base;
  }
  base.taskId = task.taskId;
  base.summary = {
    service: base.summary.service,
    events: [task.targetType],
    durationLabel: durationSecLabel(task.fixedTriggerDuration),
    durationSec: task.fixedTriggerDuration || null,
    startTime: task.taskStartTime || null,
    frameCount: 0,
  };

  const sc = await graphqlPost<{ schedules: Array<{ scheduleId: string; startTime: number; endTime: number }> }>(
    opts,
    QUERY_EBPF_SCHEDULES,
    { taskId: task.taskId },
  );
  const allSchedules = sc.schedules ?? [];
  if (!allSchedules.length) return base; // task exists but no schedules collected yet
  // OAP splits every submitted range into 10-second chunks (FETCH_DATA_DURATION)
  // and fetches them in parallel under one deadline; a chunk that misses the
  // deadline is caught, logged and returned EMPTY, and the eBPF analyzer never
  // sets `tip`. So an over-wide request degrades into a silently partial flame
  // presented as the whole profile. Bound what we ask for — most recent
  // schedules first, since those are the ones an investigation is about — and
  // say so when we drop any, rather than letting OAP drop them invisibly.
  const byRecency = [...allSchedules].sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  const schedules: typeof byRecency = [];
  let chunks = 0;
  for (const s of byRecency) {
    const cost = Math.max(1, Math.ceil(((s.endTime ?? 0) - (s.startTime ?? 0)) / EBPF_CHUNK_MS));
    if (chunks + cost > MAX_EBPF_ANALYZE_CHUNKS && schedules.length) break;
    schedules.push(s);
    chunks += cost;
  }
  const truncationTip =
    schedules.length < allSchedules.length
      ? `analyzed the ${schedules.length} most recent of ${allSchedules.length} profiling schedules — the full range exceeds what OAP can fetch in one analysis`
      : null;
  const scheduleIdList = schedules.map((s) => s.scheduleId);
  const timeRanges = schedules.map((s) => ({ start: s.startTime, end: s.endTime }));
  // The aggregate type has to follow the TARGET, because OAP gives the same
  // enum two different meanings: for OFF_CPU, COUNT is "the number of times the
  // process is switched to off cpu by the scheduler" while DURATION is "the
  // total time spent in off cpu". OFF_CPU is chosen precisely to find what
  // BLOCKS a service, so counting switches ranks a frame that yields constantly
  // for microseconds above the one that blocks once for a second — the exact
  // inversion of the question being asked. ON_CPU has no DURATION meaning
  // (COUNT is its dump count), so it stays on COUNT.
  const aggregateType = task.targetType === 'OFF_CPU' ? 'DURATION' : 'COUNT';
  const an = await graphqlPost<{ result: { tip: string | null; trees: Array<{ elements: EbpfStack[] }> } | null }>(
    opts,
    ANALYSIS_EBPF_RESULT,
    { scheduleIdList, timeRanges, aggregateType },
  );
  // OAP's tip is null on the common path and must not erase ours.
  base.tip = [truncationTip, an.result?.tip ?? null].filter(Boolean).join(' · ') || null;
  base.trees = (an.result?.trees ?? []).map((t) => mapEbpfTree(t.elements));
  base.summary.frameCount = frameCount(base.trees);
  return base;
}
