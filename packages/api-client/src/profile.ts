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
 * Wire-level types for the BFF's profile (trace-driven thread profiling) routes.
 *
 * Mirrors the OAP query-protocol `ProfileTask*` / `Segments*` shape; field names
 * are kept identical so downstream code can pass payloads straight through.
 */

export interface ProfileTaskLog {
  id: string;
  instanceId: string;
  instanceName: string;
  operationType: string;
  operationTime: number;
}

export interface ProfileTask {
  id: string;
  serviceId: string;
  serviceName?: string;
  endpointName: string;
  startTime: number;
  duration: number;
  minDurationThreshold: number;
  dumpPeriod: number;
  maxSamplingCount: number;
  logs?: ProfileTaskLog[];
}

export interface ProfileTaskListResponse {
  tasks: ProfileTask[];
  reachable: boolean;
  error?: string;
}

export interface ProfileTaskLogsResponse {
  logs: ProfileTaskLog[];
  reachable: boolean;
  error?: string;
}

export interface ProfileSpanRef {
  traceId: string;
  parentSegmentId: string;
  parentSpanId: number;
  type: string;
}

export interface ProfileSpanTag {
  key: string;
  value: string;
}

export interface ProfileSpanLogData {
  key: string;
  value: string;
}

export interface ProfileSpanLog {
  time: number;
  data: ProfileSpanLogData[];
}

export interface ProfileSpan {
  spanId: number;
  parentSpanId: number;
  segmentId: string;
  refs?: ProfileSpanRef[];
  serviceCode: string;
  serviceInstanceName: string;
  startTime: number;
  endTime: number;
  endpointName: string;
  type: string;
  peer: string;
  component: string;
  isError: boolean;
  layer: string;
  tags?: ProfileSpanTag[];
  logs?: ProfileSpanLog[];
  profiled: boolean;
  /** Convenience copy from the containing segment (BFF-attached). */
  traceId?: string;
  /** Recursive child spans assembled client-side. */
  children?: ProfileSpan[];
}

export interface ProfileSegment {
  traceId: string;
  instanceId: string;
  instanceName: string;
  endpointNames: string[];
  duration: number;
  start: string;
  isError?: boolean;
  spans: ProfileSpan[];
}

export interface ProfileSegmentsResponse {
  segments: ProfileSegment[];
  reachable: boolean;
  error?: string;
}

export interface ProfileAnalyzationElement {
  id: string;
  parentId: string;
  codeSignature: string;
  duration: number;
  durationChildExcluded: number;
  count: number;
}

export interface ProfileAnalyzationTree {
  elements: ProfileAnalyzationElement[];
}

export interface ProfileAnalyzationResponse {
  tip: string | null;
  trees: ProfileAnalyzationTree[];
  reachable: boolean;
  error?: string;
}

export interface ProfileTimeRange {
  start: number;
  end: number;
}

export interface ProfileAnalyzeQuery {
  segmentId: string;
  timeRange: ProfileTimeRange;
}

export interface ProfileTaskCreationRequest {
  serviceId: string;
  endpointName: string;
  /** OMIT to start ASAP. OAP's schema: "if null means the task starts ASAP,
   *  otherwise the task begin after the startTime(based on agent side time)" —
   *  so a value here is compared against clocks we do not own (OAP dispatches
   *  only tasks starting within ±5 minutes of ITS clock). Send one only when
   *  the caller genuinely means "start later". */
  startTime?: number;
  duration: number;
  minDurationThreshold: number;
  dumpPeriod: number;
  maxSamplingCount: number;
}

export interface ProfileTaskCreationResponse {
  id?: string;
  errorReason?: string;
  reachable: boolean;
  error?: string;
}
