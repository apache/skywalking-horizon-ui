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
 * BFF→panel streaming wire contract for the AI assistant. Mirrors the UI's
 * `apps/ui/src/ai/types.ts` (kept in lockstep by hand — the block shapes aren't in
 * the shared api-client; `DashboardWidget`/`DashboardWidgetResult` are). A
 * figure carries a dashboard widget spec + its resolved result so the panel
 * renders it with the SAME widget components the dashboards use.
 */

import type {
  BrowserErrorsResponse,
  DashboardWidget,
  DashboardWidgetResult,
  DeploymentResponse,
  EndpointDependencyResponse,
  InstanceTopologyResponse,
  LogsResponse,
  ProcessTopologyResponse,
  ProfileAnalyzationTree,
  ServiceHierarchyResponse,
  TopologyResponse,
  TraceListResponse,
  ZipkinTraceListResponse,
} from '@skywalking-horizon-ui/api-client';
import type { ProfilingLogLine, ProfilingSummary, ProfilingType, TraceContext } from '../../logic/oap/profiling.js';

export type FigureLayout = 'single' | 'tabs' | 'stack' | 'grid';

/** Epoch-ms + step to synthesise line x-labels (series carry bucket values, no timestamps). */
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

/** A PROPOSED mutating action (profiling / live-debug). The agent never fires
 *  it — it presents a decision card (what it found, why this action, what it
 *  expects) and the user approves or dismisses in a popout. On approve the UI
 *  calls the existing verb-gated create route; on dismiss nothing happens. */
/** The five profiling flavors an agent can propose (network adds to the four
 *  flame-analysable ones — its result is a process topology, not a flame). */
export type ProfilingProposalType = 'trace' | 'async' | 'pprof' | 'ebpf' | 'network';

export interface ProposalSpec {
  kind: 'profiling';
  profilingType: ProfilingProposalType;
  layer: string;
  serviceId: string;
  service: string;
  /** Agent-facing collection window; the card converts it to each type's unit
   *  (trace/pprof minutes, async/eBPF seconds, network none). */
  durationMinutes: number;
  /** trace — the endpoint to sample. */
  endpoint?: string;
  /** async / pprof / network — target instance ids the tool resolved server-side. */
  instanceIds?: string[];
  /** Display label for the resolved instances ("3 instances" / a single name). */
  instanceLabel?: string;
  /** async (multi) / pprof (single) — profiling events, e.g. ['CPU']. */
  events?: string[];
  /** eBPF — ON_CPU / OFF_CPU + optional process-label filter (empty ⇒ all). */
  targetType?: 'ON_CPU' | 'OFF_CPU';
  processLabels?: string[];
  /** The analyzed cause so far — what the investigation found. */
  cause: string;
  /** Why this action is the right next step. */
  rationale: string;
  /** What the action is expected to reveal / confirm. */
  expectation: string;
}

/** A captured, frozen network process-conversation graph (network profiling's
 *  result). ProcessTopologyGraph is a stateless renderer, so the block replays
 *  `replayData` directly — no re-query. Emitted only when processes exist; an
 *  absent Rover/eBPF agent is said out in text instead. */
export interface ProcessTopologySpec {
  title: string;
  layer: string;
  service: string;
  instanceName: string | null;
  replayData: ProcessTopologyResponse;
}

/** A captured, frozen profiling result — analyzed flame `trees` + task facts +
 *  logs. Renders the Profiling-tab flame from `trees`; never re-queries on
 *  reload (empty `trees` = nothing collected yet). */
export interface ProfilingResultSpec {
  title: string;
  profilingType: ProfilingType;
  layer: string;
  service: string;
  taskId: string | null;
  /** The flame input — every profiling flavor mapped to the one render shape. */
  trees: ProfileAnalyzationTree[];
  metricKey: 'count' | 'duration';
  /** OAP's partial-data notice, when the snapshot was only partly analyzed. */
  tip?: string | null;
  logs: ProfilingLogLine[];
  summary: ProfilingSummary;
  /** trace only — the profiled segment's trace, rendered as a span waterfall
   *  beside the flame (the trace+profiling combination). */
  traceContext?: TraceContext;
  reachable: boolean;
  error?: string | null;
}

/** One line of on-demand pod-log output. `timestamp` is epoch-ms (OAP reports
 *  seconds; the BFF normalises), or null when OAP omitted it. */
export interface PodLogLine {
  content: string;
  timestamp: number | null;
}

