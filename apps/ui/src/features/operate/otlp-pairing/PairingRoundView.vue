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
 * One pairing round as the OTLP pairing page shows it, the live one or a saved one: its counts, the OAP nodes it
 * covers, and one list of what it found — each peer matched to a server, and each peer and server whose pairings went
 * unmatched — narrowed by kind and by a search, then read a page at a time.
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MatchedPeer, PairingsResponse, UnmatchedPeer } from '@skywalking-horizon-ui/api-client';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import { compactCount, countsText, filterBy, localTime, unmatchedByCause } from './otlpPairing';

const props = defineProps<{
  found: PairingsResponse;
  /** The round, as the page names it: capturing since, or captured from and to. */
  title: string;
}>();

const { t } = useI18n({ useScope: 'global' });

const unmatched = computed(() => unmatchedByCause(props.found));

type Node = PairingsResponse['nodes'][number];
/** A node counted in the round: it answered, and runs this round. */
function inRound(node: Node): boolean {
  return node.status === 'ok' && node.state === 'capturing' && node.roundId === props.found.roundId;
}
/** Why a node is not counted: it did not answer, is off, or runs another round. */
function notInRound(node: Node): string {
  if (node.status !== 'ok') return node.status;
  return node.state === 'capturing' ? t('another round') : t('off');
}

/** The OAP nodes counted in the round, and every node as the popover lists it: its calls matched, or why it is not counted. */
const nodesInRound = computed(() => props.found.nodes.filter(inRound).length);
const nodesInfo = computed(() =>
  props.found.nodes.map((n) => ({
    address: n.peer ?? n.nodeId ?? 'local',
    counted: inRound(n),
    detail: inRound(n) ? String(n.matched ?? 0) : notInRound(n),
  })),
);
const nodesText = computed(() => nodesInfo.value.map((n) => `${n.address} · ${n.detail}`).join('\n'));

/** What a row is: a peer matched to its server, or the pairings of one side that left unmatched — a caller's, by the
 *  peer it dialed, or a callee's, by its server. */
type Kind = 'matched' | 'callers' | 'callees';
interface Row {
  kind: Kind;
  key: string;
  peer: string | null;
  server: string | null;
  previousServer?: string;
  updatedTime?: number;
  /** The alias address a match composed. */
  address?: string;
  /** What became of a match's calls: registered, or why not. */
  outcomes?: MatchedPeer['outcomes'];
  /** The callers that dialed the peer; none for a callee's pairings, whose caller never reported. */
  callers: readonly string[];
  /** The rules that sent a callee's pairings. */
  rules: readonly string[];
  count: number;
  causes: UnmatchedPeer['causes'] | null;
  lastTime: number;
  traceIds: readonly string[];
  nodes: readonly string[];
}

const rows = computed<Row[]>(() =>
  [
    ...props.found.matchedPeers.map((p): Row => ({
      kind: 'matched', key: `matched:${p.peer}`, peer: p.peer, server: p.server, previousServer: p.previousServer,
      updatedTime: p.updatedTime, address: p.address, outcomes: p.outcomes, callers: p.callers, rules: [], count: p.count, causes: null,
      lastTime: p.lastTime, traceIds: [], nodes: p.nodes ?? [],
    })),
    ...props.found.unmatchedPeers.map((p): Row => ({
      kind: 'callers', key: `callers:${p.peer}`, peer: p.peer, server: null, callers: p.callers, rules: [], count: p.count,
      causes: p.causes, lastTime: p.lastTime, traceIds: p.traceIds, nodes: p.nodes ?? [],
    })),
    ...props.found.unmatchedServers.map((s): Row => ({
      kind: 'callees', key: `callees:${s.server}`, peer: null, server: s.server, callers: [], rules: s.rules, count: s.count,
      causes: s.causes, lastTime: s.lastTime, traceIds: s.traceIds, nodes: s.nodes ?? [],
    })),
  ].sort((a, b) => b.lastTime - a.lastTime),
);

/** The address an alias names: the peer, when the composition is `<caller>->peer` as the shipped rule composes it;
 *  else the whole composition, which another rule may spell its own way. The alias makes that address, dialed by
 *  that caller, the matched server. */
function aliasedAddress(composed: string, peer: string | null): string {
  return peer !== null && composed.length > peer.length + 2 && composed.endsWith(`->${peer}`) ? peer : composed;
}

