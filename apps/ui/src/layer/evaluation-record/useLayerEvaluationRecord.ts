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
  LogTagFilter,
} from '@/api/client';

export interface GenAIEvaluationRecordStreamRow {
  serviceName: string | null;
  serviceId: string | null;
  serviceInstanceName: string | null;
  serviceInstanceId: string | null;
  taskName: string | null;
  valueType: string | null;
  endpointName: string | null;
  endpointId: string | null;
  traceId: string | null;
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
  instanceId?: Ref<string | null>;
  traceId?: Ref<string | null>;
  keywords?: Ref<string[]>;
  tags?: Ref<LogTagFilter[]>;
  page: Ref<number>;
  pageSize: Ref<number>;
  windowMinutes?: Ref<number>;
  startTime?: Ref<string | null>;
  endTime?: Ref<string | null>;
}

export function useLayerEvaluationRecord(layerKey: Ref<string>, params: EvaluationRecordParams) {
  const queryTags = computed(() =>
    (params.tags?.value ?? []).filter((tag) => tag.key.toLowerCase() !== 'level'),
  );
  const q = useQuery<EvaluationRecordsResponse>({
    queryKey: [
      'layer-evaluation-record',
      layerKey,
      params.service,
      params.serviceId ?? computed(() => null),
      params.instanceId ?? computed(() => null),
      params.traceId ?? computed(() => null),
      params.keywords ?? computed(() => []),
      queryTags,
      params.page,
      params.pageSize,
      params.windowMinutes ?? computed(() => 0),
      params.startTime ?? computed(() => null),
      params.endTime ?? computed(() => null),
    ],
    queryFn: () =>
      bffClient.evaluationRecord.list(layerKey.value, {
        ...(params.service.value ? { service: params.service.value } : {}),
        ...(params.serviceId?.value ? { serviceId: params.serviceId.value } : {}),
        ...(params.instanceId?.value ? { serviceInstanceId: params.instanceId.value } : {}),
        ...(params.traceId?.value ? { traceId: params.traceId.value } : {}),
        ...(queryTags.value.length > 0 ? { tags: queryTags.value } : {}),
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

  function toGenAIEvaluationRecordStreamRow(
    row: EvaluationRecordRow,
  ): GenAIEvaluationRecordStreamRow {
    const rawTags: Array<{ key: string; value: string | null }> = [
      { key: 'segment_id', value: row.segmentId },
      { key: 'span_id', value: row.spanId },
      { key: 'span_type', value: row.spanType },
      { key: 'task_name', value: row.taskName },
      { key: 'evaluation_level', value: row.evaluationLevel },
      { key: 'value_type', value: row.valueType },
      { key: 'reason', value: row.reason },
      { key: 'judge_model', value: row.judgeModel },
    ];
    const tags = rawTags.filter((tag): tag is LogKeyValue => tag.value != null && tag.value.length > 0);

    return {
      serviceName: null,
      serviceId: row.serviceId,
      serviceInstanceName: null,
      serviceInstanceId: row.serviceInstanceId,
      taskName: row.taskName,
      valueType: row.valueType,
      endpointName: row.taskName,
      endpointId: null,
      traceId: row.traceId,
      timestamp: row.evaluationTime,
      contentType: 'text/plain',
      content: row.value ?? row.reason ?? '',
      tags,
    };
  }

  function toGenAIEvaluationRecordSummary(row: EvaluationRecordRow): GenAIEvaluationRecordSummary {
    return {
      name: row.taskName ?? row.valueType ?? '-',
      id: row.traceId ?? row.segmentId ?? row.spanId ?? '-',
      value: row.value ?? row.reason ?? '',
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
    total: computed(() => q.data.value?.total ?? 0),
    reachable: computed(() => q.data.value?.reachable ?? true),
    queryError: computed(() => q.data.value?.error ?? q.data.value?.errorReason ?? q.error.value?.message ?? null),
    isFetching: q.isFetching,
    error: q.error,
    refetch: q.refetch,
  };
}

export interface EvaluationRecordFacetParams {
  service: Ref<string | null>;
  instanceId?: Ref<string | null>;
  traceId?: Ref<string | null>;
  keywords?: Ref<string[]>;
  windowMinutes?: Ref<number>;
  startTime?: Ref<string | null>;
  endTime?: Ref<string | null>;
}

export function useLayerEvaluationRecordFacets(layerKey: Ref<string>, params: EvaluationRecordFacetParams) {
  const q = useQuery<EvaluationRecordFacetsResponse>({
    queryKey: [
      'layer-evaluation-record-facets',
      layerKey,
      params.service,
      params.instanceId ?? computed(() => null),
      params.traceId ?? computed(() => null),
      params.keywords ?? computed(() => []),
      params.windowMinutes ?? computed(() => 0),
      params.startTime ?? computed(() => null),
      params.endTime ?? computed(() => null),
    ],
    queryFn: () =>
      bffClient.evaluationRecord.facets(layerKey.value, {
        ...(params.service.value ? { service: params.service.value } : {}),
        ...(params.instanceId?.value ? { serviceInstanceId: params.instanceId.value } : {}),
        ...(params.traceId?.value ? { traceId: params.traceId.value } : {}),
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
  };
}
