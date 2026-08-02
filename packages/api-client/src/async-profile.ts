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
 * Async profiler (Java) + pprof (Go) wire types.
 *
 * Async profiler events: CPU, ALLOC, LOCK, WALL, CTIMER, ITIMER.
 * The result graph has multiple `tree` entries — one per distinct
 * JFR event type. The viewer flame-graphs the currently-selected tree.
 *
 * pprof has the same task/progress/analyze shape as async profiler but
 * for Go binaries; the BFF and UI re-use the same payload structures.
 */

export type AsyncProfilingEvent = 'CPU' | 'ALLOC' | 'LOCK' | 'WALL' | 'CTIMER' | 'ITIMER';
export type AsyncJFREventType =
  | 'EXECUTION_SAMPLE'
  | 'LOCK'
  | 'OBJECT_ALLOCATION_IN_NEW_TLAB'
  | 'OBJECT_ALLOCATION_OUTSIDE_TLAB'
  | 'PROFILER_LIVE_OBJECT';

export interface AsyncProfilingTask {
  id: string;
  serviceId: string;
  serviceInstanceIds: string[];
  createTime: number;
  events: AsyncProfilingEvent[];
  duration: number;
  execArgs?: string;
}

export interface AsyncProfilingProgressLog {
  id: string;
  instanceId: string;
  instanceName: string;
  operationType: string;
  operationTime: number;
}

export interface AsyncProfilingProgress {
  logs: AsyncProfilingProgressLog[];
  errorInstanceIds: string[];
  successInstanceIds: string[];
}

export interface AsyncProfilingStackElement {
  id: string;
  parentId: string;
  symbol: string;
  dumpCount: number;
  self: number;
}

export interface AsyncProfilingTree {
  type: AsyncJFREventType;
  elements: AsyncProfilingStackElement[];
}

export interface AsyncProfilingTaskCreationRequest {
  serviceId: string;
  serviceInstanceIds: string[];
  duration: number;
  events: AsyncProfilingEvent[];
  execArgs?: string;
}

export interface AsyncProfilingTaskListResponse {
  tasks: AsyncProfilingTask[];
  /** The service had at least one more task than the limit allowed. OAP's
   *  task-list query reports no count, so this says there IS more, never how
   *  much more. */
  truncated: boolean;
  errorReason?: string;
  reachable: boolean;
  error?: string;
}
export interface AsyncProfilingProgressResponse {
  progress: AsyncProfilingProgress | null;
  reachable: boolean;
  error?: string;
}
export interface AsyncProfilingAnalyzeResponse {
  tree: AsyncProfilingTree | null;
  reachable: boolean;
  error?: string;
}
export interface AsyncProfilingTaskCreationResponse {
  id?: string;
  code?: string;
  errorReason?: string;
  reachable: boolean;
  error?: string;
}

// ── pprof (Go) — parallel shape with distinct types so we can keep
// the two task lists separate even when they appear side-by-side.

export interface PprofTask {
  id: string;
  serviceId: string;
  serviceInstanceIds: string[];
  createTime: number;
  // OAP's `PprofEventType` is a single scalar enum (not a list, unlike
  // async-profiler) — one event per pprof task: CPU / HEAP / BLOCK /
  // MUTEX / GOROUTINE / ALLOCS / THREADCREATE.
  events: string;
  duration?: number;
  dumpPeriod?: number;
}
export interface PprofProgress {
  logs: AsyncProfilingProgressLog[];
  errorInstanceIds: string[];
  successInstanceIds: string[];
}
export interface PprofStackElement {
  id: string;
  parentId: string;
  symbol: string;
  dumpCount: number;
  self: number;
}
export interface PprofTree {
  elements: PprofStackElement[];
}
export interface PprofTaskCreationRequest {
  serviceId: string;
  serviceInstanceIds: string[];
  // duration is required for CPU / BLOCK / MUTEX; dumpPeriod for BLOCK /
  // MUTEX. Omit them for the events that don't use them.
  duration?: number;
  events: string;
  dumpPeriod?: number;
}
export interface PprofTaskListResponse {
  tasks: PprofTask[];
  /** The service had at least one more task than the limit allowed. OAP's
   *  task-list query reports no count, so this says there IS more, never how
   *  much more. */
  truncated: boolean;
  errorReason?: string;
  reachable: boolean;
  error?: string;
}
export interface PprofProgressResponse {
  progress: PprofProgress | null;
  reachable: boolean;
  error?: string;
}
export interface PprofAnalyzeResponse {
  tree: PprofTree | null;
  reachable: boolean;
  error?: string;
}
export interface PprofTaskCreationResponse {
  id?: string;
  code?: string;
  errorReason?: string;
  reachable: boolean;
  error?: string;
}
