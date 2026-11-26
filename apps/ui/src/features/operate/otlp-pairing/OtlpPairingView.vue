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
<script setup lang="ts">
/**
 * OTLP pairing — the backend task that pairs an OTLP call's caller and callee spans into a network alias, captured on
 * demand. Not a TAL rule's run: a rule only asks for its half; the OAP node that owns the trace pairs the halves. One
 * capture per OAP node, shared by everyone, no sessions: it runs while it is read, and this page reads it every few
 * seconds while it is open. A stop releases what OAP found, so the page saves every round it reads in this browser.
 * Two tabs: the live capture, which keeps showing the round just captured until the next start, and the history of
 * the rounds saved, each opened in the same view.
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import OapVersionBanner from '@/shell/OapVersionBanner.vue';
import { useAdminFeatures } from '@/shell/useAdminFeatures';
import { compactCount, localTime } from './otlpPairing';
import { ROUNDS_KEPT, hasEnded, usePairingRounds } from './pairingRounds';
import PairingRoundView from './PairingRoundView.vue';
import { useOtlpPairing } from './useOtlpPairing';

const { t } = useI18n({ useScope: 'global' });
const { found, error, busy, capturing, liveRoundId, liveStart, lastRoundId, notServed, stopReadFailed, start, stop } =
  useOtlpPairing();

/** The admin host, as Cluster status reads it; whether OAP serves the capture is what its read answers. */
const { result: preflight, adminReachable, adminError } = useAdminFeatures();

const idleSeconds = computed(() => Math.round((found.value?.idleMillis ?? 60_000) / 1000));

type PageTab = 'live' | 'history';
const page = ref<PageTab>('live');

/** The rounds saved in this browser. */
const { rounds, remove: removeRound, clear: clearRounds } = usePairingRounds();
/** The live capture's read, once one of its round arrived. */
const liveFound = computed(() => (capturing.value && found.value?.roundId === liveRoundId.value ? found.value : null));
/** No capture runs: the live tab keeps the round this page saw run last, as it ended, until the next start. A page
 *  just opened shows none until a round runs: the rounds from before are in History. */
const lastRound = computed(() => {
  if (capturing.value || !lastRoundId.value) return null;
  return rounds.value.find((r) => r.roundId === lastRoundId.value) ?? null;
});
/** The live round runs, but no read of it has arrived yet. */
const awaitingLive = computed(() => capturing.value && liveFound.value === null);
/** The nodes not answering the latest read while no capture runs. While one runs, the round's summary counts its
 *  nodes and lists each. A read of another state than the page now knows, as while the read after a stop is on its
 *  way, tells nothing. */
const outside = computed(() => {
  const read = found.value;
  if (!read || capturing.value || read.state !== 'off') return [];
  return read.nodes.filter((n) => n.status !== 'ok');
});

/** The saved rounds, the live one apart while the live tab shows it. */
const history = computed(() => rounds.value.filter((r) => notServed.value || r.roundId !== liveRoundId.value));
/** The rounds the latest read reports a node running. */
const runningNow = computed(() => new Set(
  (found.value?.nodes ?? []).filter((n) => n.status === 'ok' && n.state === 'capturing' && n.roundId).map((n) => n.roundId!),
));
/** How many saved rounds a clear deletes: those that ended, and that no node is reported running. */
const clearable = computed(() => history.value.filter((r) => !runningNow.value.has(r.roundId) && hasEnded(r)).length);
watch(clearable, (n) => {
  if (n === 0) confirmingClear.value = false;
});
/** A delete waiting for its confirmation, asked in place: a round's ✕, or the clear. Deleted rounds cannot be brought
 *  back. */
const confirmingRemove = ref<string | null>(null);
const confirmingClear = ref(false);
// One question at a time, and none left behind: asking one drops the other, and leaving History, or the clear
// having nothing left to delete, drops both.
watch(confirmingRemove, (id) => {
  if (id !== null) confirmingClear.value = false;
});
watch(confirmingClear, (on) => {
  if (on) confirmingRemove.value = null;
});
watch(page, () => {
  confirmingRemove.value = null;
  confirmingClear.value = false;
});
function removeSaved(roundId: string): void {
  confirmingRemove.value = null;
  removeRound(roundId);
}
function clearSaved(): void {
  confirmingClear.value = false;
  clearRounds(Date.now(), runningNow.value);
}
/** The saved round open in History, by its id: one at a time, none until one is opened. */
const openId = ref<string | null>(null);
const opened = computed(() => history.value.find((r) => r.roundId === openId.value) ?? null);
function toggleRound(roundId: string): void {
  openId.value = openId.value === roundId ? null : roundId;
}
// A new capture shows on the live tab.
watch(liveRoundId, (now, before) => {
  if (now && now !== before) page.value = 'live';
});

