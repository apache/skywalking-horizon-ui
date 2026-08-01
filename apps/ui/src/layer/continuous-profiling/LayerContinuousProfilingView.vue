<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

<!--
  Continuous-profiling policies — the rules that make OAP start a profiling task
  BY ITSELF, unlike the per-layer Profiling tabs where an operator starts one.

  `setContinuousProfilingPolicy` replaces the service's WHOLE policy: the targets
  sent become the targets it has. So the page always sends the full draft, and
  changing service resets it.

  Nothing here is gated on the eBPF agent being present. Arming a policy before
  deploying the agent that will satisfy it is a legitimate order of work, so
  absence is a warning, never a disabled control.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  ContinuousProfilingPolicyTarget,
  ContinuousProfilingTargetType,
} from '@skywalking-horizon-ui/api-client';
import Btn from '@/components/primitives/Btn.vue';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import Icon from '@/components/icons/Icon.vue';
import { useRoute } from 'vue-router';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerServices } from '@/layer/useLayerServices';
import { serviceRef } from '@/utils/serviceRef';
import PolicyTargetCard from './components/PolicyTargetCard.vue';
import { TARGET_TYPES, autoPickDecision, isForeignSeed, newCheckItem, pickDefaultService, policyErrors } from './data';
import {
  REJECTED,
  UNREACHABLE,
  useContinuousProfiling,
  useContinuousProfilingInstances,
  useLayerPolicySummary,
} from './useContinuousProfiling';

const { t } = useI18n();
// The policy is keyed on serviceId, which OAP builds without any layer — the
// layer is navigation here, not scope.
const { selectedId: serviceId, setSelected } = useSelectedService();
const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { services, isLoading: servicesLoading } = useLayerServices(layerKey);
const serviceName = computed<string>(
  () => services.value.find((s) => s.id === serviceId.value)?.name ?? '',
);
// The picked roster row, whole — every policy read/write is scoped by it.
const service = computed(() => serviceRef(serviceId.value, serviceName.value));
/** Writes the SHARED layer selection rather than holding its own, so this and
 *  the shell's picker cannot disagree about which service is on screen. */
const { summary: policySummary, shortfall, isFetching: summaryFetching, refetch: refetchPolicySummary } =
  useLayerPolicySummary(layerKey);

/** Land on something worth reading instead of an empty editor: the first
 *  service that already has rules, else the first service in the layer. Only
 *  ever fills an EMPTY selection, and only once per layer — an explicit pick,
 *  or a `?service=` seed, always wins. */
const autoPickedFor = ref<string | null>(null);
/** The shell skips its roster check on routes that own their selector, so a
 *  `?service=` id from ANOTHER layer would bind this editor to a service the
 *  picker cannot even show — and saving would replace that service's policy.
 *  Treat an id absent from this layer's roster as no selection. */
const seedIsForeign = computed(() => isForeignSeed(serviceId.value, services.value, servicesLoading.value));
watch(
  [serviceId, services, summaryFetching, layerKey],
  (_new, prev) => {
    const key = layerKey.value;
    const decision = autoPickDecision({
      key,
      prevKey: prev ? (prev[3] ?? null) : null,
      hasServiceId: !!serviceId.value,
      seedIsForeign: seedIsForeign.value,
      servicesLoading: servicesLoading.value,
      summaryFetching: summaryFetching.value,
      autoPickedFor: autoPickedFor.value,
    });
    if (decision.resetMarker) autoPickedFor.value = null;
    if (!decision.shouldPick) return;
    const pick = pickDefaultService(services.value, policySummary.value);
    if (!pick) return;
    autoPickedFor.value = key;
    setSelected(pick.id);
  },
  { immediate: true },
);
/** Filter the picker by what a service has armed; `'none'` is the un-armed set
 *  a text search cannot express. */
