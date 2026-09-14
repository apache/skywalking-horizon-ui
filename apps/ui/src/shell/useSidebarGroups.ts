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

import { computed, ref, watch, type Ref } from 'vue';
import { useRoute } from 'vue-router';
import type { SidebarEntry } from './sidebarEntries';

/** Fold groups independently of their layers, revealing the active group
 * on navigation without undoing a manual fold when the menu refreshes. */
export function useSidebarGroups(entries: Ref<readonly SidebarEntry[]>) {
  const route = useRoute();
  const collapsedGroups = ref(new Set<string>());

  function isGroupOpen(label: string): boolean {
    return !collapsedGroups.value.has(label);
  }

  function toggleGroup(label: string): void {
    if (!collapsedGroups.value.delete(label)) collapsedGroups.value.add(label);
  }

  const activeGroup = computed(() => {
    const key = route.path.match(/^\/layer\/([^/]+)/)?.[1]?.toLowerCase();
    const entry = entries.value.find((entry) =>
      entry.kind === 'group' && entry.layers.some((layer) => layer.key.toLowerCase() === key),
    );
    return entry?.kind === 'group' ? entry.label : undefined;
  });
  // Watch the label rather than the entry object: each menu refresh builds
  // new entries, but keeping the same active group must preserve its fold.
  watch(
    [() => route.path, activeGroup],
    ([, label]) => {
      if (label) collapsedGroups.value.delete(label);
    },
    { immediate: true },
  );

  return { isGroupOpen, toggleGroup };
}
