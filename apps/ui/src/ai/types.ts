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

// AI-assistant wire + client model. SseEvent is the BFF→panel streaming contract; a
// figure carries a dashboard widget spec + resolved result (drawn with the same widgets).
import type {
  DashboardWidget,
  DashboardWidgetResult,
  DeploymentResponse,
  EndpointDependencyResponse,
  InstanceTopologyResponse,
  ProfileAnalyzationTree,
  ServiceHierarchyResponse,
  TopologyResponse,
  TraceListResponse,
  ZipkinTraceListResponse,
  LogsResponse,
  BrowserErrorsResponse,
  ProcessTopologyResponse,
  ProfileSpan,
} from '@skywalking-horizon-ui/api-client';

export type FigureLayout = 'single' | 'tabs' | 'stack' | 'grid';

// Epoch-ms + step to synthesise line x-labels (series carry bucket values, no timestamps).
export interface FigureXAxis {
  startMs: number;
  endMs: number;
  step: 'MINUTE' | 'HOUR' | 'DAY';
}

export interface ChatFigure {
  spec: DashboardWidget;
  result: DashboardWidgetResult;
  xaxis?: FigureXAxis;
}

// A proposed mutating action (profiling) — a decision card the user approves in
// a popout; the agent never fires it. Carries the reasoning it must justify plus
// the type-specific params the approve handler fires with. Mirror of BFF ProposalSpec.
export type ProfilingProposalType = 'trace' | 'async' | 'pprof' | 'ebpf' | 'network';
export interface ProposalSpec {
  kind: 'profiling';
  profilingType: ProfilingProposalType;
  layer: string;
  serviceId: string;
  service: string;
  durationMinutes: number;
  endpoint?: string;
  instanceIds?: string[];
  instanceLabel?: string;
  events?: string[];
  targetType?: 'ON_CPU' | 'OFF_CPU';
  processLabels?: string[];
  cause: string;
  rationale: string;
  expectation: string;
}

// Mirror of the BFF profiling analysis shapes (apps/bff/.../logic/oap/profiling.ts).
export type ProfilingType = 'trace' | 'pprof' | 'async' | 'ebpf';
export interface ProfilingLogLine {
  instanceName: string;
  operationType: string;
  operationTime: number;
}
export interface ProfilingSummary {
  service: string;
  endpoint?: string | null;
  instances?: string[];
  events?: string[];
  durationLabel?: string | null;
  startTime?: number | null;
  segmentCount?: number | null;
  frameCount: number;
}
// A captured, frozen profiling result — the flame trees + task facts; renders
// statically from `trees` and never re-queries (an empty trees is "no data yet").
export interface ProfilingResultSpec {
  title: string;
  profilingType: ProfilingType;
  layer: string;
  service: string;
  taskId: string | null;
  trees: ProfileAnalyzationTree[];
  metricKey: 'count' | 'duration';
  tip?: string | null;
  logs: ProfilingLogLine[];
  summary: ProfilingSummary;
  // trace only — the profiled segment's trace, rendered as a span waterfall
  // beside the flame (the trace+profiling combination).
  traceContext?: { traceId: string; spans: ProfileSpan[] };
  reachable: boolean;
  error?: string | null;
}

// A captured network process-conversation graph (network profiling's result).
// ProcessTopologyGraph is a stateless renderer, so the block replays replayData
// directly — no re-query. Mirror of the BFF spec.
export interface ProcessTopologySpec {
  title: string;
  layer: string;
  service: string;
  instanceName: string | null;
  replayData: ProcessTopologyResponse;
}

// One line of on-demand pod-log output. `timestamp` is epoch-ms (or null).
export interface PodLogLine {
  content: string;
  timestamp: number | null;
}

// The lines the assistant fetched from a pod container's on-demand logs, rendered
// inline as a read-only result. On-demand logs are never stored, so this is the
// exact window returned at fetch time — the block does NOT re-poll (a live tail
// lives in the Pod Logs tab). `keywordsOfContent`/`excludingKeywordsOfContent`
// record the content filter that was applied (shown so an empty result reads as
// "nothing matched", not "silent pod"); `errorReason` carries the "enable it in
// OAP" hint (or a stale-pod reason) when the container can't be read.
export interface PodLogSpec {
  title: string;
  service?: string;
  pod?: string;
  container: string;
  keywordsOfContent?: string[];
  excludingKeywordsOfContent?: string[];
  initialLines: PodLogLine[];
  errorReason?: string | null;
}

