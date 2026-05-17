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
 * Bind a TanStack Query to the eventLog. The earlier approach pushed
 * events from inside `queryFn`, which silently went missing whenever
 * vue-query served a cached / fresh-in-cache hit (queryFn never runs
 * in that case). Tracking the reactive `isFetching` + `data` /
 * `error` refs catches every state transition — including the
 * cache-hit case, surfaced as a one-shot `info` event so the operator
 * can see the SPA is using stored data instead of going to the BFF.
 */
import { watch, type Ref } from 'vue';
import { pushEvent, type EventKind } from '@/controls/eventLog';

interface QueryLike<T> {
  isFetching: Ref<boolean>;
  data: Ref<T | undefined>;
  error: Ref<unknown>;
}

export interface QueryEventLabels<T> {
  start: () => string;
  ok: (data: T) => string;
  err: (error: unknown) => string;
  /** Optional — when present, fires once on mount if `data` is
   *  already populated (cache hit), so the operator sees the SPA
   *  using stored data without a network round-trip. */
  cached?: (data: T) => string;
}

/**
 * Wire a vue-query result to the event log.
 *
 * @param topic  Stable identifier for paired start/ok/err lookup
 *               (e.g. `'instances'`, `'services'`, `'dashboard'`).
 * @param q      The query result handle (isFetching / data / error refs).
 * @param labels Functions that produce the event text from the
 *               query's current data / error.
 */
export function useQueryEvents<T>(
  topic: string,
  q: QueryLike<T>,
  labels: QueryEventLabels<T>,
): void {
  // Snapshot the mount-time state. vue-query can flip `isFetching`
  // synchronously during the surrounding `useQuery(...)` call (the
  // query is auto-fired the moment `enabled` is truthy), so by the
  // time this composable runs we may have already missed the
  // false→true edge. Cover the three possible initial states
  // explicitly:
  //   - in-flight  ⇒ retroactive `start` (the watch below will then
  //                    pick up the matching falling edge as `ok`/`err`).
  //   - cache hit  ⇒ one-shot `info` line so the ticker doesn't go
  //                    silent on fast-path revisits.
  //   - empty       ⇒ no event yet; the watch will catch the upcoming
  //                    rising edge once the query actually fires.
  if (q.isFetching.value) {
    pushEvent(topic, 'start', labels.start());
  } else if (labels.cached && q.data.value !== undefined) {
    pushEvent(topic, 'info', labels.cached(q.data.value));
  }

  watch(
    () => q.isFetching.value,
    (now, before) => {
      if (now && !before) {
        pushEvent(topic, 'start', labels.start());
        return;
      }
      if (!now && before) {
        const err = q.error.value;
        const kind: EventKind = err ? 'err' : 'ok';
        const text = err ? labels.err(err) : labels.ok(q.data.value as T);
        pushEvent(topic, kind, text);
      }
    },
    { immediate: false },
  );
}
