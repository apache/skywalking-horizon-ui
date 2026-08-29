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

import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useAutoRefreshSubscribe } from '../../controls/useAutoRefreshSubscribe';
import { bffClient } from '@/api/client';
import type {
  EvaluationRecordFacetsResponse,
  EvaluationRecordRow,
  EvaluationRecordsResponse,
  LogKeyValue,
} from '@/api/client';

export interface GenAIEvaluationRecordStreamRow {
  serviceName: string | null;
  serviceId: string | null;
  serviceInstanceName: string | null;
  serviceInstanceId: string | null;
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  modelName: string | null;
  operationName: string | null;
  scoreValue: number | null;
  evaluationLevel: string | null;
  judgeModel: string | null;
  taskName: string | null;
  valueType: string | null;
  endpointName: string | null;
  endpointId: string | null;
  traceId: string | null;
  traceType: 'SKYWALKING_NATIVE' | 'OTLP' | null;
  timestamp: number;
  contentType: string;
  content: string;
  tags: LogKeyValue[];
}

export interface GenAIEvaluationRecordSummary {
  name: string;
  id: string;
  value: string;
  refId: string | null;
}

export interface EvaluationRecordParams {
  service: Ref<string | null>;
  serviceId?: Ref<string | null>;
  providerId?: Ref<string | null>;
  modelId?: Ref<string | null>;
  valueType?: Ref<'SCORE' | 'BOOLEAN' | 'STRING' | 'JSON' | null>;
  minScore?: Ref<number | null>;
  maxScore?: Ref<number | null>;
  booleanValue?: Ref<boolean | null>;
  taskName?: Ref<string | null>;
  evaluationLevel?: Ref<string | null>;
  judgeModel?: Ref<string | null>;
  sortField?: Ref<'EVALUATION_TIME' | 'SCORE_VALUE'>;
  sortOrder?: Ref<'ASC' | 'DES'>;
  traceId?: Ref<string | null>;
  traceType?: Ref<'SKYWALKING_NATIVE' | 'OTLP' | null>;
  keywords?: Ref<string[]>;
  page: Ref<number>;
  pageSize: Ref<number>;
  windowMinutes?: Ref<number>;
  startTime?: Ref<number | null>;
  endTime?: Ref<number | null>;
}