// A cross-layer service hierarchy (the topology page's Smartscape overlay) drawn
// inline: the focused service + the same logical service projected into other
// layers, grouped by layer. `role: 'self'` is the focus; `normal:false` is a
// virtual peer (dashed). Static one-shot — no re-poll.
export interface HierarchyPeer {
  id: string;
  name: string;
  normal: boolean;
  role: 'self' | 'upper' | 'lower';
}
export interface HierarchyGroup {
  layer: string;
  peers: HierarchyPeer[];
}
export interface HierarchySpec {
  title: string;
  layer: string;
  service: string;
  serviceId: string;
  groups: HierarchyGroup[];
  reachable: boolean;
  errorReason?: string | null;
  /** Captured raw hierarchy (the overlay's native shape). Present ⇒ the embedded
   *  overlay seeds from it and never re-queries — a reloaded fan replays static. */
  replayData?: ServiceHierarchyResponse;
}

// A focused one-hop ego topology drawn inline: the focus service + its DIRECT
// upstream callers and DIRECT downstream dependencies. `isReal:false` is a
// conjectural node (untraced DB / cache / MQ / external), rendered dashed.
export interface TopoPeer {
  id: string;
  name: string;
  isReal: boolean;
  type?: string | null;
  layer?: string | null;
}
export interface TopologySpec {
  title: string;
  layer: string;
  service: string;
  serviceId: string;
  upstream: TopoPeer[];
  downstream: TopoPeer[];
  reachable: boolean;
  errorReason?: string | null;
  /** The chat window (minutes) the ego graph was resolved over, so the embedded
   *  map re-queries the SAME window — not the global topbar picker. */
  windowMinutes?: number;
  /** Captured render-ready graph (nodes+edges WITH metric values + edge series).
   *  Present ⇒ the embedded map SEEDS from it and never re-queries OAP, so a
   *  reloaded conversation replays the exact map + edge part-graphs statically. */
  replayData?: TopologyResponse;
}

// A mounted Deployment view (real feature view, embedded read-only) focused on a
// service — the instance-to-instance call graph within it. Carries the resolved
// serviceId (the deployment query keys on it). The UI view fetches its own graph.
export interface DeploymentSpec {
  title: string;
  layer: string;
  service: string;
  serviceId: string;
  windowMinutes?: number;
  /** Captured render-ready graph (instances + edges WITH values + edge series).
   *  Present ⇒ replay statically + the edge part-graphs. */
  replayData?: DeploymentResponse;
}

// A mounted instance-topology view (real feature view, embedded read-only) for a
// source (client) → dest (server) service PAIR: the instances of each and the
// calls between them. Carries both resolved service ids.
export interface InstanceTopologySpec {
  title: string;
  layer: string;
  clientService: string;
  clientServiceId: string;
  serverService: string;
  serverServiceId: string;
  windowMinutes?: number;
  /** Captured render-ready pair map (instances + edges WITH values + edge series).
   *  Present ⇒ replay statically + the edge part-graphs. */
  replayData?: InstanceTopologyResponse;
}

// A mounted endpoint-dependency view (real feature view, embedded read-only)
// focused on a service — auto-picks its top endpoint and draws that endpoint's
// upstream/downstream dependency chain. Carries the resolved serviceId.
export interface EndpointDependencySpec {
  title: string;
  layer: string;
  service: string;
  serviceId: string;
  windowMinutes?: number;
  /** Captured render-ready chain (endpoints + edges WITH values + edge series);
   *  its `endpointId` PINS which endpoint was drawn so a reload replays the SAME
   *  chain, not the now-busiest endpoint. */
  replayData?: EndpointDependencyResponse;
}

// A mounted native Traces view (real feature view, embedded read-only) focused
// on a service. The UI view fetches its own traces + keeps its list→waterfall.
export interface TracesSpec {
  title: string;
  layer: string;
  service: string;
  serviceId?: string;
  windowMinutes?: number;
  replayData?: TraceListResponse;
}

// A mounted Zipkin Traces view (real feature view, embedded read-only) focused on
// a ZIPKIN service name (matched via list_zipkin_services — differs from the
// SkyWalking name). The UI view runs the Zipkin query + keeps its list→waterfall.
export interface ZipkinTracesSpec {
  title: string;
  layer: string;
  service: string;
  windowMinutes?: number;
  replayData?: ZipkinTraceListResponse;
}

// A mounted layer Logs view (real feature view, embedded read-only) focused on a
// service. The UI view fetches its own log stream + keeps its row→detail.
export interface LogsSpec {
  title: string;
  layer: string;
  service: string;
  serviceId?: string;
  windowMinutes?: number;
  replayData?: LogsResponse;
}

// A mounted browser-monitoring error list (real feature view, embedded
// read-only) focused on a browser app; keeps its row→stack detail.
export interface BrowserErrorsSpec {
  title: string;
  layer: string;
  service: string;
  serviceId?: string;
  windowMinutes?: number;
  replayData?: BrowserErrorsResponse;
}

