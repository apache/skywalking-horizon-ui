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
 * eBPF profiling wire types — both CPU (ON_CPU / OFF_CPU) and network
 * profiling reuse the bulk of this shape, so they share one module.
 */

export type EBPFTargetType = 'ON_CPU' | 'OFF_CPU' | 'NETWORK';
export type EBPFTriggerType = 'FIXED_TIME' | 'CONTINUOUS_PROFILING';
export type EBPFAggregateType = 'COUNT' | 'DURATION';

export interface EBPFContinuousCause {
  type: string;
  singleValue?: { threshold: number; current: number };
  uri?: { uriRegex: string; uriPath: string; threshold: number; current: number };
  message?: string;
}

export interface EBPFTask {
  taskId: string;
  serviceName: string;
  serviceId: string;
  serviceInstanceId?: string;
  serviceInstanceName?: string;
  processLabels: string[];
  processName?: string;
  processId?: string;
  taskStartTime: number;
  triggerType: EBPFTriggerType;
  fixedTriggerDuration?: number;
  targetType: EBPFTargetType;
  createTime?: number;
  continuousProfilingCauses?: EBPFContinuousCause[];
}

export interface EBPFProcess {
  id: string;
  name: string;
  serviceId?: string;
  serviceName?: string;
  instanceId?: string;
  instanceName?: string;
  agentId?: string;
  detectType?: string;
  attributes?: { name: string; value: string }[];
  labels?: string[];
}

export interface EBPFSchedule {
  scheduleId: string;
  taskId: string;
  process: EBPFProcess;
  startTime: number;
  endTime: number;
}

export interface EBPFStackElement {
  id: string;
  parentId: string;
  symbol: string;
  stackType: string;
  dumpCount: number;
}

export interface EBPFAnalysisTree {
  elements: EBPFStackElement[];
}

export interface EBPFTaskCreationRequest {
  serviceId: string;
  processLabels: string[];
  startTime: number;
  /** Duration in **seconds** (different to trace profiling — uses minutes). */
  duration: number;
  targetType: EBPFTargetType;
}

export interface EBPFTaskCreationResult {
  status: boolean;
  errorReason?: string;
  id?: string;
}

export interface EBPFTaskListResponse {
  tasks: EBPFTask[];
  couldProfiling: boolean;
  processLabels: string[];
  reachable: boolean;
  error?: string;
}

export interface EBPFSchedulesResponse {
  schedules: EBPFSchedule[];
  reachable: boolean;
  error?: string;
}

export interface EBPFAnalyzeRequest {
  scheduleIdList: string[];
  timeRanges: { start: number; end: number }[];
  aggregateType: EBPFAggregateType;
}

export interface EBPFAnalyzeResponse {
  tip: string | null;
  trees: EBPFAnalysisTree[];
  reachable: boolean;
  error?: string;
}

export interface EBPFTaskCreationResponse {
  status: boolean;
  errorReason?: string;
  id?: string;
  reachable: boolean;
  error?: string;
}

export interface ProcessNode {
  id: string;
  name: string;
  isReal: boolean;
  serviceName: string;
  serviceId: string;
  serviceInstanceId: string;
  serviceInstanceName: string;
}

export interface ProcessCall {
  id: string;
  source: string;
  target: string;
  detectPoints: string[];
  sourceComponents?: string[];
  targetComponents?: string[];
}

export interface ProcessTopologyResponse {
  nodes: ProcessNode[];
  calls: ProcessCall[];
  reachable: boolean;
  error?: string;
}

/** A rover-monitored process on a service instance. Network profiling
 *  targets the whole instance; this list confirms it has profilable
 *  processes (OAP rejects a network task on an instance with none). */
export interface NetworkProcess {
  id: string;
  name: string;
}
export interface NetworkProcessesResponse {
  processes: NetworkProcess[];
  reachable: boolean;
  error?: string;
}

export interface NetworkProfilingSampling {
  uriRegex?: string;
  when4xx?: boolean;
  when5xx?: boolean;
  minDuration?: number;
  /** Mirrors OAP's `EBPFNetworkDataCollectingSettings` input. The two
   *  require flags are non-null on the OAP side (`Boolean!`); the max
   *  sizes are optional caps — omit to collect the whole request/
   *  response. */
  settings: {
    requireCompleteRequest: boolean;
    requireCompleteResponse: boolean;
    maxRequestSize?: number;
    maxResponseSize?: number;
  };
}

export interface NetworkProfilingCreateRequest {
  instanceId: string;
  samplings: NetworkProfilingSampling[];
}

export interface NetworkProfilingCreateResponse {
  status: boolean;
  errorReason?: string;
  id?: string;
  reachable: boolean;
  error?: string;
}

export interface NetworkProfilingKeepAliveResponse {
  status: boolean;
  errorReason?: string;
  reachable: boolean;
  error?: string;
}
