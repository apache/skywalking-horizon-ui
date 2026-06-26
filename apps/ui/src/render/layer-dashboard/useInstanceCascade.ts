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
 * Instance picker cascade for the per-layer Instance scope: fetches the
 * service's instance list, auto-picks / falls back the selection, drops a
 * stale pick when the service actually changes, and resolves the
 * `effectiveInstance` fed to the widget batch. Owns the watch lifecycle
 * (auto-torn-down with the host component).
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useSelectedInstance } from '@/layer/useSelectedInstance';
import { pushEvent } from '@/controls/eventLog';
import { MAX_LOCKED } from '@/state/layerSelection';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';

export interface LayerInstance {
  id: string;
  name: string;
  language: string | null;
  attributes: Array<{ name: string; value: string }>;
}

export function useInstanceCascade(
  layerKey: Ref<string>,
  scope: ComputedRef<string>,
  serviceName: ComputedRef<string | null>,
  layer: ComputedRef<LayerDef | null>,
) {
  const {
    selectedInstance,
    setSelectedInstance,
    lockedInstanceNames,
    toggleLockInstance,
    isInstanceLocked,
  } = useSelectedInstance();

  // Instance list waits for `serviceName` (post-landing), not the URL
  // id fallback. Enforces the cascade: landing → service → instance →
  // metrics, each step firing exactly once after the prior resolves.
  const { instances: instanceList, isFetching: instancesLoading } = useLayerInstances(
    layerKey,
    serviceName,
  );

  /** Track which row's attributes panel is open. Mutually exclusive —
   *  expanding one collapses the previous so the list stays compact. */
  const expandedInstance = ref<string | null>(null);

  // Instance-row badge: the layer's configured `instances.badge` attribute
  // (default `language`). Hidden when empty or UNKNOWN. See InstanceListConfig.badge.
  function instanceBadge(i: LayerInstance): string | null {
    const key = layer.value?.instances?.badge ?? 'language';
    const raw = key.toLowerCase() === 'language'
      ? (i.language ?? '')
      : (i.attributes.find((a) => a.name.toLowerCase() === key.toLowerCase())?.value ?? '');
    return !raw || raw.trim().toUpperCase() === 'UNKNOWN' ? null : raw;
  }

  // Drop the stale instance whenever the service ACTUALLY changes —
  // the new service's instance list almost never matches the previous
  // pick. The transition `null → "service-name"` (initial landing
  // resolution) is NOT a service change and must not clear the URL
  // `?instance=` — doing so blew away the operator's URL pick before
  // the auto-pick / fallback path could even read it, and the dashboard
  // query then waited for the next instance list + auto-pick cycle.
  // Only fire when both ends of the transition are real service names.
  watch(serviceName, (next, prev) => {
    if (!prev || !next) return;
    if (next !== prev && selectedInstance.value) {
      setSelectedInstance(null);
    }
  });
  // Default-select the first instance once the list arrives, but only
  // on the Instance scope (so other scopes don't bake an instance into
  // their URL on every visit). `immediate: true` so a cache-hit on
  // mount (vue-query had this serviceId's instance list already, e.g.
  // because the shell init gate stretched the mount past the query's
  // first response) still fires the auto-pick — without it, the watch
  // would only catch the transition from [] to [...] and silently skip
  // the pick when the list arrived synchronously.
  watch([instanceList, scope], ([list, s]) => {
    if (s !== 'instance') return;
    // Don't clear the URL ?instance= when the list is TEMPORARILY
    // empty (e.g. service just changed and the instance query is
    // re-firing) — clearing causes a visible URL bounce that
    // strips the operator's pick and breaks dashboard.enabled. We
    // simply wait for actual instance data; if the list eventually
    // resolves to truly empty (instancesLoading false + length 0),
    // the picker's own empty state handles it and the dashboard
    // gate keeps the widget batch quiet.
    if (list.length === 0) return;
    // Quiet default (no URL pick) vs noted fallback (stale URL pick).
    if (!selectedInstance.value) {
      setSelectedInstance(list[0].name);
      return;
    }
    if (!list.some((i) => i.name === selectedInstance.value)) {
      pushEvent(
        'fallback',
        'info',
        `URL instance "${selectedInstance.value}" not in ${serviceName.value} · falling back to "${list[0].name}"`,
      );
      setSelectedInstance(list[0].name);
    }
  }, { immediate: true });

  // Resolved entity, fed to the widget batch. Only non-null AFTER
  // the list has arrived AND the selection is verified to exist in
  // it — covers both:
  //   - URL pick matches a real list entry  ⇒ use it
  //   - URL pick doesn't match              ⇒ stay null while the
  //     auto-pick/fallback watch above swaps selectedInstance to
  //     list[0], which then flips this computed to the new value
  // While the list is loading (length 0) the entity is null too, so
  // the dashboard stays gated. No wasted "wrong-id then fixed" round-trip.
  const effectiveInstance = computed<string | null>(() => {
    const v = selectedInstance.value;
    if (!v) return null;
    return instanceList.value.some((i) => i.name === v) ? v : null;
  });
  const instanceResolvable = computed<boolean>(
    () => instancesLoading.value || instanceList.value.length > 0 || !!effectiveInstance.value,
  );
  const instAtCap = computed(() => lockedInstanceNames.value.length >= MAX_LOCKED);

  return {
    selectedInstance,
    setSelectedInstance,
    lockedInstanceNames,
    toggleLockInstance,
    isInstanceLocked,
    instanceList,
    instancesLoading,
    expandedInstance,
    instanceBadge,
    effectiveInstance,
    instanceResolvable,
    instAtCap,
  };
}