export type SseEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'done' | 'denied' }
  | { type: 'figure'; n: number; title?: string; layout: FigureLayout; figures: ChatFigure[] }
  | { type: 'proposal'; n: number; spec: ProposalSpec }
  | { type: 'profiling'; n: number; spec: ProfilingResultSpec }
  | { type: 'process-topology'; n: number; spec: ProcessTopologySpec }
  | { type: 'podlogs'; n: number; spec: PodLogSpec }
  | { type: 'hierarchy'; n: number; spec: HierarchySpec }
  | { type: 'topology'; n: number; spec: TopologySpec }
  | { type: 'deployment'; n: number; spec: DeploymentSpec }
  | { type: 'instance-topology'; n: number; spec: InstanceTopologySpec }
  | { type: 'endpoint-dependency'; n: number; spec: EndpointDependencySpec }
  | { type: 'traces'; n: number; spec: TracesSpec }
  | { type: 'zipkin-traces'; n: number; spec: ZipkinTracesSpec }
  | { type: 'logs'; n: number; spec: LogsSpec }
  | { type: 'browser-errors'; n: number; spec: BrowserErrorsSpec }
  | { type: 'error'; message: string }
  | { type: 'done' };

/**
 * `proposed` is the REPLAY state: a captured proposal, shown as the case it
 * made, with no decision attached and no actions offered. It exists because a
 * frozen card has no live conversation to approve into — and because the
 * template's catch-all reads any unknown status as a failure, so a card that
 * merely could not be acted on was announcing that profiling had gone wrong.
 */
export type ProposalStatus = 'pending' | 'approved' | 'dismissed' | 'failed' | 'proposed';

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'figure'; n: number; title?: string; layout: FigureLayout; figures: ChatFigure[]; capturedAt?: number }
  | { kind: 'proposal'; n: number; spec: ProposalSpec; status: ProposalStatus; taskId?: string; error?: string }
  | { kind: 'profiling'; n: number; spec: ProfilingResultSpec; capturedAt?: number }
  | { kind: 'process-topology'; n: number; spec: ProcessTopologySpec; capturedAt?: number }
  | { kind: 'podlogs'; n: number; spec: PodLogSpec; capturedAt?: number }
  | { kind: 'hierarchy'; n: number; spec: HierarchySpec; capturedAt?: number }
  | { kind: 'topology'; n: number; spec: TopologySpec; capturedAt?: number }
  | { kind: 'deployment'; n: number; spec: DeploymentSpec; capturedAt?: number }
  | { kind: 'instance-topology'; n: number; spec: InstanceTopologySpec; capturedAt?: number }
  | { kind: 'endpoint-dependency'; n: number; spec: EndpointDependencySpec; capturedAt?: number }
  | { kind: 'traces'; n: number; spec: TracesSpec; capturedAt?: number }
  | { kind: 'zipkin-traces'; n: number; spec: ZipkinTracesSpec; capturedAt?: number }
  | { kind: 'logs'; n: number; spec: LogsSpec; capturedAt?: number }
  | { kind: 'browser-errors'; n: number; spec: BrowserErrorsSpec; capturedAt?: number }
  | { kind: 'tool'; name: string; status: 'running' | 'done' | 'denied' };

export type FigureBlock = Extract<Block, { kind: 'figure' }>;
export type ProposalBlock = Extract<Block, { kind: 'proposal' }>;
export type PodLogsBlock = Extract<Block, { kind: 'podlogs' }>;
export type HierarchyBlock = Extract<Block, { kind: 'hierarchy' }>;
export type TopologyBlock = Extract<Block, { kind: 'topology' }>;
export type DeploymentBlock = Extract<Block, { kind: 'deployment' }>;
export type InstanceTopologyBlock = Extract<Block, { kind: 'instance-topology' }>;
export type EndpointDependencyBlock = Extract<Block, { kind: 'endpoint-dependency' }>;
export type TracesBlock = Extract<Block, { kind: 'traces' }>;
export type ZipkinTracesBlock = Extract<Block, { kind: 'zipkin-traces' }>;
export type LogsBlock = Extract<Block, { kind: 'logs' }>;
export type BrowserErrorsBlock = Extract<Block, { kind: 'browser-errors' }>;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: Block[];
  streaming?: boolean;
  /** The user stopped this answer mid-stream (ESC / Stop). */
  interrupted?: boolean;
  /** Epoch ms — user turn: when it was sent; assistant turn: when the reply
   *  finished streaming. Optional: messages persisted before this field
   *  existed have none, and render without a timestamp. */
  at?: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
