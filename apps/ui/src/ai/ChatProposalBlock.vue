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
<!-- Decision card for a proposed mutating action (profiling). Shows the agent's
     reasoning — the analysed cause, why profiling, what it expects — and only
     on Approve does it call the existing verb-gated profile-create route. -->
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff } from '@/api/client';
import type { AsyncProfilingEvent, PprofTaskCreationRequest } from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import { useAiConversations } from './useAiConversations';
import type { ProposalBlock, ProposalSpec } from './types';

// pprof: only CPU/BLOCK/MUTEX carry a duration; only BLOCK/MUTEX carry a dump
// period. Sending them for point-in-time events (HEAP/GOROUTINE/…) is invalid.
const PPROF_DURATION_EVENTS = ['CPU', 'BLOCK', 'MUTEX'];
const PPROF_DUMP_PERIOD_EVENTS = ['BLOCK', 'MUTEX'];

const props = defineProps<{ block: ProposalBlock }>();
const { t } = useI18n({ useScope: 'global' });
const conv = useAiConversations();
const busy = ref(false);

const pprofEvent = (s: ProposalSpec): string => s.events?.[0] ?? 'CPU';

// Whether the task this spec creates actually carries a collection window, so
// the card never advertises a duration the create call omits.
function hasDuration(s: ProposalSpec): boolean {
  if (s.profilingType === 'network') return false;
  if (s.profilingType === 'pprof') return PPROF_DURATION_EVENTS.includes(pprofEvent(s));
  return true;
}

// The five create calls share nothing but serviceId — fire the right one per
// type, converting the agent-facing minutes to each call's unit. Returns a
// normalised ok/error (eBPF/network signal success via `status`) plus the task
// id — `id` is nullable on every OAP creation result, so ok does not imply one.
async function fireTask(s: ProposalSpec): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  const layer = s.layer.toLowerCase();
  const mins = s.durationMinutes;
  if (s.profilingType === 'trace') {
    // OAP's endpointName is non-null and rejects an empty string — an endpoint-less
    // proposal can only fail on create, so fail the card instead of firing it.
    if (!s.endpoint) return { ok: false, error: t('Trace profiling requires an endpoint, and this proposal carries none.') };
    // No startTime: OAP reads it as "begin AFTER this, on agent-side time" and
    // only dispatches tasks starting within ±5 minutes of its OWN clock, so a
    // browser wall-clock that drifts (VM resume, no NTP) creates a task that is
    // accepted, returns an id, and never runs. Omitting it means ASAP.
    const r = await bff.profile.create(layer, {
      serviceId: s.serviceId, endpointName: s.endpoint,
      duration: mins, minDurationThreshold: 0, dumpPeriod: 10, maxSamplingCount: 5,
    });
    return { ok: r.reachable && !r.errorReason, taskId: r.id, error: r.errorReason ?? r.error };
  }
  if (s.profilingType === 'async') {
    const r = await bff.asyncProfile.create(layer, {
      serviceId: s.serviceId, serviceInstanceIds: s.instanceIds ?? [],
      duration: mins * 60, events: (s.events ?? ['CPU']) as AsyncProfilingEvent[], execArgs: '',
    });
    return { ok: r.reachable && !r.errorReason && r.code !== 'ARGUMENT_ERROR', taskId: r.id, error: r.errorReason ?? r.error };
  }
  if (s.profilingType === 'pprof') {
    const ev = pprofEvent(s);
    const body: PprofTaskCreationRequest = { serviceId: s.serviceId, serviceInstanceIds: s.instanceIds ?? [], events: ev };
    if (hasDuration(s)) body.duration = mins;
    if (PPROF_DUMP_PERIOD_EVENTS.includes(ev)) body.dumpPeriod = 1;
    const r = await bff.pprof.create(layer, body);
    return { ok: r.reachable && !r.errorReason, taskId: r.id, error: r.errorReason ?? r.error };
  }
  if (s.profilingType === 'ebpf') {
    // 0 is OAP's documented ASAP sentinel ("if less then or equal zero means
    // the task starts ASAP") — same reason as trace above: never hand OAP a
    // clock we don't own to compare against its own.
    const r = await bff.ebpf.create(layer, {
      serviceId: s.serviceId, processLabels: s.processLabels ?? [], startTime: 0,
      duration: mins * 60, targetType: s.targetType ?? 'ON_CPU',
    });
    return { ok: r.reachable && r.status && !r.errorReason, taskId: r.id, error: r.errorReason ?? r.error };
  }
  const r = await bff.networkProfile.create({
    instanceId: s.instanceIds?.[0] ?? '',
    samplings: [{ when4xx: true, when5xx: true, settings: { requireCompleteRequest: true, requireCompleteResponse: true } }],
  });
  return { ok: r.reachable && r.status && !r.errorReason, taskId: r.id, error: r.errorReason ?? r.error };
}

