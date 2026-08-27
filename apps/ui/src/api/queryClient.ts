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
 * The app-wide Vue Query client. Lives in its own module (rather than in
 * `main.ts`) so the identity lifecycle — `state/sessionReset` — can drop the
 * cache without importing the app entry point.
 */

import { QueryClient } from '@tanstack/vue-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      /**
       * One retry, EXCEPT for an answer that will not change.
       *
       * A route that replies 200 with `reachable: false` has answered: it
       * reached us and said it could not reach OAP. Retrying that doubles every
       * request during an outage and delays the failed state by a round-trip,
       * for a result that cannot differ. Genuine transport failures still get
       * their retry.
       *
       * A request WE cancelled is not a failure at all — a capped round, a
       * navigation, a superseded question. Retrying it re-issues precisely the
       * request the cancellation existed to stop, so the sixty-second cap would
       * abort the fan-out and then immediately ask for it again.
       *
       * Matched by NAME rather than by class: importing the error here would
       * close an import cycle back through the graph layer, and the name is
       * what the class sets.
       */
      retry: (count: number, err: Error) => {
        if (err.name === 'GraphUnavailableError') return false;
        if (err.name === 'AbortError') return false;
        if ((err as { cancelled?: boolean }).cancelled === true) return false;
        return count < 1;
      },
    },
  },
});

/**
 * Drop every cached response. REMOVES the entries rather than invalidating
 * them: several queries run at `staleTime: Infinity` (alarms, events, the
 * layer landing), so marking them stale would leave the previous identity's
 * rows painted until a refetch lands — and `enabled`-gated queries would keep
 * them indefinitely. Removal also destroys each query, which cancels its
 * in-flight fetch, so a response requested under the old session can no longer
 * be written back into the cache when it arrives.
 */
export function resetQueryCache(): void {
  queryClient.clear();
}