export function useLayerEvaluationRecord(layerKey: Ref<string>, params: EvaluationRecordParams) {
  const q = useQuery<EvaluationRecordsResponse>({
    queryKey: [
      'layer-evaluation-record',
      layerKey,
      params.service,
      params.serviceId ?? computed(() => null),
      params.providerId ?? computed(() => null),
      params.modelId ?? computed(() => null),
      params.valueType ?? computed(() => 'SCORE'),
      params.minScore ?? computed(() => null),
      params.maxScore ?? computed(() => null),
      params.booleanValue ?? computed(() => null),
      params.taskName ?? computed(() => null),
      params.evaluationLevel ?? computed(() => null),
      params.judgeModel ?? computed(() => null),
      params.sortField ?? computed(() => 'EVALUATION_TIME'),
      params.sortOrder ?? computed(() => 'DES'),
      params.traceId ?? computed(() => null),
      params.traceType ?? computed(() => null),
      params.page,
      params.pageSize,
      params.windowMinutes ?? computed(() => 0),
      params.startTime ?? computed(() => null),
      params.endTime ?? computed(() => null),
    ],
    queryFn: () =>
      bffClient.evaluationRecord.list(layerKey.value, {
        ...(params.serviceId?.value ? { serviceId: params.serviceId.value } : {}),
        ...(params.providerId?.value ? { providerId: params.providerId.value } : {}),
        ...(params.modelId?.value ? { modelId: params.modelId.value } : {}),
        ...(params.valueType?.value ? { valueType: params.valueType.value } : {}),
        ...(params.valueType?.value === 'SCORE' && params.minScore?.value != null ? { minScore: params.minScore.value } : {}),
        ...(params.valueType?.value === 'SCORE' && params.maxScore?.value != null ? { maxScore: params.maxScore.value } : {}),
        ...(params.valueType?.value === 'BOOLEAN' && params.booleanValue?.value != null ? { booleanValue: params.booleanValue.value } : {}),
        ...(params.taskName?.value ? { taskName: params.taskName.value } : {}),
        ...(params.evaluationLevel?.value ? { evaluationLevel: params.evaluationLevel.value } : {}),
        ...(params.judgeModel?.value ? { judgeModel: params.judgeModel.value } : {}),
        ...(params.sortField?.value ? { sortField: params.sortField.value } : {}),
        ...(params.sortOrder?.value ? { sortOrder: params.sortOrder.value } : {}),
        ...(params.traceId?.value ? { traceId: params.traceId.value } : {}),
        ...(params.traceType?.value ? { traceType: params.traceType.value } : {}),
        ...(params.windowMinutes?.value ? { windowMinutes: params.windowMinutes.value } : {}),
        ...(params.startTime?.value && params.endTime?.value
          ? { startTime: params.startTime.value, endTime: params.endTime.value }
          : {}),
        page: params.page.value,
        pageSize: params.pageSize.value,
      }),
    enabled: computed(() => layerKey.value.length > 0),
    staleTime: 15_000,
  });
  useAutoRefreshSubscribe(() => q.refetch());

  function displayValue(row: EvaluationRecordRow): string {
    if (row.valueType === 'SCORE') {
      return row.scoreValue == null ? '' : String(row.scoreValue);
    }
    if (row.valueType === 'BOOLEAN') {
      return row.booleanValue == null ? '' : String(row.booleanValue);
    }
    return row.stringValue ?? '';
  }

  function toGenAIEvaluationRecordStreamRow(
    row: EvaluationRecordRow,
  ): GenAIEvaluationRecordStreamRow {
    const rawTags: Array<{ key: string; value: string | null }> = [
      { key: 'segment_id', value: row.traceRef?.segmentId ?? null },
      { key: 'span_id', value: row.traceRef?.spanId ?? null },
      { key: 'trace_type', value: row.traceRef?.type ?? null },
      { key: 'task_name', value: row.taskName },
      { key: 'evaluation_level', value: row.evaluationLevel },
      { key: 'value_type', value: row.valueType },
      { key: 'reason', value: row.reason },
      { key: 'judge_model', value: row.judgeModel },
    ];
    const tags = rawTags.filter((tag): tag is LogKeyValue => tag.value != null && tag.value.length > 0);

    return {
      serviceName: row.serviceName,
      serviceId: row.serviceId,
      serviceInstanceName: null,
      serviceInstanceId: null,
      providerId: row.providerId,
      providerName: row.providerName,
      modelId: row.modelId,
      modelName: row.modelName,
      operationName: row.operationName,
      scoreValue: row.scoreValue,
      evaluationLevel: row.evaluationLevel,
      judgeModel: row.judgeModel,
      taskName: row.taskName,
      valueType: row.valueType,
      endpointName: row.taskName,
      endpointId: null,
      traceId: row.traceId,
      traceType: row.traceRef?.type ?? null,
      timestamp: row.evaluationTime,
      contentType: 'text/plain',
      content: displayValue(row),
      tags,
    };
  }

  function toGenAIEvaluationRecordSummary(row: EvaluationRecordRow): GenAIEvaluationRecordSummary {
    return {
      name: row.taskName ?? row.valueType ?? '-',
      id: row.traceId ?? row.traceRef?.segmentId ?? row.traceRef?.spanId ?? '-',
      value: displayValue(row),
      refId: row.traceId,
    };
  }

  const genAIEvaluationRecords = computed(() => q.data.value?.records ?? []);
  const genAIEvaluationRecordStreamRows = computed(() =>
    genAIEvaluationRecords.value.map(toGenAIEvaluationRecordStreamRow),
  );

  return {
    data: computed(() => q.data.value ?? null),
    genAIEvaluationRecords,
    genAIEvaluationRecordStreamRows,
    genAIEvaluationRecordSummaries: computed(() =>
      genAIEvaluationRecords.value.map(toGenAIEvaluationRecordSummary),
    ),
    logs: genAIEvaluationRecordStreamRows,
    records: computed(() => genAIEvaluationRecords.value.map(toGenAIEvaluationRecordSummary)),
    total: computed(() => q.data.value?.total ?? null),
    // A transport failure has no response envelope, so treating the missing
    // data as reachable would turn network/403/500 errors into an empty list.
    reachable: computed(() => !q.error.value && (q.data.value?.reachable ?? true)),
    queryError: computed(() => q.data.value?.error ?? q.error.value?.message ?? null),
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
    hasNext: computed(() => q.data.value?.hasNext ?? false),
  };
}