/** Whether a match's alias was registered: by any of its calls. OAP composes an address it then does not register when
 *  it is too long for the alias column (`tooLong`), its callee names no service (`noService`), or no registrar is wired
 *  (`composed`); a row none of whose calls registered says so rather than what the alias would represent. */
function registered(row: Row): boolean {
  return row.outcomes === undefined || (row.outcomes.registered ?? 0) > 0;
}

const kind = ref<Kind | 'all'>('all');
const filter = ref('');
const listed = computed(() => {
  const searched = filterBy<Row>(rows.value, filter.value, (r) => [
    r.peer ?? '', r.server ?? '', r.previousServer ?? '', r.address ?? '', ...r.callers, ...r.rules, ...r.traceIds, ...r.nodes,
    ...Object.keys(r.causes ?? {}),
  ]);
  return kind.value === 'all' ? searched : searched.filter((r) => r.kind === kind.value);
});
const kinds = computed(() => [
  { id: 'all' as const, label: t('all'), count: rows.value.length, warn: false },
  { id: 'matched' as const, label: t('matched'), count: props.found.matchedPeers.length, warn: false },
  { id: 'callers' as const, label: t('unmatched callers'), count: props.found.unmatchedPeers.length, warn: true },
  { id: 'callees' as const, label: t('unmatched callees'), count: props.found.unmatchedServers.length, warn: true },
]);
function kindLabel(row: Row): string {
  return row.kind === 'matched' ? t('matched') : row.kind === 'callers' ? t('unmatched caller') : t('unmatched callee');
}

/** Rows a page shows. The list is keyed by peer and by server, so it runs to a few thousand rows at most: the browser
 *  holds it whole, the kind and the search narrow all of it, and the page cuts what they leave. */
const PAGE_SIZE = 50;
const page = ref(1);
const pages = computed(() => Math.max(1, Math.ceil(listed.value.length / PAGE_SIZE)));
// Another kind or another search starts on the first page; a list that shrank as the capture ran keeps a page it has.
watch([kind, filter], () => {
  page.value = 1;
});
watch(pages, (n) => {
  if (page.value > n) page.value = n;
});
const pageRows = computed(() => listed.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));

/** An OTLP trace, read through TraceQL in the shell's trace popout, around when it was seen. */
const { openTrace } = useTracePopout();
/** Opens the trace picked from a row's list, and sets the list back to its prompt for the next pick. */
function openPickedTrace(event: Event, atMs: number): void {
  const list = event.target as HTMLSelectElement;
  const traceId = list.value;
  list.value = '';
  if (traceId) openTrace(traceId, 'traceql-otlp', atMs > 0 ? { at: atMs } : undefined);
}
</script>