const kindFilter = ref<Set<ContinuousProfilingTargetType | 'none'>>(new Set());
/** OAP's `Service.group` — the `<group>::` prefix. */
const groupFilter = ref<Set<string>>(new Set());
// The router reuses this component instance across layer navigation (same
// route record, different `:layerKey`), so a filter left checked in layer A
// survives into layer B — where its group/kind may not exist, silently
// hiding every service and leaving no checked chip to uncheck.
watch(layerKey, () => {
  kindFilter.value = new Set();
  groupFilter.value = new Set();
});
const groups = computed<string[]>(() =>
  [...new Set(services.value.map((s) => s.group).filter(Boolean))].sort(),
);
const KIND_FILTERS: Array<ContinuousProfilingTargetType | 'none'> = [
  'ON_CPU',
  'OFF_CPU',
  'NETWORK',
  'none',
];

const serviceOptions = computed(() =>
  services.value
    // The SELECTED service always survives the filters: dropping it leaves the
    // trigger showing a placeholder while the editor is still bound to it.
    .filter((s) => s.id === serviceId.value || !groupFilter.value.size || groupFilter.value.has(s.group))
    .filter((s) => s.id === serviceId.value || matchesKind(s.id))
    .map((s) => {
      const targets = policySummary.value.get(s.id);
      return {
        value: s.id,
        label: s.name,
        hint: !targets ? '' : targets.length ? targets.join(', ') : t('no policy'),
        hintTone: targets && targets.length ? ('accent' as const) : ('muted' as const),
        group: s.group,
      };
    }),
);
function toggleGroup(g: string): void {
  const next = new Set(groupFilter.value);
  if (next.has(g)) next.delete(g);
  else next.add(g);
  groupFilter.value = next;
}
function matchesKind(id: string): boolean {
  if (!kindFilter.value.size) return true;
  const targets = policySummary.value.get(id);
  // Unknown is not "no policy": a service past the summary cap, or one OAP
  // would not answer for, must not land in the un-armed bucket.
  if (!targets) return false;
  // OR across checked kinds — an AND would ask for every checked kind at once.
  for (const k of kindFilter.value) {
    if (k === 'none' ? targets.length === 0 : targets.includes(k)) return true;
  }
  return false;
}
/** Each chip counts what it would leave GIVEN the other filter — a chip
 *  advertising a non-zero count must never produce an empty list. */