/** The lines the assistant fetched from a pod container's on-demand logs,
 *  rendered inline in the chat as a read-only result. On-demand logs are never
 *  stored, so this is the exact window returned at fetch time — the block does
 *  NOT re-poll (a live tail lives in the Pod Logs tab). The feature is OAP-gated
 *  (enableOnDemandPodLog); `keywordsOfContent`/`excludingKeywordsOfContent`
 *  record the content filter that was applied, and `errorReason` carries the
 *  "enable it in OAP" hint (or a stale-pod reason) when the container can't be
 *  read. */
export interface PodLogSpec {
  title: string;
  service?: string;
  /** Pod (ServiceInstance) display name, when known. */
  pod?: string;
  container: string;
  keywordsOfContent?: string[];
  excludingKeywordsOfContent?: string[];
  initialLines: PodLogLine[];
  errorReason?: string | null;
}

/** One cross-layer hierarchy peer — the same logical service projected into
 *  another layer (a K8S_SERVICE ↔ its GENERAL/MESH mirror ↔ its backing infra
 *  layer). `role: 'self'` is the focused service; `normal:false` marks a virtual
 *  peer (rendered dashed, like the topology overlay). */
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
/** A rendered cross-layer service HIERARCHY (the topology page's Smartscape
 *  overlay, inline in the chat): the focus service + its peers grouped by layer.
 *  Emitted by show_hierarchy from getServiceHierarchy. */
export interface HierarchySpec {
  title: string;
  layer: string;
  service: string;
  serviceId: string;
  groups: HierarchyGroup[];
  reachable: boolean;
  errorReason?: string | null;
  /** The captured raw hierarchy (the overlay's native shape). Present ⇒ the
   *  embedded overlay SEEDS from it and never re-queries — a reloaded fan
   *  replays statically. `groups` stays for the LLM text summary. */
  replayData?: ServiceHierarchyResponse;
}

/** A direct neighbour of the focus service in the one-hop ego topology.
 *  `isReal:false` is a conjectural node (untraced DB / cache / MQ / external),
 *  rendered dashed; `type` is its component when OAP resolved one; `layer` is
 *  its own layer (may differ from the focus for a cross-layer edge). */
export interface TopoPeer {
  id: string;
  name: string;
  isReal: boolean;
  type?: string | null;
  layer?: string | null;
}
/** A rendered FOCUSED one-hop dependency topology (the ego graph) inline in the
 *  chat: the focus service + its direct upstream callers and downstream
 *  dependencies. NOT the whole-layer map. Emitted by show_topology. */
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
  /** The captured, render-ready graph (nodes+edges WITH metric values + edge
   *  series). When present the embedded view SEEDS from it and never re-queries
   *  OAP — so a reloaded conversation replays the exact point-in-time map + its
   *  edge part-graphs. Absent (too-large / degrade) ⇒ the view live-fetches. */
  replayData?: TopologyResponse;
}

/** A mounted DEPLOYMENT view — the real per-service instance-to-instance call
 *  graph embedded read-only, focused on a service. Carries the resolved
 *  serviceId (the deployment query is keyed on it) so the UI never re-resolves.
 *  The UI view fetches its own graph and keeps its pan/zoom + edge/node detail. */
export interface DeploymentSpec {
  title: string;
  layer: string;
  service: string;
  serviceId: string;
  windowMinutes?: number;
  /** Captured render-ready graph (instances + intra-service edges WITH metric
   *  values + twin edge series). Present ⇒ the embedded view seeds statically
   *  and replays the edge part-graphs on reload; absent ⇒ live fetch. */
  replayData?: DeploymentResponse;
}

/** A mounted INSTANCE-TOPOLOGY view — the real per-pair instance map embedded
 *  read-only: the instances of a SOURCE (client) service and a DEST (server)
 *  service as two columns, with the instance-to-instance calls between them.
 *  Carries both resolved service ids (the query keys on them). The two services
 *  must have a call relationship (client → server) or the map is empty. */
export interface InstanceTopologySpec {
  title: string;
  layer: string;
  clientService: string;
  clientServiceId: string;
  serverService: string;
  serverServiceId: string;
  windowMinutes?: number;
  /** Captured render-ready pair map (instances + edges WITH metric values +
   *  twin edge series). Present ⇒ replay statically + edge part-graphs. */
  replayData?: InstanceTopologyResponse;
}

/** A mounted ENDPOINT-DEPENDENCY view — the real per-endpoint API-dependency
 *  graph embedded read-only, focused on a service. The embedded view auto-picks
 *  the service's top endpoint and draws its upstream/downstream dependency chain.
 *  Carries the resolved serviceId; the UI view keeps its expand + node/edge
 *  detail. */