<template>
  <div class="otp__view">
    <div class="otp__summary">
      <span class="otp__stat otp__title">{{ title }}</span>
      <span class="otp__stat">
        {{ t('pairings received') }}:
        <strong :title="String(found.received.caller ?? 0)">{{ compactCount(found.received.caller ?? 0) }}</strong> {{ t('caller') }} ·
        <strong :title="String(found.received.callee ?? 0)">{{ compactCount(found.received.callee ?? 0) }}</strong> {{ t('callee') }}
      </span>
      <span class="otp__stat">{{ t('calls matched') }}: <strong :title="String(found.matched)">{{ compactCount(found.matched) }}</strong></span>
      <span v-for="(n, cause) in unmatched" :key="cause" class="otp__stat otp__stat--warn">
        {{ t('unmatched, {cause}', { cause }) }}: <strong :title="String(n)">{{ compactCount(n) }}</strong>
      </span>
      <span class="otp__stat otp__nodestat" tabindex="0" :aria-label="nodesText">
        {{ t('OAP nodes: {n} of {total} in this round', { n: nodesInRound, total: found.nodes.length }) }}
        <span class="otp__info" aria-hidden="true">ⓘ</span>
        <span class="otp__nodepop" aria-hidden="true">
          <span class="otp__nodepoph">{{ t('node') }}</span>
          <span class="otp__nodepoph otp__num">{{ t('calls matched') }}</span>
          <template v-for="n in nodesInfo" :key="n.address">
            <span class="otp__mono">{{ n.address }}</span>
            <span class="otp__num" :class="{ otp__warn: !n.counted }">{{ n.detail }}</span>
          </template>
        </span>
      </span>
    </div>

    <div class="otp__tabs">
      <div class="otp__kinds" role="group" :aria-label="t('kind')">
        <button
          v-for="k in kinds"
          :key="k.id"
          type="button"
          class="otp__tab"
          :class="{ 'otp__tab--active': kind === k.id }"
          :aria-pressed="kind === k.id"
          @click="kind = k.id"
        >
          {{ k.label }}
          <span class="otp__tabcount" :class="{ 'otp__tabcount--warn': k.warn && k.count > 0 }" :title="String(k.count)">
            {{ compactCount(k.count) }}
          </span>
        </button>
      </div>
      <input
        v-model="filter"
        class="otp__input otp__filter"
        type="search"
        :placeholder="t('filter by peer, service or trace id')"
      />
    </div>

    <section class="otp__panel">
      <p class="otp__sub">{{ t('each peer a caller dialed, matched to its server, and the pairings of either side that left unmatched; the most recent first') }}</p>
      <div v-if="listed.length === 0" class="otp__empty">{{ rows.length > 0 ? t('No matches') : t('No pairing seen yet.') }}</div>
      <table v-else class="otp__table">
        <thead>
          <tr>
            <th>{{ t('kind') }}</th>
            <th>{{ t('peer') }}</th>
            <th>{{ t('server') }}</th>
            <th>{{ t('callers') }}</th>
            <th class="otp__num">{{ t('count') }}</th>
            <th>{{ t('detail') }}</th>
            <th>{{ t('OAP') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in pageRows" :key="r.key">
            <td class="otp__nowrap" :class="{ otp__warn: r.kind !== 'matched' }" :title="t('last seen {time}', { time: localTime(r.lastTime) })">{{ kindLabel(r) }}</td>
            <td class="otp__mono otp__nowrap">{{ r.peer ?? '—' }}</td>
            <td>{{ r.server ?? '—' }}</td>
            <td class="otp__dim">{{ r.callers.length > 0 ? r.callers.join(', ') : '—' }}</td>
            <td class="otp__num" :title="String(r.count)">{{ compactCount(r.count) }}</td>
            <td>
              <template v-if="r.kind === 'matched'">
                <span v-if="r.address && registered(r)" class="otp__alias" :title="r.address">
                  <span class="otp__tag otp__tag--ok">{{ t('alias') }}</span>
                  <code class="otp__aliasaddr otp__aliasdialed">{{ aliasedAddress(r.address, r.peer) }}</code>
                  <span class="otp__dim">{{ t('represents') }}</span>
                  <code class="otp__aliasaddr otp__aliasserver">{{ r.server }}</code>
                </span>
                <span v-else-if="r.address" class="otp__alias otp__unregistered">
                  <span class="otp__tag otp__tag--warn">{{ t('alias') }}</span>
                  <code class="otp__aliasaddr">{{ r.address }}</code>
                  <span class="otp__warn" :title="countsText(r.outcomes ?? {}, true)">{{ t('not registered: {why}', { why: countsText(r.outcomes ?? {}) }) }}</span>
                </span>
                <div v-if="r.previousServer" class="otp__warn" :title="localTime(r.updatedTime ?? 0)">
                  {{ t('was {server}', { server: r.previousServer }) }}
                </div>
              </template>
              <template v-else>
                <span class="otp__detailline">
                  <span v-if="r.rules.length > 0" class="otp__alias">
                    <span class="otp__tag">{{ t('rule') }}</span>
                    <span class="otp__mono">{{ r.rules.join(', ') }}</span>
                  </span>
                  <span class="otp__warn otp__nowrap" :title="r.causes ? countsText(r.causes, true) : undefined">{{ r.causes ? countsText(r.causes) : '' }}</span>
                  <select
                    v-if="r.traceIds.length > 0"
                    class="otp__traces"
                    :aria-label="t('open the trace in TraceQL')"
                    :title="t('open the trace in TraceQL')"
                    @change="openPickedTrace($event, r.lastTime)"
                  >
                    <option value="">{{ t('open a trace ({n})', { n: r.traceIds.length }) }}</option>
                    <option v-for="id in r.traceIds" :key="id" :value="id">{{ id }}</option>
                  </select>
                </span>
              </template>
            </td>
            <td class="otp__mono otp__dim">
              <div v-for="node in r.nodes" :key="node" class="otp__nodeline">{{ node }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="pages > 1" class="otp__pager">
      <span class="otp__dim">{{ t('page {page} of {pages} · {total} rows', { page, pages, total: listed.length }) }}</span>
      <button type="button" class="otp__pagebtn" :disabled="page <= 1" @click="page--">{{ t('Prev') }}</button>
      <button type="button" class="otp__pagebtn" :disabled="page >= pages" @click="page++">{{ t('Next') }}</button>
    </div>
  </div>
</template>

<style scoped>
.otp__view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.otp__title {
  font-weight: var(--sw-fw-semibold);
  color: var(--rr-heading);
}

.otp__sub {
  margin: 0;
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
}

.otp__dim {
  color: var(--rr-dim);
}

.otp__summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 8px 12px;
  background: var(--rr-panel);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  font-size: var(--sw-fs-base);
}

.otp__stat strong {
  color: var(--rr-heading);
}

.otp__stat--warn strong {
  color: var(--rr-warn);
}

.otp__nodestat {
  position: relative;
  margin-left: auto;
  cursor: help;
}

.otp__nodestat:focus-visible {
  outline: 1px solid var(--rr-active);
  outline-offset: 2px;
}

/* Each node of the round, shown while the count is hovered or, on a click, focused. */
.otp__nodepop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  display: none;
  grid-template-columns: auto auto;
  gap: 4px 20px;
  padding: 8px 12px;
  background: var(--rr-panel);
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  box-shadow: 0 6px 18px rgb(0 0 0 / 22%);
  font-size: var(--sw-fs-sm);
  white-space: nowrap;
  cursor: default;
}

.otp__nodestat:hover .otp__nodepop,
.otp__nodestat:focus .otp__nodepop {
  display: grid;
}

.otp__nodepoph {
  padding-bottom: 2px;
  border-bottom: 1px solid var(--rr-border);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  color: var(--rr-dim);
}

.otp__info {
  color: var(--rr-dim);
}

.otp__kinds {
  display: flex;
  align-items: flex-end;
  gap: 4px;
}

/* One node a line, its address never broken. */
.otp__nodeline {
  white-space: nowrap;
}

.otp__tabs {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  border-bottom: 1px solid var(--rr-border);
}

.otp__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
  color: var(--rr-dim);
  cursor: pointer;
}

