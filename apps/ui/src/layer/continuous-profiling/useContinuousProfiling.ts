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

import { computed, ref, type Ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type {
  ContinuousProfilingMonitoringInstance,
  ContinuousProfilingPolicyTarget,
  ContinuousProfilingTargetType,
} from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import { rosterReachable, shouldReseedAfterSave } from './data';
import type { ServiceRef } from '@/utils/serviceRef';

/** vue-query's key for one service's policy read — shared by the reactive
 *  `useQuery` below and the direct, id-pinned confirmation read in `save()`,
 *  so both address the SAME cache entry. */
function policyQueryKey(id: string): [string, string] {
  return ['continuous-profiling-policies', id];
}

/**
 * Continuous-profiling policies for ONE service.
 *
 * `setContinuousProfilingPolicy` REPLACES the whole policy, so the draft must
 * carry every target the operator wants kept — saving a subset deletes the
 * rest. Seeded from the server state and sent back whole.
 */
/** Sentinels for a failure OAP gave no words for. The view translates these
 *  two and shows anything else verbatim, since it came from OAP. */
export const UNREACHABLE = '\u0000unreachable';
export const REJECTED = '\u0000rejected';

export function useContinuousProfiling(service: Ref<ServiceRef | null>) {
  const serviceId = computed<string | null>(() => service.value?.id ?? null);
  const queryClient = useQueryClient();
  const draft = ref<ContinuousProfilingPolicyTarget[]>([]);
  /** Set once the draft has been seeded for the CURRENT service, so switching
   *  services re-seeds instead of carrying another service's rules over. */
  const seededFor = ref<string | null>(null);
  const saving = ref(false);
  const saveError = ref<string | null>(null);

  const q = useQuery({
    queryKey: ['continuous-profiling-policies', serviceId],
    queryFn: () => bffClient.continuousProfiling.policies(service.value!),
    enabled: computed(() => !!serviceId.value),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // Reused from the roster composable — same shape, same bug class: a request
  // that never completed (transport failure, BFF down) leaves `q.data` holding
  // the LAST successful read, and a bare `?? false`/`?? true` default reads
  // that stale success as the current truth.
  const reachable = computed<boolean>(() => rosterReachable(q.data.value?.reachable, !!q.error.value));
  const serverTargets = computed<ContinuousProfilingPolicyTarget[]>(() => q.data.value?.targets ?? []);

  /** Comparable form of ONE target's rules — the read type carries
   *  `triggeredCount` / `lastTriggerTimestamp`, which are OAP-maintained and
   *  must not count as an edit. */
  function rulesOf(t: ContinuousProfilingPolicyTarget | undefined): string {
    if (!t) return '';
    return JSON.stringify(
      t.checkItems.map((c) => ({
        type: c.type,
        threshold: c.threshold,
        period: c.period,
        count: c.count,
        uriList: c.uriList ?? [],
        uriRegex: c.uriRegex ?? '',
      })),
    );
  }

  /** Per-target state against what OAP has stored — whether the rules on
   *  screen are the rules that are running. */
  function targetState(t: ContinuousProfilingPolicyTarget): 'applied' | 'modified' | 'new' {
    const stored = serverTargets.value.find((s) => s.type === t.type);
    if (!stored) return 'new';
    return rulesOf(stored) === rulesOf(t) ? 'applied' : 'modified';
  }

  /** True when the whole draft matches what OAP has — nothing to apply. */
  const inSync = computed<boolean>(() => {
    if (draft.value.length !== serverTargets.value.length) return false;
    return draft.value.every((t) => targetState(t) === 'applied');
  });
  /** Advisory only — `false` means no eBPF-profilable process reported recently,
   *  which is a reason to warn, never a reason to stop the operator saving. */
  const ebpfReporting = computed<boolean | null>(() => q.data.value?.ebpfReporting ?? null);

  // Deep-cloned so editing a field never mutates the query cache.
  function seed(): void {
    const id = serviceId.value;
    if (!id || q.isFetching.value || seededFor.value === id) return;
    draft.value = serverTargets.value.map((t) => ({
      type: t.type,
      checkItems: t.checkItems.map((c) => ({ ...c, uriList: c.uriList ? [...c.uriList] : undefined })),
    }));
    seededFor.value = id;
    saveError.value = null;
  }

  async function save(): Promise<boolean> {
    const submittedFor = service.value;
    const id = submittedFor?.id;
    if (!submittedFor || !id) return false;
    saving.value = true;
    saveError.value = null;
    // Nothing disables the form while a save is in flight — the operator can
    // keep editing, and a later edit made mid-request must not be clobbered by
    // reseeding the draft with the OLDER snapshot this request actually sent.
    const submitted = JSON.stringify(draft.value);
    try {
      const res = await bffClient.continuousProfiling.savePolicies(id, draft.value);
      // Three distinct failures: transport, a refusal with a reason, a bare false.
      if (!res.reachable) {
        saveError.value = res.error ?? UNREACHABLE;
        return false;
      }
      if (!res.status) {
        saveError.value = res.errorReason ?? REJECTED;
        return false;
      }
      // Confirm against `id` DIRECTLY rather than `q.refetch()` — `q`'s
      // queryKey includes the reactive `serviceId` ref, so if the operator
      // switches the picker while this request is in flight (nothing here
      // disables it), `q` has already retargeted to the NEW service by the
      // time this line runs and `q.refetch()` would confirm the wrong one.
      let confirmed: Awaited<ReturnType<typeof bffClient.continuousProfiling.policies>> | null = null;
      try {
        // Confirm the identity this save was issued for, not whatever the
        // picker points at now.
        confirmed = await bffClient.continuousProfiling.policies(submittedFor);
      } catch {
        confirmed = null;
      }
      if (confirmed) {
        // Keep THIS id's cache entry current regardless of what is selected
        // now, so returning to it inside the 30s staleTime shows the just-
        // confirmed policy rather than whatever was cached before the save.
        queryClient.setQueryData(policyQueryKey(id), confirmed);
      }
      // See shouldReseedAfterSave in data.ts for what each condition guards.
      const shouldReseed = shouldReseedAfterSave(
        { succeeded: !!confirmed, reachable: confirmed?.reachable },
        JSON.stringify(draft.value),
        submitted,
        serviceId.value,
        id,
      );
      if (shouldReseed) {
        seededFor.value = null;
        seed();
      }
      return true;
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      saving.value = false;
    }
  }

  return {
    draft,
    seed,
    serverTargets,
    targetState,
    inSync,
    ebpfReporting,
    reachable,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: computed<string | null>(() => q.data.value?.error ?? null),
    save,
    saving,
    saveError,
  };
}

/**
 * The watched roster for ALL armed targets at once — read-only evidence that a
 * policy is matching processes, and where it has fired.
 *
 * Scale is the whole design here. A production service has dozens to 100+
 * instances with several processes each, so:
 *  - ONE query covering every target (the roster is target-invariant on OAP's
 *    side; per-target queries shipped and rendered it N times over);
 *  - rows RANKED with triggered instances first, because the two or three that
 *    fired are the answer and they were previously lost among 98 reading "0×";
 *  - the render CAPPED with an explicit count, never silently truncated.
 */
export function useContinuousProfilingInstances(
  service: Ref<ServiceRef | null>,
  targets: Ref<ContinuousProfilingTargetType[]>,
) {
  const serviceId = computed<string | null>(() => service.value?.id ?? null);
  const key = computed(() => [...targets.value].sort().join(','));
  const q = useQuery({
    queryKey: ['continuous-profiling-instances', serviceId, key],
    queryFn: () => bffClient.continuousProfiling.instances(service.value!, targets.value),
    enabled: computed(() => !!serviceId.value && targets.value.length > 0),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const raw = computed<ContinuousProfilingMonitoringInstance[]>(() => q.data.value?.instances ?? []);
  const total = (i: ContinuousProfilingMonitoringInstance): number =>
    Object.values(i.triggers).reduce((n, v) => n + (v?.count ?? 0), 0);

  // Triggered first (most first), then by name so the order is STABLE — storage
  // return order is not, and an unstable list is unreadable when it refetches.
  const ranked = computed<ContinuousProfilingMonitoringInstance[]>(() =>
    [...raw.value].sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name)),
  );

  return {
    ranked,
    isFetching: q.isFetching,
    // Kept apart on purpose: an empty roster and an unreadable one look
    // identical in `ranked`, and only one of them means "no agent is reporting".
    //
    // Two distinct failure shapes, both false: the BFF answers 200 with
    // `reachable:false` when IT could not reach OAP (softErr), and vue-query
    // sets `q.error` when the REQUEST itself never completed (the BFF down,
    // a network failure, a non-2xx) — `q.data` then stays undefined and a
    // bare `?? true` default would call that state "reachable".
    reachable: computed<boolean>(() => rosterReachable(q.data.value?.reachable, !!q.error.value)),
    error: computed<string | null>(
      () => q.data.value?.error ?? (q.error.value instanceof Error ? q.error.value.message : null),
    ),
  };
}

/**
 * Which targets each service of a layer has armed, for the service picker.
 *
 * OAP has no bulk policy read, so the BFF fans out one query per service and
 * caps it; `shortfall` is non-null when the cap bit, because a picker that
 * silently labels only some services would read as "the rest have no policy".
 */
export function useLayerPolicySummary(layerKey: Ref<string>) {
  const q = useQuery({
    queryKey: ['continuous-profiling-policy-summary', layerKey],
    queryFn: () => bffClient.continuousProfiling.policySummary(layerKey.value),
    enabled: computed(() => layerKey.value.length > 0),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return {
    /** `null` for a service OAP would not answer for; a service beyond the cap
     *  is simply absent. Both mean UNKNOWN — only an empty array means the
     *  service is genuinely un-armed. */
    summary: computed(() => {
      const m = new Map<string, ContinuousProfilingTargetType[] | null>();
      for (const s of q.data.value?.services ?? []) m.set(s.id, s.targets);
      return m;
    }),
    shortfall: computed<{ checked: number; total: number } | null>(() => {
      const d = q.data.value;
      if (!d || !d.reachable || d.checked >= d.total) return null;
      return { checked: d.checked, total: d.total };
    }),
    isFetching: q.isFetching,
    refetch: q.refetch,
  };
}