function roundTitle(startTime: number, endTime: number): string {
  return t('captured round {start} – {end}', { start: localTime(startTime), end: localTime(endTime) });
}
</script>

<template>
  <div class="otp">
    <header class="otp__header">
      <h1 class="otp__h1">{{ t('OTLP pairing') }}</h1>
      <span class="otp__hint">{{ t('how OAP pairs the caller and callee spans of an OTLP call into a network alias') }}</span>
    </header>

    <nav class="otp__pages" role="tablist">
      <button type="button" role="tab" class="otp__page" :class="{ 'otp__page--on': page === 'live' }" :aria-selected="page === 'live'" @click="page = 'live'">
        <span v-if="capturing" class="otp__livedot">●</span> {{ t('Live capture') }}
      </button>
      <button type="button" role="tab" class="otp__page" :class="{ 'otp__page--on': page === 'history' }" :aria-selected="page === 'history'" @click="page = 'history'">
        {{ t('History') }} <span class="otp__pagecount">{{ history.length }}</span>
      </button>
    </nav>

    <template v-if="page === 'live'">
      <OapVersionBanner
        v-if="notServed"
        :feature-label="t('OTLP pairing')"
        min-version="11.2"
        :detail="t('OAP answers 404 for /trace-pairing-debugging: it is older than 11.2, or its trace-pairing-debugging module is off (SW_TRACE_PAIRING_DEBUGGING=-).')"
      />
      <p v-if="preflight && !adminReachable" class="otp__error">
        {{ t('Admin host unreachable') }}<template v-if="adminError">: {{ adminError }}</template>
      </p>

      <p class="otp__about">
        {{ t('Not a TAL rule’s run. A rule only asks for its pairing of a call, the caller or the callee side; once the span’s rules ran, the pairing is sent, routed by trace id, to the OAP node that owns the trace. That node keeps the pairings for 60 seconds and matches a callee to the caller span that is its parent; the callee rule’s buildNetworkAlias expression composes the address, and the alias is pushed.') }}
      </p>

      <div v-if="!notServed" class="otp__controls">
        <button type="button" class="otp__btn otp__btn--primary" :disabled="busy || capturing" @click="start">
          ▶ {{ t('start capture') }}
        </button>
        <button type="button" class="otp__btn" :disabled="busy || !capturing" @click="stop">■ {{ t('stop') }}</button>
        <span v-if="found || capturing" class="otp__state" :class="capturing ? 'otp__state--capturing' : 'otp__state--off'">
          {{ capturing ? 'capturing' : 'off' }}
        </span>
        <span class="otp__dim">
          {{ t('One capture per OAP node, shared by everyone reading it. It runs while it is read, as this page does every few seconds, and stops {s} seconds after the last read.', { s: idleSeconds }) }}
        </span>
        <span v-if="error" class="otp__error">{{ error }}</span>
        <span v-if="stopReadFailed" class="otp__error">
          {{ stopReadFailed.savedEnd !== null
            ? t('The last read before the stop failed: the saved round ends at its read of {time}.', { time: localTime(stopReadFailed.savedEnd) })
            : t('The last read before the stop failed, and no read of the round had arrived: nothing of it was saved.') }}
        </span>
        <span v-if="outside.length > 0" class="otp__warn">
          {{ t('not answering: {nodes}', {
            nodes: outside.map((n) => `${n.peer ?? n.nodeId ?? 'local'} (${n.status})`).join(', '),
          }) }}
        </span>
      </div>

      <template v-if="!notServed">
        <PairingRoundView
          v-if="liveFound"
          :key="liveFound.roundId"
          :found="liveFound"
          :title="t('capturing round, since {start}', { start: localTime(liveStart) })"
        />
        <div v-else-if="awaitingLive" class="otp__empty">{{ t('Capturing; waiting for the round’s first read.') }}</div>
        <template v-else-if="lastRound">
          <p class="otp__dim">{{ t('The round captured last, saved in History; a start begins a new one.') }}</p>
          <PairingRoundView :key="lastRound.roundId" :found="lastRound.found" :title="roundTitle(lastRound.startTime, lastRound.endTime)" />
        </template>
        <div v-else class="otp__empty">{{ t('Start the capture to see how OAP pairs the calls it receives.') }}</div>
      </template>
    </template>

    <template v-if="page === 'history'">
      <div class="otp__histbar">
        <span class="otp__dim">{{ t('Saved in this browser, the latest {n}; OAP keeps nothing once a capture stops.', { n: ROUNDS_KEPT }) }}</span>
        <template v-if="confirmingClear && clearable > 0">
          <span class="otp__warn">{{ t('Delete the {n} saved rounds that ended?', { n: clearable }) }}</span>
          <button type="button" class="otp__btn otp__btn--small otp__btn--danger" @click="clearSaved()">{{ t('delete') }}</button>
          <button type="button" class="otp__btn otp__btn--small" @click="confirmingClear = false">{{ t('cancel') }}</button>
        </template>
        <button
          v-else-if="history.length > 0"
          type="button"
          class="otp__btn otp__btn--small"
          :disabled="clearable === 0"
          :title="clearable === 0 ? t('no saved round has ended yet') : undefined"
          @click="confirmingClear = true"
        >{{ t('clear saved rounds') }}</button>
      </div>
      <div v-if="history.length === 0" class="otp__empty">{{ t('none saved yet in this browser') }}</div>
      <template v-else>
        <table class="otp__table">
          <thead>
            <tr>
              <th>{{ t('round') }}</th>
              <th class="otp__num">{{ t('calls matched') }}</th>
              <th class="otp__num">{{ t('OAP') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in history" :key="r.roundId">
              <tr class="otp__roundrow" :class="{ 'otp__roundrow--on': opened?.roundId === r.roundId }" @click="toggleRound(r.roundId)">
                <td class="otp__nowrap">
                  <button
                    type="button"
                    class="otp__roundopen"
                    :aria-expanded="opened?.roundId === r.roundId"
                    :aria-controls="`otp-round-${r.roundId}`"
                    @click.stop="toggleRound(r.roundId)"
                  >
                    <span class="otp__chevron" aria-hidden="true">{{ opened?.roundId === r.roundId ? '▾' : '▸' }}</span>
                    {{ localTime(r.startTime) }} – {{ localTime(r.endTime) }}
                  </button>
                  <span v-if="!hasEnded(r)" class="otp__dim">· {{ t('may still run') }}</span>
                </td>
                <td class="otp__num" :title="String(r.found.matched)">{{ compactCount(r.found.matched) }}</td>
                <td class="otp__num">{{ r.covered }}</td>
                <td class="otp__num otp__nowrap">
                  <span v-if="confirmingRemove === r.roundId" class="otp__confirm">
                    <button type="button" class="otp__btn otp__btn--small otp__btn--danger" @click.stop="removeSaved(r.roundId)">{{ t('delete') }}</button>
                    <button type="button" class="otp__btn otp__btn--small" @click.stop="confirmingRemove = null">{{ t('cancel') }}</button>
                  </span>
                  <button
                    v-else
                    type="button"
                    class="otp__roundx"
                    :aria-label="t('delete this round')"
                    :title="t('delete this round')"
                    @click.stop="confirmingRemove = r.roundId"
                  >✕</button>
                </td>
              </tr>
              <tr v-if="opened?.roundId === r.roundId">
                <td colspan="4" class="otp__roundcell">
                  <section :id="`otp-round-${r.roundId}`" class="otp__roundpanel">
                    <PairingRoundView :key="r.roundId" :found="r.found" :title="roundTitle(r.startTime, r.endTime)" />
                  </section>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </template>
    </template>
  </div>
</template>

<style scoped>
.otp {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 18px 24px;
  gap: 12px;
}

.otp__header {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.otp__h1 {
  margin: 0;
  font-size: var(--sw-fs-md);
  font-weight: var(--sw-fw-semibold);
  color: var(--rr-heading);
}

.otp__hint {
  font-size: var(--sw-fs-base);
  color: var(--rr-dim);
}

.otp__about {
  margin: 0;
  max-width: 120ch;
  font-size: var(--sw-fs-sm);
  line-height: 1.55;
  color: var(--rr-ink2);
}

.otp__controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.otp__btn {
  padding: 5px 12px;
  background: transparent;
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-ink);
  cursor: pointer;
}

.otp__btn--primary {
  background: var(--rr-active);
  border-color: var(--rr-active);
  color: var(--rr-bg);
}

.otp__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.otp__state {
  padding: 1px 8px;
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  text-transform: uppercase;
}

.otp__state--capturing {
  border-color: var(--rr-active);
  color: var(--rr-active);
}

.otp__dim {
  color: var(--rr-dim);
}

.otp__error {
  margin: 0;
  font-size: var(--sw-fs-sm);
  color: var(--rr-err);
}

.otp__btn--danger {
  border-color: var(--rr-err);
  color: var(--rr-err);
}

.otp__confirm {
  display: inline-flex;
  gap: 6px;
}

.otp__btn--small {
  padding: 2px 8px;
  font-size: var(--sw-fs-sm);
}

.otp__empty {
  padding: 12px;
  font-size: var(--sw-fs-base);
  color: var(--rr-dim);
}

.otp__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--sw-fs-base);
}

