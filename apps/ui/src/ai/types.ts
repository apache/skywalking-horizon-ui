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
import type { DashboardWidget, DashboardWidgetResult } from '@skywalking-horizon-ui/api-client';

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

// A sub-page figure: a feature view surfaced as a card that opens the real full
// page in a new tab. Graph/triage views (topology, deployment, traces, logs,
// browser errors) embed inline via their own specs; this is the remaining
// link-out (the layer service list).
export type SubPageKind = 'service-list';

export interface SubPageSpec {
  kind: SubPageKind;
  title: string;
  layer: string;
  service?: string;
  range: FigureXAxis;
}

// A proposed mutating action (profiling) — a decision card the user approves in
// a popout; the agent never fires it. Carries the reasoning it must justify.
export interface ProposalSpec {
  kind: 'profiling';
  profilingType: 'trace';
  layer: string;
  serviceId: string;
  service: string;
  endpoint?: string;
  durationMinutes: number;
  cause: string;
  rationale: string;
  expectation: string;
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
}

// A mounted native Traces view (real feature view, embedded read-only) focused
// on a service. The UI view fetches its own traces + keeps its list→waterfall.
export interface TracesSpec {
  title: string;
  layer: string;
  service: string;
  serviceId?: string;
  windowMinutes?: number;
}

// A mounted Zipkin Traces view (real feature view, embedded read-only) focused on
// a ZIPKIN service name (matched via list_zipkin_services — differs from the
// SkyWalking name). The UI view runs the Zipkin query + keeps its list→waterfall.
export interface ZipkinTracesSpec {
  title: string;
  layer: string;
  service: string;
  windowMinutes?: number;
}

// A mounted layer Logs view (real feature view, embedded read-only) focused on a
// service. The UI view fetches its own log stream + keeps its row→detail.
export interface LogsSpec {
  title: string;
  layer: string;
  service: string;
  serviceId?: string;
  windowMinutes?: number;
}

// A mounted browser-monitoring error list (real feature view, embedded
// read-only) focused on a browser app; keeps its row→stack detail.
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

export type ProposalStatus = 'pending' | 'approved' | 'dismissed' | 'failed';

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'figure'; n: number; title?: string; layout: FigureLayout; figures: ChatFigure[] }
  | { kind: 'subpage'; n: number; spec: SubPageSpec }
  | { kind: 'proposal'; n: number; spec: ProposalSpec; status: ProposalStatus; taskId?: string; error?: string }
  | { kind: 'podlogs'; n: number; spec: PodLogSpec }
  | { kind: 'hierarchy'; n: number; spec: HierarchySpec }
  | { kind: 'topology'; n: number; spec: TopologySpec }
  | { kind: 'deployment'; n: number; spec: DeploymentSpec }
  | { kind: 'instance-topology'; n: number; spec: InstanceTopologySpec }
  | { kind: 'endpoint-dependency'; n: number; spec: EndpointDependencySpec }
  | { kind: 'traces'; n: number; spec: TracesSpec }
  | { kind: 'zipkin-traces'; n: number; spec: ZipkinTracesSpec }
  | { kind: 'logs'; n: number; spec: LogsSpec }
  | { kind: 'browser-errors'; n: number; spec: BrowserErrorsSpec }
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
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
