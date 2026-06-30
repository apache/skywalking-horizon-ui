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
<script setup lang="ts" generic="N extends NodeSlice">
/**
 * Shared shell for the three live-debugger views (MAL / LAL / OAL).
 *
 * The three DSLs share most of the page: a controls header (rule
 * picker, recordCap, retentionMinutes, start/stop), a state pill +
 * sessionId display, an error strip, NodeCoverage, and a per-node
 * capture-card scaffold (header with id + status pill + totalBytes,
 * empty state, scrollable body).
 *
 * What they don't share is what goes inside each card. This component
 * provides slots for that DSL-specific content:
 *
 *   - `controls`:   the picker + cap inputs + start/stop buttons.
 *   - `subhead`:    optional sub-header strip below the controls
 *                   (e.g. selected-source card for OAL, granularity
 *                   reminder for LAL).
 *   - `idle-hint`:  the "pick a rule and hit start" hint shown when
 *                   the session is idle.
 *   - `empty`:      the per-node empty-state copy ("no LAL records
 *                   from this node"). Falls back to a generic line.
 *   - `node-body`:  the per-node body (the actual records table).
 *                   Receives `{ node }` as the slot prop.
 *
 * The shell owns the polling-state plumbing — it reads from the
 * passed-in `dbg` (a UseDebugSessionResult) and the typed
 * `nodeViews` array. Each per-DSL view is now a thin wrapper:
 * `<DebugView>` + the DSL's picker + the DSL's row renderer.
 */
import type {
  InstallSummary,
  NodeSlice,
  PeerInstallAck,
  PriorCleanup,
  SessionResponse,
} from '@skywalking-horizon-ui/api-client';
import { computed, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Pill from '@/components/primitives/Pill.vue';
import NodeCoverage from './NodeCoverage.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    /** Composable handle. Templates read `.value` on each ref. */
    dbg: {
      state: Ref<string>;
      sessionId: Ref<string | null>;
      error: Ref<string | null>;
      session: Ref<SessionResponse | null>;
      peerAcks: Ref<PeerInstallAck[]>;
      installed: Ref<InstallSummary | null>;
      priorCleanup: Ref<PriorCleanup | null>;
    };
    /** Per-node pre-shaped view rows. The DSL's `nodeViews` computed
     *  returns NodeSlice-derived objects; the shell only needs
     *  `nodeId`, `peer`, `status`, `totalBytes` to render the card
     *  header — actual record rendering is done by the `node-body`
     *  slot. */
    nodeViews: N[];
    /** Controlled visibility for the source-pane sidecar. The parent
     *  decides when it's relevant (typically when the operator has
     *  selected a step row). Default false → no sidecar at all. */
    sourceOpen?: boolean;
    /** Optional override for the rendered session — when a saved
     *  capture is being viewed from history, the parent supplies it
     *  here so DebugView gates its capture section on the saved data
     *  instead of the live composable's `session`. Live polling
     *  state (peerAcks, NodeCoverage) is suppressed in that mode. */
    viewSession?: SessionResponse | null;
  }>(),
  { sourceOpen: false, viewSession: null },
);

/** True when the parent is forcing a non-live view (history replay). */
const isHistorical = computed(() => props.viewSession !== null && props.viewSession !== undefined);
const effectiveSession = computed<SessionResponse | null>(
  () => props.viewSession ?? props.dbg.session.value,
);

const slots = defineSlots<{
  controls(): unknown;
  subhead(): unknown;
  /** Banner rendered above the capture section — typically used to
   *  surface the "viewing historical capture" state with a back-to-live
   *  control. The shell adds no chrome of its own. */
  banner(): unknown;
  'idle-hint'(): unknown;
  empty(props: { node: N }): unknown;
  'node-body'(props: { node: N }): unknown;
  /** Optional source-pane sidecar — when supplied, the capture
   *  section becomes a two-column grid with node cards on the left
   *  and the source pane on the right. */
  'source-pane'(): unknown;
}>();

const hasSourcePane = computed(() => slots['source-pane'] !== undefined);
/** Source pane is rendered iff a slot was provided AND the parent
 *  flagged it open (typically driven by step-row selection). */
const sourceVisible = computed(() => hasSourcePane.value && props.sourceOpen);

function nodeKey(n: NodeSlice): string {
  return n.nodeId ?? n.peer ?? '?';
}

