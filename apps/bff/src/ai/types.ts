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
 * `ai/types.ts` (kept in lockstep by hand — the AI-specific shapes aren't in
 * the shared api-client; `DashboardWidget`/`DashboardWidgetResult` are). A
 * figure carries a dashboard widget spec + its resolved result so the panel
 * renders it with the SAME widget components the dashboards use.
 */

import type { DashboardWidget, DashboardWidgetResult } from '@skywalking-horizon-ui/api-client';

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

/** A "sub-page" figure: a feature view surfaced as a card that opens the real
 *  full page in a new tab. Graph/triage views (topology, deployment, traces,
 *  logs, browser errors) now embed inline via their own specs; this is the
 *  remaining link-out (the layer service list). */
export type SubPageKind = 'service-list';

export interface SubPageSpec {
  kind: SubPageKind;
  title: string;
  layer: string;
  service?: string;
  range: FigureXAxis;
}

/** A PROPOSED mutating action (profiling / live-debug). The agent never fires
 *  it — it presents a decision card (what it found, why this action, what it
 *  expects) and the user approves or dismisses in a popout. On approve the UI
 *  calls the existing verb-gated create route; on dismiss nothing happens. */
export interface ProposalSpec {
  /** Extensible; profiling first. */
  kind: 'profiling';
  /** trace-profiling for now. */
  profilingType: 'trace';
  layer: string;
  serviceId: string;
  service: string;
  endpoint?: string;
  durationMinutes: number;
  /** The analyzed cause so far — what the investigation found. */
  cause: string;
  /** Why this action is the right next step. */
  rationale: string;
  /** What the action is expected to reveal / confirm. */
  expectation: string;
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
}

/** A mounted LOGS view — the real layer Logs view embedded read-only, focused on
 *  a service. The UI view fetches its own log stream + keeps its row→detail. */
export interface LogsSpec {
  title: string;
  layer: string;
  service: string;
  serviceId?: string;
  windowMinutes?: number;
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
}

export type SseEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'done' | 'denied' }
  | { type: 'figure'; n: number; title?: string; layout: FigureLayout; figures: ChatFigure[] }
  | { type: 'subpage'; n: number; spec: SubPageSpec }
  | { type: 'proposal'; n: number; spec: ProposalSpec }
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
