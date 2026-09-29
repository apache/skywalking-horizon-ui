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

import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { AlarmPageView, AlarmPagesResponse } from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import { useAuthStore } from '@/state/auth';

/** The query key the Alarm pages admin invalidates after a save or delete. */
export const ALARM_PAGES_QUERY_KEY = ['alarms/pages'] as const;

/**
 * The alarm pages this session is served — the default page plus the named
 * ones the BFF found reachable through the session's `alarms:read`. Shared by
 * the sidebar (one row per named page) and the Alarms page (its pins, title
 * and starting window); one query feeds both.
 *
 * A session without `alarms:read` on any layer never asks: the route would
 * only answer 403.
 */
export function useAlarmPages() {
  const auth = useAuthStore();
  const enabled = computed<boolean>(() => auth.hasVerbOnSomeLayer('alarms:read'));
  const query = useQuery({
    queryKey: ALARM_PAGES_QUERY_KEY,
    queryFn: ({ signal }): Promise<AlarmPagesResponse> => bff.alarms.pages(signal),
    enabled,
    staleTime: 60_000,
  });
  const namedPages = computed<AlarmPageView[]>(() => (enabled.value ? query.data.value?.pages ?? [] : []));
  return { enabled, query, namedPages };
}
