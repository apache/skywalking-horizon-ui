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
 * Wire types for the Virtual GenAI evaluation-record page.
 *
 * This is intentionally generic today: the current BFF endpoint is
 * backed by OAP's standard record read path, so the UI only receives
 * the generic `Record` fields. The dedicated page exists so the
 * backend can later grow a richer evaluation-specific query without
 * changing the route again.
 */

export interface EvaluationRecordQueryRequest {
  service?: string;
  serviceId?: string | null;
  serviceInstanceId?: string | null;
  traceId?: string | null;
  tags?: Array<{ key: string; value: string }>;
  page?: number;
  pageSize?: number;
  windowMinutes?: number;
  startTime?: string;
  endTime?: string;
}

export interface EvaluationRecordRow {
  traceId: string | null;
  serviceId: string | null;
  serviceInstanceId: string | null;
  segmentId: string | null;
  spanId: string | null;
  spanType: string | null;
  taskName: string | null;
  valueType: string | null;
  value: string | null;
  evaluationLevel: string | null;
  reason: string | null;
  judgeModel: string | null;
  evaluationTime: number;
}

export interface EvaluationRecordsResponse {
  generatedAt: number;
  query: EvaluationRecordQueryRequest;
  total: number;
  records: EvaluationRecordRow[];
  reachable: boolean;
  errorReason?: string;
  error?: string;
}

export interface EvaluationRecordFacetsResponse {
  generatedAt: number;
  total: number;
  sampled: number;
  level: Record<'fail' | 'warning' | 'good' | 'excellent' | 'undefined', number>;
  services: Array<{ name: string; count: number }>;
  reachable: boolean;
  error?: string;
}
