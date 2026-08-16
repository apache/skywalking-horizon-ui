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
import { instancePageMatcher, isEmptyInstanceFilter } from './instancePageFilter';
import { serviceFilterMatcher } from '@/layer/serviceFilter';
import { useLayerInstances } from '@/layer/useLayerInstances';
import type { ServiceRef } from '@/utils/serviceRef';
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
  /** The picked service, id AND name — non-null only once it has resolved,
   *  which is what enforces the landing → service → instance cascade. */
  service: ComputedRef<ServiceRef | null>,
  layer: ComputedRef<LayerDef | null>,
  /** The extension page being viewed, when one is. Its filter narrows the
   *  list below — configuration the operator is never shown, exactly as
   *  the service filter behaves on a Service page. */
  pageId?: ComputedRef<string | null>,
) {
  const {
    selectedInstance,
    setSelectedInstance,
    lockedInstanceNames,
    toggleLockInstance,
    isInstanceLocked,
  } = useSelectedInstance();

  const { instances: allInstances, isFetching: instancesLoading } = useLayerInstances(
    layerKey,
    service,
  );
  /** The page's set. Everything downstream — selection, cascade-clear,
   *  the picker, the "does an instance exist" check — reads this, so an
   *  instance the page excludes is simply not there rather than hidden
   *  in one place and live in another. */
  const instanceList = computed<LayerInstance[]>(() => {
    // Scope-gated: page ids are unique only WITHIN a component, so a
    // Service page called `brokers` would otherwise pick up the Instance
    // page `brokers`'s filter and narrow a list it says nothing about.
    if (scope.value !== 'instance') return allInstances.value;
    const id = pageId?.value;
    const filter = id
      ? layer.value?.extPages?.instance?.find((p) => p.id === id)
      : layer.value?.defaultFilters?.instance;
    const match = instancePageMatcher(filter);
    return allInstances.value.filter(match);
  });
  // Cascade-clear keys on the id: `service` is a fresh object on every
  // recompute, so watching it directly would fire on re-resolution.
  const serviceKey = computed<string | null>(() => service.value?.id ?? null);

  /** Set when the shared selection is an instance THIS page filters out.
   *  Page-local on purpose: the operator's pick belongs to the layer, not
   *  to whichever page they happen to open. */
  const pageLocalInstance = ref<string | null>(null);

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
  // pick. The transition `null → <service>` (initial landing
  // resolution) is NOT a service change and must not clear the URL
  // `?instance=` — doing so blew away the operator's URL pick before
  // the auto-pick / fallback path could even read it, and the dashboard
  // query then waited for the next instance list + auto-pick cycle.
  // Only fire when both ends of the transition are real services.
  watch(serviceKey, (next, prev) => {
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
  watch([serviceKey, pageId], () => (pageLocalInstance.value = null));
  // Sourced on the SELECTION too, not just the list: this watch decides
  // whether the shared pick needs a page-local stand-in, and picking an
  // instance the page excludes changes that answer without changing the
  // list. Without it the stand-in kept a stale value — or none — and the
  // page resolved to no instance at all and rendered nothing.
  watch([instanceList, scope, selectedInstance], ([list, s]) => {
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
    // A selection the SERVICE does not have is stale — the operator
    // switched service, or arrived on an old link — so re-pick and say so.
    if (!allInstances.value.some((i) => i.name === selectedInstance.value)) {
      pushEvent(
        'fallback',
        'info',
        `URL instance "${selectedInstance.value}" not in ${service.value?.name} · falling back to "${list[0].name}"`,
      );
      setSelectedInstance(list[0].name);
      return;
    }
    // A selection this PAGE excludes is a different thing entirely: the
    // instance exists and the operator picked it. Writing the shared
    // selection here would rewrite what they are reading on every other
    // tab of the layer, permanently and with no undo — and the message
    // above would blame the service for an exclusion the page made. The
    // page shows its own first row instead; the operator's pick survives
    // and is still there when they leave the page.
    if (!list.some((i) => i.name === selectedInstance.value)) {
      pageLocalInstance.value = list[0].name;
      return;
    }
    pageLocalInstance.value = null;
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
    // The page's own stand-in wins while it is set: the shared selection
    // is an instance this page filters out, and the widgets have to read
    // one the page actually shows.
    const v = pageLocalInstance.value ?? selectedInstance.value;
    if (!v) return null;
    return instanceList.value.some((i) => i.name === v) ? v : null;
  });
  /** The filter this page applies, whichever page it is. Exposed so the
   *  COMPARISON set can be held to the same rule as the list: a pin the
   *  page excludes is still an entity the page never shows. */
  const pageInstanceFilter = computed(() => {
    if (scope.value !== 'instance') return null;
    const id = pageId?.value;
    return (
      (id ? layer.value?.extPages?.instance?.find((p) => p.id === id) : layer.value?.defaultFilters?.instance) ?? null
    );
  });

  /**
   * Whether this page would show an instance KNOWN ONLY BY NAME.
   *
   * A pin carries its own service, and that service decides what can be
   * proved about it. Under the CURRENT service the instance is in hand,
   * so the page's full rule — attributes included — has already been
   * applied to it. Under any other service only the name is known, and
   * instance names repeat across services: a Java `worker-1` here says
   * nothing about a Go `worker-1` there. So a rule that reads attributes
   * cannot decide a foreign pin at all, and unverifiable counts as
   * excluded — a pin dropped from a comparison costs less than charting
   * an entity this page says it is not about.
   */
  function pageAllowsInstance(serviceId: string, name: string): boolean {
    const f = pageInstanceFilter.value;
    if (isEmptyInstanceFilter(f)) return true;
    const isCurrentService = !!serviceId && serviceId === service.value?.id;
    if (isCurrentService) return instanceList.value.some((i) => i.name === name);
    if ((f?.instanceAttributes ?? []).length > 0) return false;
    return serviceFilterMatcher(f?.instanceFilter ?? '').match(name);
  }

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
    pageAllowsInstance,
    instanceResolvable,
    instAtCap,
  };
}