export interface EndpointDependencySpec {
  title: string;
  layer: string;
  service: string;
  serviceId: string;
  windowMinutes?: number;
  /** Captured render-ready chain (endpoints + edges WITH metric values + edge
   *  series). The response's `endpointId` PINS which endpoint was drawn, so a
   *  reload replays the SAME chain — not the now-busiest endpoint. */
  replayData?: EndpointDependencyResponse;
}

/** A mounted TRACES view — the real native Traces view embedded read-only in
 *  the chat, focused on a service. Params only; the UI view fetches its own
 *  traces over its own range and keeps its list→waterfall interaction. */
export interface TracesSpec {
  title: string;
  layer: string;
  service: string;
  serviceId?: string;
  windowMinutes?: number;
  /** Captured native trace list (rows carry inline spans on v2). Replay renders
   *  it frozen; v1 detail (no inline spans) is disabled offline. */
  replayData?: TraceListResponse;
}

/** A mounted ZIPKIN TRACES view — the real Zipkin trace view embedded read-only,
 *  focused on a ZIPKIN service name (span localEndpoint.serviceName, matched via
 *  list_zipkin_services — it differs from the SkyWalking name). No serviceId:
 *  Zipkin has its own global service universe. The UI view runs the Zipkin query
 *  and keeps its list→waterfall interaction. */
export interface ZipkinTracesSpec {
  title: string;
  layer: string;
  service: string;
  windowMinutes?: number;
  /** Captured Zipkin trace list WITH spans, so a reload replays the waterfall offline. */
  replayData?: ZipkinTraceListResponse;
}

/** A mounted LOGS view — the real layer Logs view embedded read-only, focused on
 *  a service. The UI view fetches its own log stream + keeps its row→detail. */
export interface LogsSpec {
  title: string;
  layer: string;
  service: string;
  serviceId?: string;
  windowMinutes?: number;
  /** Captured log rows — self-contained (detail/facets are client-side). */
  replayData?: LogsResponse;
}

/** A mounted BROWSER-ERRORS view — the real browser-monitoring error list
 *  embedded read-only, focused on a browser app. The UI view fetches its own
 *  errors + keeps its row→stack-detail interaction. */
export interface BrowserErrorsSpec {
  title: string;
  layer: string;
  service: string;
  serviceId?: string;
  windowMinutes?: number;
  /** Captured error rows — self-contained (stack/detail are client-side). */
  replayData?: BrowserErrorsResponse;
}

/**
 * One zone of rendered output in the conversation — what the assistant SHOWS
 * instead of describing. A chart, a topology map, a flame graph, a trace list,
 * a log stream, or the profiling decision card.
 *
 * "Graphic" here means rendered UI rather than prose: the list kinds (traces,
 * logs, browser errors, pod logs) and the proposal card are included even
 * though they are not pictures, because they occupy the same kind of zone and
 * follow the same capture rule.
 *
 * Self-contained: each `spec` carries the frozen `replayData` it was built
 * from, so it draws identically later without re-querying OAP.
 *
 * This is the half both consumers share. The chat panel streams them; an MCP
 * caller collects them.
 */
export type GraphicCard =
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
  | { type: 'browser-errors'; n: number; spec: BrowserErrorsSpec };

/**
 * What travels down the chat panel's SSE stream: the render blocks above plus
 * the control events streaming needs. MCP carries no control events — a tool
 * call returns once — which is why the two are separate types rather than one
 * union with variants that are meaningless to half the callers.
 */
export type StreamEvent =
  | GraphicCard
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'done' | 'denied' }
  | { type: 'error'; message: string }
  | { type: 'done' };

/**
 * A tool's own declaration that it draws a card.
 *
 * Set as the tool's `metadata`, so the fact lives ON the tool rather than in a
 * list somewhere else that has to be kept in step. Consumers that need to know
 * — `tools/list` decides which tools point a host at the `ui://` renderer —
 * read it back from the built tool.
 *
 * There is no structural signal to derive this from, which is why it has to be
 * stated at all: the `visualization` skill contains `list_zipkin_services`,
 * which draws nothing, while `analyze_profiling` draws a flame graph from
 * `triggers`. A name prefix is no better.
 */
export const EMITS_CARD = { emitsCard: true } as const;

/**
 * Does this built tool declare that it draws a card?
 *
 * Read defensively because `StructuredToolInterface` does not expose
 * `metadata` in its type, although `tool()` accepts it and the instance
 * carries it — verified at runtime rather than assumed. A tool that declares
 * nothing reads as false, which is the safe direction: the pointer is an
 * optimisation, and omitting it costs a host one prefetch it did not need.
 */
export function emitsCard(tool: unknown): boolean {
  const meta = (tool as { metadata?: Record<string, unknown> } | null)?.metadata;
  return meta?.emitsCard === true;
}