async function approve(): Promise<void> {
  busy.value = true;
  try {
    const res = await fireTask(props.block.spec);
    if (!res.ok) conv.resolveProposal(props.block, 'failed', { error: res.error ?? '' });
    // A create that succeeded without returning an id leaves the task RUNNING on
    // OAP, so failing the card would strand it (and async/pprof would then reject
    // the retry as already-profiling). It stays approved, but unbound: `taskId`
    // is the binding, and the card renders the caveat when there is none.
    else conv.resolveProposal(props.block, 'approved', res.taskId ? { taskId: res.taskId } : undefined);
  } catch (e) {
    conv.resolveProposal(props.block, 'failed', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = false;
  }
}
function dismiss(): void {
  conv.resolveProposal(props.block, 'dismissed');
}

// One whole sentence per type — interpolating a type name into a generic header
// leaves the card half-English. Product nouns (JVM, async-profiler, pprof, eBPF)
// stay verbatim in every locale. The Record is keyed by the union, so a new
// profiling type is a compile error rather than a silently mislabelled card;
// the values are the literal en.json keys.
const HEADER_KEY: Record<ProposalSpec['profilingType'], string> = {
  trace: 'Suggested action: start trace profiling',
  async: 'Suggested action: start JVM async-profiler profiling',
  pprof: 'Suggested action: start Go pprof profiling',
  ebpf: 'Suggested action: start eBPF profiling',
  network: 'Suggested action: start network profiling',
};
const headerText = computed<string>(() => t(HEADER_KEY[props.block.spec.profilingType]));
const showDuration = computed<boolean>(() => hasDuration(props.block.spec));
// One target line adapted to the type: endpoint for trace, resolved instances
// for async/pprof/network, the CPU target for eBPF.
const targetDetail = computed<string>(() => {
  const s = props.block.spec;
  if (s.profilingType === 'trace' && s.endpoint) return s.endpoint;
  if (s.profilingType === 'ebpf') return s.targetType ?? 'ON_CPU';
  if (s.instanceLabel) return s.instanceLabel;
  return '';
});
</script>

<template>
  <div class="prop" :class="`is-${block.status}`">
    <div class="prop__head">
      <Icon name="ai" :size="15" />
      <span>{{ headerText }}</span>
    </div>
    <dl class="prop__facts">
      <div><dt>{{ t('Cause') }}</dt><dd>{{ block.spec.cause }}</dd></div>
      <div><dt>{{ t('Why profiling') }}</dt><dd>{{ block.spec.rationale }}</dd></div>
      <div><dt>{{ t('Expected') }}</dt><dd>{{ block.spec.expectation }}</dd></div>
    </dl>
    <div class="prop__target">
      {{ block.spec.service }}<template v-if="targetDetail"> · {{ targetDetail }}</template><template v-if="showDuration"> · {{ block.spec.durationMinutes }}m</template>
    </div>
    <div v-if="block.status === 'pending'" class="prop__actions">
      <button type="button" class="prop__btn" :disabled="busy" @click="dismiss">{{ t('Dismiss') }}</button>
      <button type="button" class="prop__btn prop__btn--primary" :disabled="busy" @click="approve">
        {{ busy ? t('Starting…') : t('Approve & start') }}
      </button>
    </div>
    <template v-else-if="block.status === 'approved'">
      <p class="prop__out">
        {{ t('Profiling started — ask me to analyze the results once it has collected data.') }}
      </p>
      <div v-if="block.taskId" class="prop__target">{{ t('Task') }} {{ block.taskId }}</div>
      <p v-else class="prop__out prop__out--warn">
        {{ t('Started, but OAP returned no task id — this card is not bound to the task it created, so a follow-up analysis may read a different recent task of the same type.') }}
      </p>
    </template>
    <p v-else-if="block.status === 'dismissed'" class="prop__out">{{ t('Dismissed.') }}</p>
    <!-- Replay: the case it made, with no decision attached. Never the error
         branch below, which is what an unrecognised status used to reach. -->
    <p v-else-if="block.status === 'proposed'" class="prop__out">{{ t('Proposed — nothing was started.') }}</p>
    <p v-else class="prop__out prop__out--err">{{ t('Could not start profiling.') }} {{ block.error }}</p>
  </div>
</template>

<style scoped>
.prop {
  border: 1px solid var(--sw-line-2);
  border-left: 3px solid var(--sw-accent);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.prop.is-dismissed {
  opacity: 0.6;
  border-left-color: var(--sw-line-2);
}
.prop.is-approved {
  border-left-color: var(--sw-green, #2ea043);
}
.prop.is-failed {
  border-left-color: var(--sw-red, #d1242f);
}
.prop__head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.prop__facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.prop__facts > div {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 8px;
}
.prop__facts dt {
  margin: 0;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.prop__facts dd {
  margin: 0;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
}
.prop__target {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  font-family: var(--sw-font-mono, monospace);
}
.prop__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.prop__btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.prop__btn--primary {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: var(--sw-fw-semibold);
}
.prop__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.prop__out {
  margin: 0;
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
}
.prop__out--err {
  color: var(--sw-red, #d1242f);
}
.prop__out--warn {
  color: var(--sw-warn);
}
</style>