function groupCount(g: string): number {
  return services.value.filter((s) => s.group === g && matchesKind(s.id)).length;
}
function toggleKind(k: ContinuousProfilingTargetType | 'none'): void {
  const next = new Set(kindFilter.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  kindFilter.value = next;
}
function kindCount(k: ContinuousProfilingTargetType | 'none'): number {
  return services.value.filter((s) => {
    if (groupFilter.value.size && !groupFilter.value.has(s.group)) return false;
    const targets = policySummary.value.get(s.id);
    if (!targets) return false;
    return k === 'none' ? targets.length === 0 : targets.includes(k);
  }).length;
}

const { draft, seed, serverTargets, targetState, inSync, ebpfReporting, reachable, isFetching, save, saving, saveError } =
  useContinuousProfiling(service);

// `immediate` because a warm query cache leaves both deps unchanged on mount —
// the draft would stay empty against a policy that exists, and Apply would wipe it.
watch([serviceId, isFetching], () => seed(), { immediate: true });

/** The picker's per-service labels and kind/group filter counts come from a
 *  SEPARATE, layer-wide query — a service's own save does not touch it, so
 *  without this it keeps showing what a service had armed before this Apply
 *  for up to its 60s staleTime (or a remount). */
async function onApply(): Promise<void> {
  const ok = await save();
  if (ok) void refetchPolicySummary();
}

/** What OAP would refuse, computed from the draft — so Apply is disabled before
 *  the round trip rather than after it. */
const errors = computed(() => policyErrors(draft.value));

const saveErrorText = computed<string>(() => {
  const e = saveError.value;
  if (!e) return '';
  if (e === UNREACHABLE) return t('Could not reach OAP to save the policy.');
  if (e === REJECTED) return t('OAP refused the policy but gave no reason.');
  return e;
});

/** What OAP actually evaluates — the APPLIED targets, not the draft. */
const appliedTargets = computed<ContinuousProfilingTargetType[]>(() =>
  serverTargets.value.map((t) => t.type),
);

// ONE roster for the whole policy: OAP builds it target-independently, so each
// card folds the SAME rows in and annotates them with its own target's counts.
const {
  ranked: rosterRows,
  isFetching: rosterLoading,
  reachable: rosterReachable,
  error: rosterError,
} = useContinuousProfilingInstances(
  service,
  appliedTargets,
);

/** One tab per target. Kept valid against the draft: adding a target focuses
 *  it, removing the active one falls back to whatever is left. */
const activeTab = ref<ContinuousProfilingTargetType | null>(null);
const activeIndex = computed(() => draft.value.findIndex((d) => d.type === activeTab.value));
watch(
  draft,
  (list) => {
    if (!list.length) activeTab.value = null;
    else if (!list.some((d) => d.type === activeTab.value)) activeTab.value = list[0].type;
  },
  { immediate: true, deep: false },
);

const usedTargets = computed(() => new Set(draft.value.map((d) => d.type)));
const addableTargets = computed(() => TARGET_TYPES.filter((ty) => !usedTargets.value.has(ty)));

/** Status comes from the SERVER read, not the draft — an unsaved target has no
 *  trigger history, and showing the old one against edited rules would mislead. */
function statusFor(type: ContinuousProfilingTargetType) {
  const found = serverTargets.value.find((s) => s.type === type);
  return found ? { triggeredCount: found.triggeredCount, lastTriggerTimestamp: found.lastTriggerTimestamp } : null;
}

function addTarget(type: ContinuousProfilingTargetType): void {
  draft.value = [...draft.value, { type, checkItems: [newCheckItem()] }];
  activeTab.value = type;
}

function updateTarget(index: number, target: ContinuousProfilingPolicyTarget): void {
  draft.value = draft.value.map((d, i) => (i === index ? target : d));
}

function removeTarget(index: number): void {
  draft.value = draft.value.filter((_, i) => i !== index);
}
</script>

<template>
  <div class="cp">
    <header class="page-head">
      <div>
        <h1>{{ t('Continuous profiling policies') }}</h1>
        <p class="lede">
          {{
            t(
              'Rules that start a profiling task on their own when a process crosses a threshold — no approval, no operator present. This is eBPF profiling only: a policy can trigger ON_CPU, OFF_CPU or NETWORK, and an eBPF (Rover) agent both measures the thresholds and runs the task. Trace, async-profiler and pprof profiling stay on-demand. Policies are stored per service; saving replaces that service’s whole policy, so keep every rule you want to survive.',
            )
          }}
        </p>
      </div>
    </header>

    <!-- The picker sits ABOVE the serviceId gate. It is the only way to choose a
         service on this route (the shell's header picker is off here), so gating
         it on a service already being chosen makes a bare URL a dead end. -->
    <section class="block">
      <header class="block-head">
        <h2>{{ t('Policy') }}</h2>
        <div class="scope-row">
          <label class="scope-pick">
            <span class="scope-label">{{ t('Target service') }}</span>
            <TypeaheadSelect
              :model-value="serviceId"
              :options="serviceOptions"
              block
              :min-panel-width="460"
              :placeholder="t('Select a service')"
              :aria-label="t('Target service')"
              @update:model-value="setSelected($event as string)"
            >
              <!-- Filter by what is already armed, inside the panel where
                   the search is. "No policy" is the set you need when
                   arming the un-armed, and no typing expresses it. -->
              <template #filters>
                <label
                  v-for="g in groups"
                  :key="g"
                  class="kind grp"
                  :class="{ on: groupFilter.has(g) }"
                  :title="t('{n} service(s)', { n: groupCount(g) })"
                >
                  <input
                    type="checkbox"
                    :checked="groupFilter.has(g)"
                    @change="toggleGroup(g)"
                  />
                  {{ g }}
                  <span class="kn">{{ groupCount(g) }}</span>
                </label>
                <label
                  v-for="k in KIND_FILTERS"
                  :key="k"
                  class="kind"
                  :class="{ on: kindFilter.has(k) }"
                  :title="kindCount(k) === 0
                    ? t('No service matches this')
                    : t('{n} service(s)', { n: kindCount(k) })"
                >
                  <input
                    type="checkbox"
                    :checked="kindFilter.has(k)"
                    :disabled="kindCount(k) === 0 && !kindFilter.has(k)"
                    @change="toggleKind(k)"
                  />
                  {{ k === 'none' ? t('no policy') : k }}
                  <span class="kn">{{ kindCount(k) }}</span>
                </label>
              </template>
            </TypeaheadSelect>
          </label>

          <p class="scope">
            {{ t('One policy per service — it applies to every instance, and cannot be narrowed to one.') }}
            <span v-if="shortfall">
              {{ t('Rule labels cover the first {checked} of {total} services.', shortfall) }}
            </span>
          </p>
        </div>
      </header>

      <p v-if="!serviceId || seedIsForeign" class="empty">
        {{ t('Pick a service to see and edit its continuous-profiling policy.') }}
      </p>
      <p v-else-if="isFetching" class="empty">{{ t('Reading data…') }}</p>
      <p v-else-if="!reachable" class="empty err">
        {{ t('Could not read the policy for this service.') }}
      </p>

      <template v-else>
        <!-- A warning, never a gate: arming rules before deploying the eBPF
             agent is a legitimate order of work. -->
        <p v-if="ebpfReporting === false" class="warn">
          <Icon name="alert" />
          <span>
            {{
              t(
                'No process of this service has reported eBPF-profiling support in the last 10 minutes, so nothing will trigger yet. You can still save these rules now — they take effect once an eBPF (Rover) agent reports for this service.',
              )
            }}
          </span>
        </p>

        <!-- One tab per target: only the selected one renders, so a roster
             is never competing with two other copies of itself, and the
             applied state stays visible on every tab head. -->
        <div v-if="draft.length" class="tabs" role="tablist">
          <button
            v-for="tgt in draft"
            :key="tgt.type"
            type="button"
            role="tab"
            class="tab"
            :class="{ on: tgt.type === activeTab }"
            :aria-selected="tgt.type === activeTab"
            @click="activeTab = tgt.type"
          >
            {{ tgt.type }}
            <span class="dot" :class="`is-${targetState(tgt)}`" />
          </button>
          <span v-if="addableTargets.length" class="tab-add">
            <Btn v-for="ty in addableTargets" :key="ty" kind="ghost" size="sm" @click="addTarget(ty)">
              <Icon name="plus" />
              {{ ty }}
            </Btn>
          </span>
        </div>

        <div class="policies">
          <!-- Keyed on the SERVICE too: two services sharing a target type
               would otherwise reuse this card and its per-row editor state. -->
          <PolicyTargetCard
            v-if="activeIndex >= 0"
            :key="`${serviceId}:${draft[activeIndex].type}`"
            :target="draft[activeIndex]"
            :status="statusFor(draft[activeIndex].type)"
            :state="targetState(draft[activeIndex])"
            :rows="rosterRows"
            :rows-loading="rosterLoading"
            :rows-reachable="rosterReachable"
            :rows-error="rosterError"
            :service-name="serviceName"
            @update="updateTarget(activeIndex, $event)"
            @remove="removeTarget(activeIndex)"
          />

          <template v-if="!draft.length">
            <p class="empty">
              {{ t('No policy is armed for this service. Add a target to start one.') }}
            </p>
            <div class="add-row">
              <span class="label">{{ t('Add target') }}</span>
              <Btn v-for="ty in addableTargets" :key="ty" kind="ghost" size="sm" @click="addTarget(ty)">
                <Icon name="plus" />
                {{ ty }}
              </Btn>
            </div>
          </template>
        </div>

        <footer class="actions">
          <!-- Policy-WIDE, not per tab: setContinuousProfilingPolicy replaces
               the service's whole policy in one call, so this applies every tab
               at once. Saying so here stops a per-tab reading of a global
               button. Disabled only when the draft already equals what OAP
               stores, so it doubles as "is any of this pending?". -->
          <Btn kind="primary" :disabled="saving || inSync || !!errors.length" @click="onApply">
            {{ saving ? t('Applying…') : t('Apply policy') }}
          </Btn>
          <span v-if="errors.length" class="err">
            {{ errors[0].target }}<template v-if="errors[0].measurement"> · {{ errors[0].measurement }}</template>:
            {{ t(errors[0].key, errors[0].params ?? {}) }}
            <template v-if="errors.length > 1"> ({{ t('+{n} more', { n: errors.length - 1 }) }})</template>
          </span>
          <span v-else-if="inSync && draft.length" class="ok">{{ t('All rules are applied.') }}</span>
          <span v-else-if="draft.length" class="warn-text">{{ t('Not applied yet — applies every tab at once, since OAP stores one policy per service.') }}</span>
          <span v-if="saveError" class="err">{{ saveErrorText }}</span>
        </footer>
      </template>
    </section>
  </div>
</template>

<style scoped>
.cp {
  padding: var(--sw-density-pad);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.kicker {
  font-size: var(--sw-fs-xs);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
  color: var(--sw-fg-3);
}
h1 {
  margin: 2px 0 6px;
  font-size: var(--sw-fs-xl);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.lede {
  margin: 0;
  max-width: 76ch;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-2);
  line-height: var(--sw-lh-relaxed);
}
.pickers {
  display: flex;
  gap: 12px;
}
.picker,
.label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.label {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
}
.block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
  background: var(--sw-bg-1);
  padding: 12px;
}
.block-head h2 {
  margin: 0;
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-1);
}
.scope-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.scope-pick {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
:deep(.kind) {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-xs);
  font-family: var(--sw-mono);
  padding: 2px 8px;
  cursor: pointer;
}
:deep(.kind input) {
  margin: 0;
  cursor: pointer;
}
:deep(.kind input:disabled) {
  cursor: default;
}
:deep(.kind.grp) {
  border-style: dashed;
}
:deep(.kind.on) {
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
}
:deep(.kind .kn) {
  color: var(--sw-fg-3);
}
.scope-label {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
}
.scope {
  margin: 0 0 6px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.policies,
.side {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tabs {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--sw-line);
  padding-bottom: 6px;
}
.tab {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--sw-radius);
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-sm);
  font-family: var(--sw-mono);
  padding: 4px 10px;
  cursor: pointer;
}
.tab.on {
  background: var(--sw-bg-2);
  border-color: var(--sw-line-2);
  color: var(--sw-fg-0);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sw-fg-3);
}
.dot.is-applied {
  background: var(--sw-ok);
}
.dot.is-modified,
.dot.is-new {
  background: var(--sw-warn);
}
.tab-add {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.add-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.empty {
  margin: 0;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
}
.warn {
  margin: 0;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  border: 1px solid var(--sw-warn);
  background: var(--sw-warn-soft);
  border-radius: var(--sw-radius);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-1);
  line-height: var(--sw-lh-relaxed);
  max-width: 90ch;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ok {
  font-size: var(--sw-fs-xs);
  color: var(--sw-ok);
}
.warn-text {
  font-size: var(--sw-fs-xs);
  color: var(--sw-warn);
}
.err {
  font-size: var(--sw-fs-xs);
  color: var(--sw-err);
}

</style>
