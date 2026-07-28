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
const ASYNC_EVENT_TO_JFR: Record<string, string> = {
  CPU: 'EXECUTION_SAMPLE',
  WALL: 'EXECUTION_SAMPLE',
  CTIMER: 'EXECUTION_SAMPLE',
  ITIMER: 'EXECUTION_SAMPLE',
  LOCK: 'LOCK',
  ALLOC: 'OBJECT_ALLOCATION_IN_NEW_TLAB',
};

// Cap the trace analyze fan-out: each profiled span becomes one analyze query,
// and OAP snapshots the request (returns `tip` when it only analyzes part). We
// take the slowest segments first so the busiest call paths dominate the flame.
const MAX_TRACE_ANALYZE_QUERIES = 100;

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

// OAP sorts tasks createTime-descending, so [0] is the most recent. triggerType
// is sent explicitly even though OAP defaults a missing one to FIXED_TIME
// (EBPFProcessProfilingQuery.queryEBPFProfilingTasks) — network tasks ARE stored
// as FIXED_TIME (EBPFProfilingMutationService.createTask), and stating it keeps
// the filter from silently changing if that default ever moves.
async function findNetworkTask(
  opts: GraphqlOptions,
  serviceId: string,
  wantTaskId: string | undefined,
): Promise<NetworkTask | null> {
  const tl = await graphqlPost<{ tasks: NetworkTask[] }>(opts, QUERY_EBPF_TASKS, {
    serviceId,
    targets: ['NETWORK'],
    triggerType: 'FIXED_TIME',
  });
  const tasks = tl.tasks ?? [];
  return (wantTaskId ? tasks.find((t) => t.taskId === wantTaskId) : tasks[0]) ?? null;
}

// A task's data only exists for the span it ran, on the instance it watched. A
// still-running (keep-alive) task reports no duration — read it up to now, the
// same rule the network-profiling view applies.
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
    const probe = await probeProcessTopology(opts, insts, window);
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

function durationMinLabel(minutes: number | null | undefined): string | null {
  return minutes == null ? null : `${minutes} min`;
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
        return await analyzeStackList(opts, GET_ASYNC_TASK_LIST, GET_ASYNC_ANALYZE, GET_ASYNC_PROGRESS, serviceId, input.taskId, base, true);
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
    startTime: task.startTime || null,
    segmentCount: 0,
    frameCount: 0,
  };

  const segs = await graphqlPost<{
    segmentList: Array<{ traceId: string; duration: number; spans: ProfileSpan[] }>;
  }>(opts, GET_PROFILE_TASK_SEGMENTS, { taskID: task.id });
  const segments = segs.segmentList ?? [];
  base.summary.segmentCount = segments.length;

  // Slowest segments first, then one analyze query per profiled span, capped.
  const bySlowest = [...segments].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
  const queries: Array<{ segmentId: string; timeRange: { start: number; end: number } }> = [];
  for (const seg of bySlowest) {
    for (const span of seg.spans ?? []) {
      if (!span.profiled) continue;
      queries.push({ segmentId: span.segmentId, timeRange: { start: span.startTime, end: span.endTime } });
      if (queries.length >= MAX_TRACE_ANALYZE_QUERIES) break;
    }
    if (queries.length >= MAX_TRACE_ANALYZE_QUERIES) break;
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
  base.taskId = task.id;
  base.summary = {
    service: base.summary.service,
    instances: task.serviceInstanceIds ?? [],
    events,
    // Different units on the wire: async-profiler's task duration is seconds,
    // pprof's is minutes (OAP task-creation schemas).
    durationLabel: isAsync ? durationSecLabel(task.duration) : durationMinLabel(task.duration),
    startTime: task.createTime || null,
    frameCount: 0,
  };

  const instanceIds = task.serviceInstanceIds ?? [];
  base.logs = await fetchProgressLogs(opts, progressQuery, task.id);
  if (!instanceIds.length) {
    base.error = 'The task targets no instances — nothing to analyze.';
    return base;
  }
  const request = isAsync
    ? { taskId: task.id, instanceIds, eventType: ASYNC_EVENT_TO_JFR[events[0]] ?? 'EXECUTION_SAMPLE' }
    : { taskId: task.id, instanceIds };
  const an = await graphqlPost<{ analysisResult: { tree: { elements: WireStack[] } | null } | null }>(
    opts,
    analyzeQuery,
    { request },
  );
  // OAP merges the dumps under a synthesized zero-sample root, so an uncollected
  // task still analyzes to one all-zero element — that's empty, not a 1-frame profile.
  const elements = an.analysisResult?.tree?.elements ?? [];
  const collected = elements.length > 1 && elements.some((e) => e.dumpCount > 0);
  base.trees = collected ? [mapWireTree(elements)] : [];
  base.summary.frameCount = frameCount(base.trees);
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
  const tl = await graphqlPost<{
    tasks: Array<{ taskId: string; targetType: string; taskStartTime: number; fixedTriggerDuration: number | null }>;
  }>(opts, QUERY_EBPF_TASKS, { serviceId, targets: ['ON_CPU', 'OFF_CPU'], triggerType: 'FIXED_TIME' });
  const tasks = tl.tasks ?? [];
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
    startTime: task.taskStartTime || null,
    frameCount: 0,
  };

  const sc = await graphqlPost<{ schedules: Array<{ scheduleId: string; startTime: number; endTime: number }> }>(
    opts,
    QUERY_EBPF_SCHEDULES,
    { taskId: task.taskId },
  );
  const schedules = sc.schedules ?? [];
  if (!schedules.length) return base; // task exists but no schedules collected yet
  const scheduleIdList = schedules.map((s) => s.scheduleId);
  const timeRanges = schedules.map((s) => ({ start: s.startTime, end: s.endTime }));
  const an = await graphqlPost<{ result: { tip: string | null; trees: Array<{ elements: EbpfStack[] }> } | null }>(
    opts,
    ANALYSIS_EBPF_RESULT,
    { scheduleIdList, timeRanges, aggregateType: 'COUNT' },
  );
  base.tip = an.result?.tip ?? null;
  base.trees = (an.result?.trees ?? []).map((t) => mapEbpfTree(t.elements));
  base.summary.frameCount = frameCount(base.trees);
  return base;
}