export interface EvaluationRecordFacetParams {
  service: Ref<string | null>;
  serviceId?: Ref<string | null>;
  providerId?: Ref<string | null>;
  modelId?: Ref<string | null>;
  valueType?: Ref<'SCORE' | 'BOOLEAN' | 'STRING' | 'JSON' | null>;
  minScore?: Ref<number | null>;
  maxScore?: Ref<number | null>;
  booleanValue?: Ref<boolean | null>;
  taskName?: Ref<string | null>;
  judgeModel?: Ref<string | null>;
  traceId?: Ref<string | null>;
  traceType?: Ref<'SKYWALKING_NATIVE' | 'OTLP' | null>;
  keywords?: Ref<string[]>;
  windowMinutes?: Ref<number>;
  startTime?: Ref<number | null>;
  endTime?: Ref<number | null>;
}

export function useLayerEvaluationRecordFacets(layerKey: Ref<string>, params: EvaluationRecordFacetParams) {
  const q = useQuery<EvaluationRecordFacetsResponse>({
    queryKey: [
      'layer-evaluation-record-facets',
      layerKey,
      params.service,
      params.serviceId ?? computed(() => null),
      params.providerId ?? computed(() => null),
      params.modelId ?? computed(() => null),
      params.valueType ?? computed(() => null),
      params.minScore ?? computed(() => null),
      params.maxScore ?? computed(() => null),
      params.booleanValue ?? computed(() => null),
      params.taskName ?? computed(() => null),
      params.judgeModel ?? computed(() => null),
      params.traceId ?? computed(() => null),
      params.traceType ?? computed(() => null),
      params.keywords ?? computed(() => []),
      params.windowMinutes ?? computed(() => 0),
      params.startTime ?? computed(() => null),
      params.endTime ?? computed(() => null),
    ],
    queryFn: () =>
      bffClient.evaluationRecord.facets(layerKey.value, {
        ...(params.serviceId?.value ? { serviceId: params.serviceId.value } : {}),
        ...(params.providerId?.value ? { providerId: params.providerId.value } : {}),
        ...(params.modelId?.value ? { modelId: params.modelId.value } : {}),
        ...(params.valueType?.value ? { valueType: params.valueType.value } : {}),
        ...(params.valueType?.value === 'SCORE' && params.minScore?.value != null ? { minScore: params.minScore.value } : {}),
        ...(params.valueType?.value === 'SCORE' && params.maxScore?.value != null ? { maxScore: params.maxScore.value } : {}),
        ...(params.valueType?.value === 'BOOLEAN' && params.booleanValue?.value != null ? { booleanValue: params.booleanValue.value } : {}),
        ...(params.taskName?.value ? { taskName: params.taskName.value } : {}),
        ...(params.judgeModel?.value ? { judgeModel: params.judgeModel.value } : {}),
        ...(params.traceId?.value ? { traceId: params.traceId.value } : {}),
        ...(params.traceType?.value ? { traceType: params.traceType.value } : {}),
        ...(params.windowMinutes?.value ? { windowMinutes: params.windowMinutes.value } : {}),
        ...(params.startTime?.value && params.endTime?.value
          ? { startTime: params.startTime.value, endTime: params.endTime.value }
          : {}),
        sampleSize: 200,
      }),
    enabled: computed(() => layerKey.value.length > 0),
    staleTime: 30_000,
  });
  return {
    facets: computed(() => q.data.value ?? null),
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}
