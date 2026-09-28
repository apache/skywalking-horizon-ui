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
 * Which alarm page the view is showing, as this reader is served it: its
 * pins, title, starting window and how many of its pins the reader cannot
 * reach. `pageId` absent is the default page.
 *
 * The default page always renders — it is where every alarm lands. Until the
 * pages route answers it reads the default page's config, which the sidebar
 * badge has usually cached already; once the route answers, its pins are the
 * ones narrowed to the reader. A named page renders only once the route has
 * served it.
 */

import { computed, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery } from '@tanstack/vue-query';
import type { AlarmPageView } from '@skywalking-horizon-ui/api-client';
import { bff, describeApiError, type AlarmsConfig } from '@/api/client';
import { useAlarmPages } from '@/shell/useAlarmPages';

export type AlarmPageState = 'loading' | 'ready' | 'missing' | 'failed';

export function useAlarmPage(pageId: Ref<string | undefined>) {
  const { t } = useI18n();
  const pages = useAlarmPages();
  const config = useQuery({
    queryKey: ['alarms/config'],
    queryFn: (): Promise<AlarmsConfig> => bff.alarms.config(),
    staleTime: Infinity,
  });

  const isDefault = computed<boolean>(() => !pageId.value);
  /** `undefined` while the route has not answered; `null` when it answered
   *  without this page. */
  const view = computed<AlarmPageView | null | undefined>(() => {
    const answer = pages.query.data.value;
    if (!answer) return undefined;
    if (isDefault.value) return answer.default;
    return answer.pages.find((p) => p.id === pageId.value) ?? null;
  });
  const onConfig = computed<boolean>(() => isDefault.value && view.value === undefined);

  const state = computed<AlarmPageState>(() => {
    if (isDefault.value || view.value) return 'ready';
    if (!pages.enabled.value) return 'missing';
    if (pages.query.isError.value || pages.query.data.value?.unreachable) return 'failed';
    if (view.value === undefined) return 'loading';
    return 'missing';
  });

  const failure = computed<string | null>(() => {
    if (pages.query.isError.value) {
      return t('The alarm pages could not be read: {err}', { err: describeApiError(pages.query.error.value) });
    }
    return pages.query.data.value?.unreachable ? t('The template store could not be read.') : null;
  });

  const pinnedLayers = computed<readonly string[]>(() => {
    if (view.value) return view.value.pinnedLayers;
    return onConfig.value ? config.data.value?.pinnedLayers ?? [] : [];
  });
  /** `undefined` until it is known, so the view applies it only once it is. */
  const windowMs = computed<number | undefined>(() => {
    if (view.value) return view.value.defaultWindowMs;
    return onConfig.value ? config.data.value?.defaultWindowMs : undefined;
  });
  const title = computed<string | null>(() => view.value?.title ?? null);
  const hiddenPins = computed<number>(() => view.value?.hiddenPins ?? 0);
  /** The route answered, and the default page's row is not among it: the
   *  page draws no pinned tiles rather than defaults nobody configured. */
  const setupUnread = computed<boolean>(() => isDefault.value && view.value === null);

  return { isDefault, state, failure, pinnedLayers, windowMs, title, hiddenPins, setupUnread };
}
