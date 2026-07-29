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
 * Wire types for continuous (auto-triggered) profiling policies — the rules
 * that make OAP start a profiling task BY ITSELF when a process crosses a
 * threshold. Stored per SERVICE, one entry per eBPF target.
 *
 * `setContinuousProfilingPolicy` replaces the WHOLE policy: sending a subset
 * DELETES the rest, so always send the full desired state.
 */

export type ContinuousProfilingTargetType = 'ON_CPU' | 'OFF_CPU' | 'NETWORK';

/** OAP's `ContinuousProfilingMonitorType`, minus the non-selectable UNKNOWN(0). */
export type ContinuousProfilingMonitorType =
  | 'PROCESS_CPU'
  | 'PROCESS_THREAD_COUNT'
  | 'SYSTEM_LOAD'
  | 'HTTP_ERROR_RATE'
  | 'HTTP_AVG_RESPONSE_TIME';

/**
 * One armed condition. `threshold` is a STRING on the wire, but OAP
 * Integer.parseInts it for EVERY monitor type — decimals are rejected at save.
 *
 * `uriList` and `uriRegex` apply only to the HTTP_* types. Nothing upstream
 * rejects a check item carrying both; Rover takes the list and drops the regex.
 */
export interface ContinuousProfilingPolicyItem {
  type: ContinuousProfilingMonitorType;
  threshold: string;
  /** Seconds of metrics to evaluate. */
  period: number;
  /** How many evaluations must match before profiling is triggered. */
  count: number;
  uriList?: string[];
  uriRegex?: string;
}

export interface ContinuousProfilingPolicyTarget {
  type: ContinuousProfilingTargetType;
  checkItems: ContinuousProfilingPolicyItem[];
  /** Read-only: how often this target has fired. Ignored on write. */
  triggeredCount?: number;
  /** Read-only: epoch ms of the last trigger, null if never. Ignored on write. */
  lastTriggerTimestamp?: number | null;
}

export interface ContinuousProfilingPoliciesResponse {
  targets: ContinuousProfilingPolicyTarget[];
  /**
   * Whether any process of this service advertised eBPF-profiling support in
   * the last 10 minutes — a WARNING signal only. A policy may legitimately be
   * armed before the eBPF agent that will satisfy it is deployed, so this never
   * blocks editing or saving. `null` when the probe itself failed, which is not
   * the same as `false`.
   */
  ebpfReporting?: boolean | null;
  reachable: boolean;
  error?: string;
}

export interface ContinuousProfilingPolicyRequest {
  serviceId: string;
  targets: ContinuousProfilingPolicyTarget[];
}

export interface ContinuousProfilingSetResponse {
  /** OAP's own verdict — false means it refused, with `errorReason`. */
  status: boolean;
  errorReason?: string | null;
  reachable: boolean;
  error?: string;
}

/** Trigger counts keyed by target — the ONLY part of a watched row that varies
 *  per target, which is why the row itself is carried once. */
export type TriggersByTarget = Partial<
  Record<ContinuousProfilingTargetType, { count: number; last?: number | null }>
>;

export interface ContinuousProfilingMonitoringProcess {
  id: string;
  name: string;
  detectType: string;
  labels: string[];
  triggers: TriggersByTarget;
}

export interface ContinuousProfilingMonitoringInstance {
  id: string;
  name: string;
  triggers: TriggersByTarget;
  processes: ContinuousProfilingMonitoringProcess[];
}

export interface ContinuousProfilingInstancesResponse {
  /** One row per instance, deduped across targets. OAP builds this list
   *  target-independently (`listProcesses(serviceId, …)` takes no target), so
   *  fetching it once per target would ship the same bytes N times. */
  instances: ContinuousProfilingMonitoringInstance[];
  /** Targets whose counts are folded into `instances[].triggers`. */
  targets: ContinuousProfilingTargetType[];
  /** Totals, so the UI can answer "is it working" without reading every row. */
  summary: {
    instanceCount: number;
    processCount: number;
    /** Instances with at least one trigger on any requested target. */
    triggeredInstanceCount: number;
  };
  reachable: boolean;
  error?: string;
}
