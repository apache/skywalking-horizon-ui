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
 * Figure buffering for tab-grouping. Consecutive figures sharing a `group`
 * accumulate into ONE tabbed figure block; the group flushes when a different
 * (or absent) group arrives, when the agent resumes narration (`flushFigures`),
 * or at stream end. A single ungrouped figure emits immediately. The figure
 * counter lives here so numbering is consistent across singles and groups.
 */

import type {
  ChatFigure,
  DeploymentSpec,
  EndpointDependencySpec,
  HierarchySpec,
  InstanceTopologySpec,
  PodLogSpec,
  ProposalSpec,
  SseEvent,
  BrowserErrorsSpec,
  LogsSpec,
  SubPageSpec,
  TopologySpec,
  TracesSpec,
  ZipkinTracesSpec,
} from './types.js';

export interface FigureBuffer {
  emitFigure(fig: { title?: string; figures: ChatFigure[]; group?: string }): void;
  /** Emit a sub-page block (topology/deployment/…). Shares the figure number
   *  sequence; closes any pending figure group first so ordering is preserved. */
  emitSubPage(spec: SubPageSpec): void;
  /** Emit a proposed-action decision card. Same numbering; flushes first. */
  emitProposal(spec: ProposalSpec): void;
  /** Emit a live-tail pod-log pane. Same numbering; flushes any pending group. */
  emitPodLogs(spec: PodLogSpec): void;
  /** Emit a cross-layer hierarchy block. Same numbering; flushes any pending group. */
  emitHierarchy(spec: HierarchySpec): void;
  /** Emit a one-hop ego-topology block. Same numbering; flushes any pending group. */
  emitTopology(spec: TopologySpec): void;
  /** Emit a mounted Deployment view block. Same numbering; flushes any pending group. */
  emitDeployment(spec: DeploymentSpec): void;
  /** Emit a mounted instance-topology view block. Same numbering; flushes any group. */
  emitInstanceTopology(spec: InstanceTopologySpec): void;
  /** Emit a mounted endpoint-dependency view block. Same numbering; flushes any group. */
  emitEndpointDependency(spec: EndpointDependencySpec): void;
  /** Emit a mounted Traces view block. Same numbering; flushes any pending group. */
  emitTraces(spec: TracesSpec): void;
  /** Emit a mounted Zipkin Traces view block. Same numbering; flushes any group. */
  emitZipkinTraces(spec: ZipkinTracesSpec): void;
  /** Emit a mounted Logs view block. Same numbering; flushes any pending group. */
  emitLogs(spec: LogsSpec): void;
  /** Emit a mounted browser-errors view block. Same numbering; flushes any group. */
  emitBrowserErrors(spec: BrowserErrorsSpec): void;
  flushFigures(): void;
}

export function createFigureBuffer(send: (ev: SseEvent) => void): FigureBuffer {
  let figureN = 0;
  let pending: { key: string; title?: string; figures: ChatFigure[] } | null = null;

  const flushFigures = (): void => {
    if (!pending) return;
    const { title, figures } = pending;
    pending = null;
    send({ type: 'figure', n: ++figureN, title, layout: figures.length > 1 ? 'tabs' : 'single', figures });
  };

  const emitFigure: FigureBuffer['emitFigure'] = ({ title, figures, group }) => {
    if (group) {
      if (pending && pending.key !== group) flushFigures();
      if (!pending) pending = { key: group, title, figures: [] };
      if (!pending.title && title) pending.title = title;
      pending.figures.push(...figures);
    } else {
      flushFigures();
      send({ type: 'figure', n: ++figureN, title, layout: figures.length > 1 ? 'tabs' : 'single', figures });
    }
  };

  const emitSubPage = (spec: SubPageSpec): void => {
    flushFigures();
    send({ type: 'subpage', n: ++figureN, spec });
  };

  const emitProposal = (spec: ProposalSpec): void => {
    flushFigures();
    send({ type: 'proposal', n: ++figureN, spec });
  };

  const emitPodLogs = (spec: PodLogSpec): void => {
    flushFigures();
    send({ type: 'podlogs', n: ++figureN, spec });
  };

  const emitHierarchy = (spec: HierarchySpec): void => {
    flushFigures();
    send({ type: 'hierarchy', n: ++figureN, spec });
  };

  const emitTopology = (spec: TopologySpec): void => {
    flushFigures();
    send({ type: 'topology', n: ++figureN, spec });
  };

  const emitDeployment = (spec: DeploymentSpec): void => {
    flushFigures();
    send({ type: 'deployment', n: ++figureN, spec });
  };

  const emitInstanceTopology = (spec: InstanceTopologySpec): void => {
    flushFigures();
    send({ type: 'instance-topology', n: ++figureN, spec });
  };

  const emitEndpointDependency = (spec: EndpointDependencySpec): void => {
    flushFigures();
    send({ type: 'endpoint-dependency', n: ++figureN, spec });
  };

  const emitTraces = (spec: TracesSpec): void => {
    flushFigures();
    send({ type: 'traces', n: ++figureN, spec });
  };

  const emitZipkinTraces = (spec: ZipkinTracesSpec): void => {
    flushFigures();
    send({ type: 'zipkin-traces', n: ++figureN, spec });
  };

  const emitLogs = (spec: LogsSpec): void => {
    flushFigures();
    send({ type: 'logs', n: ++figureN, spec });
  };

  const emitBrowserErrors = (spec: BrowserErrorsSpec): void => {
    flushFigures();
    send({ type: 'browser-errors', n: ++figureN, spec });
  };

  return {
    emitFigure,
    emitSubPage,
    emitProposal,
    emitPodLogs,
    emitHierarchy,
    emitTopology,
    emitDeployment,
    emitInstanceTopology,
    emitEndpointDependency,
    emitTraces,
    emitZipkinTraces,
    emitLogs,
    emitBrowserErrors,
    flushFigures,
  };
}
