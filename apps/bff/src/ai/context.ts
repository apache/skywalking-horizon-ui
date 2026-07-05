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
 * Per-request context every AI tool closes over. Built once per chat request
 * from the caller's session + config, then threaded into each skill's tool
 * factory. Carries the OAP handle, the resolved time window, the verb-gate,
 * and — critically — the SSE emitters: a render tool pushes its FIGURE to the
 * stream out-of-band (`emitFigure`) and returns only a terse text summary to
 * the model, so figures reach the UI in the model's narration order without
 * bloating the token stream.
 */

import type { FetchLike, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { GraphqlOptions } from '../client/graphql.js';
import type { ConfigSource } from '../config/loader.js';
import type { Window } from '../util/window.js';
import type {
  ChatFigure,
  DeploymentSpec,
  EndpointDependencySpec,
  FigureXAxis,
  HierarchySpec,
  InstanceTopologySpec,
  PodLogSpec,
  ProposalSpec,
  BrowserErrorsSpec,
  LogsSpec,
  SubPageSpec,
  TopologySpec,
  TracesSpec,
  ZipkinTracesSpec,
} from './types.js';

export interface AiRequestContext {
  config: ConfigSource;
  fetch?: FetchLike;
  /** OAP UI-template client — resolve the in-use (remote) layer templates the
   *  metric catalog reads. Absent when the admin surface isn't wired (tests). */
  uiTemplateClient?: () => UITemplateClient;
  /** OAP GraphQL handle for the tool layer (the only OAP path AI tools use). */
  opts: GraphqlOptions;
  /** OAP-server-local Duration window for MQE execution. */
  window: Window;
  /** Epoch-ms mirror of `window`, for figure x-axis synthesis in the panel. */
  range: FigureXAxis;
  /** Dashboard widget metric fan-out size (config.performance.bulk.dashboard). */
  bulkSize: number;
  /** Caller's roles — every tool checks its own read verb before touching OAP,
   *  so the agent inherits the caller's read scopes and never widens them. */
  hasVerb(verb: string): boolean;
  /** Queue/emit a figure. With a `group` label, consecutive figures sharing it
   *  are buffered and flushed as ONE tabbed figure block (the "figures 2–5,
   *  tab-based" UX); without a group, any pending group is flushed first and
   *  this figure emits on its own. The running figure number is owned here. */
  emitFigure(fig: { title?: string; figures: ChatFigure[]; group?: string }): void;
  /** Mount an embeddable feature view (topology/deployment/service-list) inline
   *  in the chat. Params only — the UI view fetches its own data over the chat's
   *  range; verb-gated in the tool like every other read. */
  emitSubPage(spec: SubPageSpec): void;
  /** Propose a mutating action (profiling) as a decision card — the agent never
   *  fires it; the user approves/dismisses in the UI, which then calls the
   *  existing verb-gated create route. */
  emitProposal(spec: ProposalSpec): void;
  /** Mount a LIVE-TAIL pod-log pane inline. Carries the resolved pod/container +
   *  an initial snapshot; the UI pane re-polls OAP on an interval to fetch newer
   *  lines (on-demand logs are a live tail, not a one-shot figure). Verb-gated
   *  (logs:read) in the tool like every other read. */
  emitPodLogs(spec: PodLogSpec): void;
  /** Render a service's cross-layer hierarchy inline (the topology page's
   *  Smartscape overlay as a chat block). Verb-gated (topology:read) in the tool. */
  emitHierarchy(spec: HierarchySpec): void;
  /** Render a service's FOCUSED one-hop dependency topology inline (the ego
   *  graph: focus + direct callers + direct dependencies). Verb-gated
   *  (topology:read) in the tool. */
  emitTopology(spec: TopologySpec): void;
  /** Mount the per-service Deployment view inline (read-only): the instance-to-
   *  instance call graph within one service. Verb-gated (topology:read). */
  emitDeployment(spec: DeploymentSpec): void;
  /** Mount the per-pair Instance-topology view inline (read-only): the instances
   *  of a source (client) + dest (server) service and the calls between them.
   *  Verb-gated (topology:read). */
  emitInstanceTopology(spec: InstanceTopologySpec): void;
  /** Mount the per-endpoint API-dependency view inline (read-only): the focused
   *  endpoint's upstream/downstream dependency chain. Verb-gated (topology:read). */
  emitEndpointDependency(spec: EndpointDependencySpec): void;
  /** Mount the native Traces view inline (read-only, focused on a service);
   *  the UI keeps its list→waterfall interaction. Verb-gated (traces:read). */
  emitTraces(spec: TracesSpec): void;
  /** Mount the Zipkin Traces view inline (read-only, focused on a Zipkin service
   *  name); the UI runs the Zipkin query. Verb-gated (traces:read). */
  emitZipkinTraces(spec: ZipkinTracesSpec): void;
  /** Mount the layer Logs view inline (read-only, focused on a service); the UI
   *  keeps its log-row→detail interaction. Verb-gated (logs:read). */
  emitLogs(spec: LogsSpec): void;
  /** Mount the browser-monitoring error list inline (read-only, focused on a
   *  browser app); the UI keeps its error→stack detail. Verb-gated
   *  (browser-errors:read). */
  emitBrowserErrors(spec: BrowserErrorsSpec): void;
  /** Emit any buffered figure group now. The agent calls this before narration
   *  tokens (so a group closes when the model resumes prose) and at stream end. */
  flushFigures(): void;
  /** Push a tool-status event (running/done/denied) for the panel's activity line. */
  emitTool(name: string, status: 'running' | 'done' | 'denied'): void;
}