.otp__tab:hover {
  color: var(--rr-ink);
}

.otp__tab--active {
  color: var(--rr-heading);
  border-bottom-color: var(--rr-active);
}

.otp__tabcount {
  padding: 0 6px;
  border: 1px solid var(--rr-border2);
  border-radius: 8px;
  font-size: var(--sw-fs-sm);
  letter-spacing: 0;
  color: var(--rr-ink2);
}

.otp__tabcount--warn {
  border-color: var(--rr-warn);
  color: var(--rr-warn);
}

.otp__filter {
  margin: 0 0 6px auto;
  min-width: 30ch;
}

.otp__input {
  padding: 4px 8px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-ink);
}

.otp__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.otp__pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  font-size: var(--sw-fs-sm);
}

.otp__pagebtn {
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink);
  cursor: pointer;
}

.otp__pagebtn:disabled {
  opacity: 0.5;
  cursor: default;
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

.otp__alias {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  max-width: 100%;
}

.otp__tag {
  flex: none;
  padding: 0 5px;
  border-radius: var(--rr-radius-sm);
  background: var(--rr-bg2);
  color: var(--rr-dim);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.otp__tag--ok {
  background: color-mix(in srgb, var(--rr-ok) 16%, transparent);
  color: var(--rr-ok);
}

.otp__tag--warn {
  background: color-mix(in srgb, var(--rr-warn) 16%, transparent);
  color: var(--rr-warn);
}

.otp__aliasaddr {
  padding: 1px 6px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink);
  overflow-wrap: anywhere;
}

.otp__detailline {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}

/* The row's latest trace ids, each opening its trace when picked; the theme's color-scheme styles the open list. */
.otp__traces {
  max-width: 100%;
  padding: 1px 6px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink);
  cursor: pointer;
}

.otp__traces:hover,
.otp__traces:focus-visible {
  border-color: var(--rr-active);
  outline: none;
}
</style>
