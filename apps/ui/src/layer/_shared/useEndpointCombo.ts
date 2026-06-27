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
 * Search-combobox plumbing for `EndpointCombo`: a search input whose
 * debounced value drives the OAP `findEndpoint` query (`query`), the
 * open/close flag, and the window-level click-outside teardown (removed
 * on unmount). The host owns the actual selection + the endpoint list;
 * this only handles the typing/debounce/open mechanics so the Logs and
 * Browser Logs pickers share it. The `el` ref must be bound to the
 * combobox root for click-outside hit-testing.
 */

import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

export interface EndpointCombo {
  searchInput: Ref<string>;
  query: Ref<string>;
  open: Ref<boolean>;
  el: Ref<HTMLElement | null>;
  reset: () => void;
  /** Set the input's displayed text WITHOUT re-running the debounced
   *  search. Picking an endpoint writes its name into the input as a
   *  label; routing that back through `query` would re-narrow the OAP
   *  list to just the picked row instead of preserving the prior search. */
  setDisplay: (value: string) => void;
}

export function useEndpointCombo(opts: { debounceMs?: number } = {}): EndpointCombo {
  const debounceMs = opts.debounceMs ?? 250;
  const searchInput = ref('');
  const query = ref('');
  const open = ref(false);
  const el = ref<HTMLElement | null>(null);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let skipDebounce = false;
  watch(searchInput, (v) => {
    if (timer) clearTimeout(timer);
    // `setDisplay` (a pick writing its label back into the input) sets this
    // so the search query is left untouched — see the interface doc.
    if (skipDebounce) {
      skipDebounce = false;
      return;
    }
    timer = setTimeout(() => {
      query.value = v.trim();
    }, debounceMs);
  });

  function onClickOutside(ev: MouseEvent): void {
    if (!open.value) return;
    if (el.value && !el.value.contains(ev.target as Node)) open.value = false;
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('click', onClickOutside);
  }
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
    if (typeof window !== 'undefined') window.removeEventListener('click', onClickOutside);
  });

  function reset(): void {
    if (timer) clearTimeout(timer);
    skipDebounce = false;
    searchInput.value = '';
    query.value = '';
    open.value = false;
  }

  function setDisplay(value: string): void {
    if (timer) clearTimeout(timer);
    skipDebounce = searchInput.value !== value;
    searchInput.value = value;
  }

  return { searchInput, query, open, el, reset, setDisplay };
}