function nodeStatusTone(status: NodeSlice['status']): 'ok' | 'info' | 'warn' | 'err' | 'dim' {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'captured':
      return 'info';
    case 'not_local':
      return 'dim';
    case 'unreachable':
      return 'err';
    default:
      return 'warn';
  }
}
</script>

<template>
  <div class="dv">
    <header class="dv__controls">
      <slot name="controls" />
      <span class="dv__statepill">
        <Pill
          :tone="dbg.state.value === 'capturing'
            ? 'active'
            : dbg.state.value === 'error'
              ? 'err'
              : 'dim'"
        >
          {{ dbg.state.value }}
        </Pill>
        <code
          v-if="dbg.sessionId.value"
          class="dv__sid"
          :title="dbg.sessionId.value"
        >{{ dbg.sessionId.value.slice(0, 8) }}…</code>
      </span>
    </header>

    <slot name="subhead" />

    <p v-if="dbg.error.value" class="dv__error">{{ dbg.error.value }}</p>

    <NodeCoverage
      v-if="!isHistorical && (dbg.peerAcks.value.length > 0 || (dbg.session.value?.nodes?.length ?? 0) > 0)"
      :peer-acks="dbg.peerAcks.value"
      :node-statuses="dbg.session.value?.nodes ?? []"
      :installed="dbg.installed.value ?? null"
      :prior-cleanup="dbg.priorCleanup.value ?? null"
    />

    <slot name="banner" />

    <section v-if="effectiveSession" class="dv__capture">
      <header class="dv__captureh">
        <span class="dv__sid2">{{ t('session {id}', { id: effectiveSession.sessionId }) }}</span>
      </header>

      <div v-if="sourceVisible" class="dv__sourcepane">
        <slot name="source-pane" />
      </div>

      <div class="dv__nodes">
        <div v-for="node in nodeViews" :key="nodeKey(node)" class="dv__node">
          <header class="dv__nodeh">
            <span class="dv__nodeid">{{ nodeKey(node) }}</span>
            <Pill :tone="nodeStatusTone(node.status)">{{ node.status }}</Pill>
            <span v-if="node.totalBytes !== undefined" class="dv__bytes">
              {{ t('{n} bytes', { n: node.totalBytes }) }}
            </span>
          </header>
          <slot name="node-body" :node="node">
            <slot name="empty" :node="node">
              <div class="dv__nodeempty">{{ t('no records from this node') }}</div>
            </slot>
          </slot>
        </div>
        <!-- effectiveSession is set but no nodes were ever populated.
             Most common in history replay: the capture was archived
             before the first poll cycle returned data. Surface this
             explicitly so the view doesn't look broken. -->
        <div v-if="nodeViews.length === 0" class="dv__nodeempty dv__sessionempty">
          <template v-if="isHistorical">
            {{ t('This capture has no records — the session was archived before any data arrived. Try a longer-running capture.') }}
          </template>
          <template v-else>
            {{ t('Waiting for the first poll to return records…') }}
          </template>
        </div>
      </div>
    </section>

    <p v-else-if="dbg.state.value === 'idle'" class="dv__hint">
      <slot name="idle-hint">
        {{ t("pick a rule and hit start. each session captures one rule's pipeline stages on every cluster node simultaneously.") }}
      </slot>
    </p>
  </div>
</template>

<style scoped>
.dv {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dv__controls {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.dv__statepill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.dv__sid {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
}

.dv__error {
  padding: 8px 12px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-err, #f44);
  color: var(--rr-err, #f44);
  font-size: var(--sw-fs-base);
  margin: 0;
}

.dv__capture {
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  padding: 12px;
}

.dv__captureh {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dv__sid2 {
  font-family: var(--rr-font-mono);
  color: var(--rr-heading);
  font-size: var(--sw-fs-base);
}

.dv__sourcepane {
  display: flex;
  flex-direction: column;
  /* Cap height so the source body scrolls inside the pane rather
     than pushing the records below it off-screen. */
  max-height: 260px;
  min-height: 0;
}

.dv__nodes {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dv__node {
  border: 1px solid var(--rr-border);
}

.dv__nodeh {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--rr-bg3);
  border-bottom: 1px solid var(--rr-border);
}

.dv__nodeid {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-heading);
}

.dv__bytes {
  margin-left: auto;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
}

.dv__nodeempty {
  padding: 14px;
  font-size: var(--sw-fs-base);
  color: var(--rr-dim);
  font-style: italic;
}

.dv__hint {
  padding: 14px 18px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  color: var(--rr-dim);
  font-size: var(--sw-fs-base);
  margin: 0;
}
</style>