.otp__table th {
  padding: 5px 10px;
  border-bottom: 1px solid var(--sw-line-2);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  font-weight: normal;
  text-align: left;
  text-transform: uppercase;
  color: var(--rr-dim);
}

.otp__table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--rr-border);
  vertical-align: top;
  color: var(--rr-ink);
  overflow-wrap: anywhere;
}

/* A line between columns, so each column reads apart in either theme. */
.otp__table th + th,
.otp__table td + td {
  border-left: 1px solid var(--sw-line-2);
}

.otp__table thead th {
  background: var(--rr-panel);
}

.otp__table td.otp__nowrap {
  white-space: nowrap;
  overflow-wrap: normal;
}

.otp__mono {
  font-family: var(--rr-font-mono);
}

.otp__num,
.otp__table th.otp__num {
  text-align: right;
}

.otp__warn {
  color: var(--rr-warn);
}

.otp__pages {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--rr-border);
}

.otp__page {
  padding: 8px 16px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-semibold);
  color: var(--rr-dim);
  cursor: pointer;
}

.otp__page:hover {
  color: var(--rr-ink);
}

.otp__page--on {
  color: var(--rr-heading);
  border-bottom-color: var(--rr-active);
}

.otp__livedot {
  color: var(--rr-active);
}

.otp__pagecount {
  padding: 0 6px;
  border: 1px solid var(--rr-border2);
  border-radius: 8px;
  font-size: var(--sw-fs-sm);
  font-weight: normal;
  color: var(--rr-ink2);
}

.otp__histbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.otp__roundrow {
  cursor: pointer;
}

.otp__roundrow:hover {
  background: var(--rr-panel);
}

.otp__roundrow--on {
  background: var(--rr-panel);
  box-shadow: inset 2px 0 0 var(--rr-active);
}

.otp__roundrow--on td {
  border-bottom-color: transparent;
}

.otp__chevron {
  display: inline-block;
  width: 1em;
  color: var(--rr-dim);
}

/* The open round, bounded under its row: a panel that starts where the row ends and closes before the next row. */
.otp__table td.otp__roundcell {
  padding: 0 0 12px;
  overflow-wrap: normal;
}

.otp__roundpanel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border2);
  border-left: 2px solid var(--rr-active);
  border-radius: 0 0 var(--rr-radius-sm) var(--rr-radius-sm);
}


.otp__roundx {
  padding: 0 6px;
  background: transparent;
  border: 0;
  font: inherit;
  color: var(--rr-dim);
  cursor: pointer;
}

.otp__roundx:hover {
  color: var(--rr-err);
}

.otp__roundopen {
  padding: 0;
  background: transparent;
  border: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-active);
  text-align: left;
  cursor: pointer;
}

</style>
