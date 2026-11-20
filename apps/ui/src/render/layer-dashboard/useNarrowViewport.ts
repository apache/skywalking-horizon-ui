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

import { onBeforeUnmount, ref, type Ref } from 'vue';

/** The dashboard's collapse breakpoint. Must match the `max-width: 1100px`
 *  rules in the tile and tab styles, so script and CSS switch together. */
export const NARROW_QUERY = '(max-width: 1100px)';

/** Whether the viewport is below the dashboard's collapse breakpoint. */
export function useNarrowViewport(): Ref<boolean> {
  const narrow = ref(false);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return narrow;
  const mq = window.matchMedia(NARROW_QUERY);
  narrow.value = mq.matches;
  const onChange = (e: MediaQueryListEvent): void => {
    narrow.value = e.matches;
  };
  mq.addEventListener('change', onChange);
  onBeforeUnmount(() => mq.removeEventListener('change', onChange));
  return narrow;
}
