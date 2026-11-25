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
 * The frames of a TAL capture, as a debugger lists a thread's frames: one
 * row per span the rule ran on. A native record is a segment, so its spans
 * list under it in wire order; an OTLP record is one span.
 */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { spanId, spanLabel, type TalFrame, type TalRecordView } from './talDebug.js';

defineProps<{
  records: readonly TalRecordView[];
  selectedKey: string | null;
  multiNode: boolean;
}>();

const emit = defineEmits<{ select: [frameKey: string] }>();

const { t } = useI18n();
const folded = ref<Set<string>>(new Set());

function toggle(key: string): void {
  const next = new Set(folded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  folded.value = next;
}

/** `HH:MM:SS.mmm` of a capture time. */
function clock(captureTime: string | undefined, startedAtMs: number): string {
  const ms = captureTime ? Number(captureTime.split('.')[0]) : startedAtMs;
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

type FrameState = 'none' | 'ok' | 'stopped' | 'failed';

function frameState(frame: TalFrame): FrameState {
  const run = frame.run;
  if (!run) return 'none';
  if (run.steps.some((s) => s.kind === 'failure')) return 'failed';
  return run.continueOn ? 'ok' : 'stopped';
}

const STATE_ICON: Record<FrameState, string> = { none: '·', ok: '✓', stopped: '⊘', failed: '✕' };

function stateTitle(frame: TalFrame): string {
  const state = frameState(frame);
  if (state === 'none') return t('the rule did not run on this span');
  if (state === 'ok') return t('ran to the end');
  return frame.run?.reason ?? '';
}

function segmentLabel(view: TalRecordView): string {
  const seg = view.record.context?.segment;
  if (!seg) return t('segment');
  return t('{service} · {n} spans', { service: seg.service, n: seg.spanCount });
}

function serviceOf(frame: TalFrame): string {
  const meta = frame.entry?.meta as Record<string, unknown> | undefined;
  const resource = frame.record.context?.resource;
  return String(meta?.service ?? resource?.['service.name'] ?? '');
}

</script>

<template>
  <div class="tfl">
    <div v-if="records.length === 0" class="tfl__empty">{{ t('No records captured yet.') }}</div>
    <div v-for="view in records" :key="view.key" class="tfl__rec">
      <template v-if="view.record.oversizedBytes !== undefined">
        <div class="tfl__head tfl__head--muted" :title="t('Larger than one message between OAP nodes; its content was not carried.')">
          <span class="tfl__idx">#{{ view.recordIndex }}</span>
          <span class="tfl__time">{{ clock(view.record.captureTime, view.record.startedAtMs) }}</span>
          <span class="tfl__label">{{ t('oversized record · {n} bytes', { n: view.record.oversizedBytes }) }}</span>
        </div>
      </template>

      <template v-else-if="view.kind === 'segment'">
        <button type="button" class="tfl__head" @click="toggle(view.key)">
          <span class="tfl__caret">{{ folded.has(view.key) ? '▸' : '▾' }}</span>
          <span class="tfl__idx">#{{ view.recordIndex }}</span>
          <span class="tfl__time">{{ clock(view.record.captureTime, view.record.startedAtMs) }}</span>
          <span class="tfl__label" :title="segmentLabel(view)">{{ segmentLabel(view) }}</span>
          <span v-if="multiNode" class="tfl__node">{{ view.nodeLabel }}</span>
        </button>
        <template v-if="!folded.has(view.key)">
          <button
            v-for="frame in view.frames"
            :key="frame.key"
            type="button"
            class="tfl__frame tfl__frame--nested"
            :class="[`tfl__frame--${frameState(frame)}`, { 'tfl__frame--selected': frame.key === selectedKey }]"
            :disabled="!frame.run"
            @click="emit('select', frame.key)"
          >
            <span class="tfl__icon" :title="stateTitle(frame)">{{ STATE_ICON[frameState(frame)] }}</span>
            <span class="tfl__sid">[{{ spanId(frame.entry) }}]</span>
            <span class="tfl__label" :title="spanLabel(frame.entry)">{{ spanLabel(frame.entry) }}</span>
            <span v-if="frame.run && frame.run.outputs.length > 0" class="tfl__out">→{{ frame.run.outputs.length }}</span>
          </button>
        </template>
      </template>

      <template v-else>
        <button
          v-for="frame in view.frames"
          :key="frame.key"
          type="button"
          class="tfl__frame"
          :class="[`tfl__frame--${frameState(frame)}`, { 'tfl__frame--selected': frame.key === selectedKey }]"
          @click="emit('select', frame.key)"
        >
          <span class="tfl__icon" :title="stateTitle(frame)">{{ STATE_ICON[frameState(frame)] }}</span>
          <span class="tfl__idx">#{{ view.recordIndex }}</span>
          <span class="tfl__time">{{ clock(view.record.captureTime, view.record.startedAtMs) }}</span>
          <span class="tfl__label" :title="`${spanLabel(frame.entry)} · ${serviceOf(frame)}`">{{ spanLabel(frame.entry) }}<span class="tfl__svc"> · {{ serviceOf(frame) }}</span></span>
          <span v-if="multiNode" class="tfl__node">{{ view.nodeLabel }}</span>
          <span v-if="frame.run && frame.run.outputs.length > 0" class="tfl__out">→{{ frame.run.outputs.length }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tfl {
  display: flex;
  flex-direction: column;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  overflow: auto;
  min-height: 0;
}

.tfl__empty {
  padding: 12px;
  color: var(--rr-dim);
}

.tfl__rec {
  border-bottom: 1px solid var(--rr-border);
}

.tfl__head,
.tfl__frame {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  font: inherit;
  color: var(--rr-ink);
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.tfl__head {
  color: var(--rr-heading);
  background: var(--rr-bg);
}

.tfl__head--muted {
  color: var(--rr-dim);
  cursor: default;
}

.tfl__frame--nested {
  padding-left: 26px;
}

.tfl__frame:hover:not(:disabled) {
  background: var(--rr-bg3);
}

.tfl__frame:disabled {
  cursor: default;
  color: var(--rr-dim);
}

.tfl__frame--selected {
  background: var(--sw-accent-soft);
  border-left-color: var(--rr-active);
}

.tfl__caret {
  width: 10px;
  color: var(--rr-dim);
}

.tfl__idx,
.tfl__time,
.tfl__sid,
.tfl__svc,
.tfl__node {
  color: var(--rr-dim);
}

.tfl__label {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1 1 auto;
}

.tfl__icon {
  width: 12px;
  text-align: center;
}

.tfl__frame--ok .tfl__icon {
  color: var(--rr-ok);
}

.tfl__frame--stopped .tfl__icon {
  color: var(--rr-warn);
}

.tfl__frame--failed .tfl__icon {
  color: var(--rr-err);
}

.tfl__out {
  color: var(--rr-accent);
}
</style>
