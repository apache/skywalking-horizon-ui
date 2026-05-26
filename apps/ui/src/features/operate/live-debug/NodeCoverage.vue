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
 * Per-cluster install / collect coverage strip rendered above each
 * debugger waterfall.
 *
 * `peerAcks` come from the install fan-out's per-peer `InstallDebugSession`
 * acks; `nodeStatuses` come from the session response's `nodes[]` array
 * (collect-time status). The two correlate by node identity (peer
 * address or nodeId).
 *
 * Wire enums (from `DSLDebuggingRestHandler.java`):
 * - install ack: INSTALLED | NOT_LOCAL | ALREADY_INSTALLED | REJECTED |
 *   TOO_MANY_SESSIONS | FAILED.
 * - collect status: ok | captured | not_local | unreachable.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  InstallSummary,
  NodeSlice,
  PeerInstallAck,
  PriorCleanup,
} from '@skywalking-horizon-ui/api-client';
import Pill from '@/components/primitives/Pill.vue';

const { t } = useI18n();

const props = defineProps<{
  peerAcks: PeerInstallAck[];
  nodeStatuses: NodeSlice[];
  installed: InstallSummary | null;
  priorCleanup: PriorCleanup | null;
}>();

interface Row {
  /** Best-effort identity — prefer nodeId, fall back to peer address. */
  key: string;
  label: string;
  install: PeerInstallAck['ack'] | null;
  collect: NodeSlice['status'] | null;
}

function rowKey(nodeId?: string, peer?: string): string {
  return nodeId && nodeId.length > 0 ? `node:${nodeId}` : `peer:${peer ?? '?'}`;
}

function rowLabel(nodeId?: string, peer?: string): string {
  return nodeId && nodeId.length > 0 ? nodeId : (peer ?? '?');
}

const rows = computed<Row[]>(() => {
  const map = new Map<string, Row>();
  for (const a of props.peerAcks) {
    const k = rowKey(a.nodeId, a.peer);
    map.set(k, {
      key: k,
      label: rowLabel(a.nodeId, a.peer),
      install: a.ack,
      collect: null,
    });
  }
  for (const n of props.nodeStatuses) {
    const k = rowKey(n.nodeId, n.peer);
    const existing = map.get(k);
    if (existing) existing.collect = n.status;
    else
      map.set(k, {
        key: k,
        label: rowLabel(n.nodeId, n.peer),
        install: null,
        collect: n.status,
      });
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
});

function installTone(ack: PeerInstallAck['ack'] | null): 'ok' | 'warn' | 'err' | 'dim' {
  switch (ack) {
    case 'INSTALLED':
    case 'ALREADY_INSTALLED':
      return 'ok';
    case 'NOT_LOCAL':
      return 'dim';
    case 'TOO_MANY_SESSIONS':
    case 'REJECTED':
      return 'warn';
    case 'FAILED':
      return 'err';
    default:
      return 'dim';
  }
}

function collectTone(status: NodeSlice['status'] | null): 'ok' | 'warn' | 'err' | 'dim' {
  switch (status) {
    case 'ok':
    case 'captured':
      return 'ok';
    case 'not_local':
      return 'dim';
    case 'unreachable':
      return 'err';
    default:
      return 'dim';
  }
}

const cleanupSummary = computed<string>(() => {
  const c = props.priorCleanup;
  if (!c) return '';
  const localStopped = c.local.stoppedCount ?? 0;
  const peerStopped = c.peers.reduce(
    (n, p) => n + (p.stoppedCount ?? p.stoppedSessionIds?.length ?? 0),
    0,
  );
  const total = localStopped + peerStopped;
  if (total === 0) return '';
  const ids: string[] = [...(c.local.stoppedSessionIds ?? [])];
  for (const p of c.peers) {
    if (p.stoppedSessionIds) ids.push(...p.stoppedSessionIds);
  }
  return ids.length > 0
    ? t('replaced {n} prior sessions: {ids}', { n: total, ids: ids.join(', ') })
    : t('replaced {n} prior sessions', { n: total });
});
</script>

<template>
  <div class="cov">
    <div v-if="installed" class="cov__rollup">
      <span class="cov__label">{{ t('installed') }}</span>
      <Pill :tone="installed.created === 0 ? 'err' : installed.created === installed.total ? 'ok' : 'warn'">
        {{ installed.created }} / {{ installed.total }}
      </Pill>
      <span class="cov__rollupnote">
        {{ installed.created === installed.total
          ? t('session live on every reachable OAP')
          : installed.created === 0
            ? t('no node accepted')
            : t('live on {created} of {total} nodes', { created: installed.created, total: installed.total }) }}
      </span>
    </div>
    <div v-if="rows.length === 0" class="cov__empty">{{ t('no peers reported') }}</div>
    <div v-for="row in rows" :key="row.key" class="cov__row">
      <span class="cov__nodeid">{{ row.label }}</span>
      <span class="cov__pair">
        <span class="cov__label">{{ t('install') }}</span>
        <Pill :tone="installTone(row.install)">{{ row.install ?? '—' }}</Pill>
      </span>
      <span class="cov__pair">
        <span class="cov__label">{{ t('collect') }}</span>
        <Pill :tone="collectTone(row.collect)">{{ row.collect ?? '—' }}</Pill>
      </span>
    </div>
    <div v-if="cleanupSummary" class="cov__cleanup">{{ cleanupSummary }}</div>
  </div>
</template>

<style scoped>
.cov {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 8px 12px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  font-size: var(--sw-fs-base);
}

.cov__empty {
  color: var(--rr-dim);
}

.cov__row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 10px 2px 0;
}

.cov__nodeid {
  font-family: var(--rr-font-mono);
  color: var(--rr-heading);
  min-width: 80px;
}

.cov__pair {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.cov__label {
  color: var(--sw-fg-3);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
}

.cov__cleanup {
  flex-basis: 100%;
  color: var(--rr-dim);
  font-size: var(--sw-fs-sm);
  font-family: var(--rr-font-mono);
}

.cov__rollup {
  flex-basis: 100%;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--sw-fs-base);
}

.cov__rollupnote {
  color: var(--rr-dim);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
}
</style>
