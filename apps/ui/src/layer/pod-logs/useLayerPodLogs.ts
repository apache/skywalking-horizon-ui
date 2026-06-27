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
 * Live-tail engine for on-demand Kubernetes pod logs.
 *
 * The page is INSTANCE-pinned: the operator picks a pod, then a
 * container, then taps Start. Each poll fetches the trailing
 * `windowSeconds` of the container's logs and replaces the buffer; the
 * poll repeats every `intervalSeconds` until the operator pauses. This
 * is a true tail — there is no stored history to page through, the logs
 * are streamed live from the K8s API through OAP and never persisted.
 *
 * Why not vue-query: this is an imperative timer loop, not a
 * declarative cache. The composable owns its own interval and tears it
 * down on unmount + whenever the pinned inputs (instance / container)
 * change, so a stale loop never keeps hitting OAP after the operator
 * navigates away or re-targets.
 *
 * The "no pod can be found" gotcha: a stale instance id (a terminated
 * pod) makes OAP return `errorReason` instead of containers/logs. We
 * surface it verbatim so the view can tell the operator to re-pick a
 * live pod rather than showing a silent empty pane.
 */

import { onUnmounted, readonly, ref, watch, type Ref } from 'vue';
import { bff } from '@/api/client';
import type { PodLogLine } from '@/api/scopes/log';

/** Tail look-back window per poll (seconds). */
export const WINDOW_OPTS = [
  { label: 'Last 30s', value: 30 },
  { label: 'Last 1m', value: 60 },
  { label: 'Last 5m', value: 300 },
  { label: 'Last 15m', value: 900 },
  { label: 'Last 30m', value: 1800 },
] as const;

/** Poll cadence while tailing (seconds). */
export const INTERVAL_OPTS = [
  { label: '2s', value: 2 },
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
] as const;

export function useLayerPodLogs(layerKey: Ref<string>, instanceId: Ref<string | null>) {
  const containers = ref<string[]>([]);
  const selectedContainer = ref<string | null>(null);
  const windowSeconds = ref<number>(60);
  const intervalSeconds = ref<number>(5);
  const keywords = ref<string[]>([]);
  const excludes = ref<string[]>([]);

  const lines = ref<PodLogLine[]>([]);
  const errorReason = ref<string | null>(null);
  const loadingContainers = ref(false);
  const fetching = ref(false);
  const tailing = ref(false);
  const lastUpdatedAt = ref<number | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;

  function stopTail(): void {
    tailing.value = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** Reset everything tied to the pinned pod — called when the instance
   *  changes so a tail never bleeds across pods. */
  function resetForInstance(): void {
    stopTail();
    containers.value = [];
    selectedContainer.value = null;
    lines.value = [];
    errorReason.value = null;
    lastUpdatedAt.value = null;
  }

  async function loadContainers(): Promise<void> {
    const id = instanceId.value;
    if (!layerKey.value || !id) {
      resetForInstance();
      return;
    }
    loadingContainers.value = true;
    errorReason.value = null;
    try {
      const r = await bff.log.podContainers(layerKey.value, id);
      if (r.errorReason) {
        containers.value = [];
        selectedContainer.value = null;
        errorReason.value = r.errorReason;
        return;
      }
      if (!r.reachable) {
        containers.value = [];
        errorReason.value = r.error ?? 'OAP unreachable';
        return;
      }
      containers.value = r.containers;
      // Auto-pick the first container — the operator almost always wants
      // the app container, and it's listed first by OAP. They can switch.
      selectedContainer.value = r.containers[0] ?? null;
    } catch (err) {
      containers.value = [];
      errorReason.value = err instanceof Error ? err.message : String(err);
    } finally {
      loadingContainers.value = false;
    }
  }

  async function fetchOnce(): Promise<void> {
    const id = instanceId.value;
    const container = selectedContainer.value;
    if (!layerKey.value || !id || !container) return;
    fetching.value = true;
    try {
      const r = await bff.log.podLogs(layerKey.value, {
        serviceInstanceId: id,
        container,
        windowSeconds: windowSeconds.value,
        keywordsOfContent: keywords.value.length ? keywords.value : undefined,
        excludingKeywordsOfContent: excludes.value.length ? excludes.value : undefined,
      });
      if (r.errorReason) {
        // A pod that vanished mid-tail (rollout / scale-down) — stop the
        // loop and surface the reason rather than spinning on errors.
        errorReason.value = r.errorReason;
        stopTail();
        return;
      }
      if (!r.reachable) {
        errorReason.value = r.error ?? 'OAP unreachable';
        stopTail();
        return;
      }
      errorReason.value = null;
      lines.value = r.lines;
      lastUpdatedAt.value = Date.now();
    } catch (err) {
      errorReason.value = err instanceof Error ? err.message : String(err);
      stopTail();
    } finally {
      fetching.value = false;
    }
  }

  function startTail(): void {
    if (!selectedContainer.value) return;
    stopTail();
    tailing.value = true;
    void fetchOnce();
    timer = setInterval(() => void fetchOnce(), intervalSeconds.value * 1000);
  }

  function toggleTail(): void {
    if (tailing.value) stopTail();
    else startTail();
  }

  // Re-fetch containers whenever the pinned pod changes; tear down any
  // running tail first so it can't keep hitting the old pod.
  watch(
    [layerKey, instanceId],
    () => {
      resetForInstance();
      void loadContainers();
    },
    { immediate: true },
  );

  // Changing container / window / interval / filters while tailing
  // restarts the loop so OAP re-runs the query with the new condition;
  // while paused it just clears the now-stale buffer for the next Start.
  watch([selectedContainer, windowSeconds, intervalSeconds], () => {
    if (tailing.value) startTail();
  });
  watch([keywords, excludes], () => {
    if (tailing.value) startTail();
  }, { deep: true });

  onUnmounted(stopTail);

  return {
    containers: readonly(containers),
    selectedContainer,
    windowSeconds,
    intervalSeconds,
    keywords,
    excludes,
    lines: readonly(lines),
    errorReason: readonly(errorReason),
    loadingContainers: readonly(loadingContainers),
    fetching: readonly(fetching),
    tailing: readonly(tailing),
    lastUpdatedAt: readonly(lastUpdatedAt),
    loadContainers,
    fetchOnce,
    startTail,
    stopTail,
    toggleTail,
  };
}
