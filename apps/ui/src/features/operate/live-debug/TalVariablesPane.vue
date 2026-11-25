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
 * The selected span beside the rule file: the span as it was received, the
 * variables the rule set by the current step, what the run sent out and
 * what it changed on the span, then what the rule reads besides the span,
 * and the rule. Every field is a line with its value in gray, opening under
 * itself on click.
 *
 * It shares one selection with the rule file: a name picked in either is
 * highlighted in both, and an output goes to the line that sent it.
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TalFrame, TalLocal, TalOutputLink } from './talDebug.js';
import { displayValue, outputDisplay, outputSummary, paneFieldOf, ruleNameOf, shortValue } from './talDebug.js';
import TalFieldLines from './TalFieldLines.vue';
import TalValueTree from './TalValueTree.vue';

const props = defineProps<{
  frame: TalFrame | null;
  stepIndex: number;
  /** The run's outputs, each with the statement that sent it. */
  outputs: readonly TalOutputLink[];
  /** The names the rule set by the current step, with their values then. */
  locals: Record<string, TalLocal>;
  /** The name selected in either pane, as the rule writes it. */
  selectedName: string | null;
  /** The rule-file line open under the current selection. */
  openRowLine: number | null;
  /** The frame on screen, its capture included: a frame's key repeats across captures, and what is opened here is the
   *  frame's own. */
  frameKey: string;
}>();

const emit = defineEmits<{
  go: [link: TalOutputLink];
  /** Step to the statement that gave a variable its value. */
  'go-step': [step: number, line: number];
  'select-name': [name: string | null];
}>();

/** Variables and outputs opened under their row; opening one moves nothing. */
const opened = ref<Set<string>>(new Set());
// What was opened belonged to the span on screen.
watch(
  () => props.frameKey,
  () => (opened.value = new Set()),
);

function toggleOpen(id: string): void {
  const next = new Set(opened.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  opened.value = next;
}

/** A variable picked here opens and is highlighted in both panes. */
function pickLocal(name: string): void {
  toggleOpen(`locals.${name}`);
  emit('select-name', name === props.selectedName ? null : name);
}

function outputFields(link: TalOutputLink): Record<string, unknown> {
  return outputDisplay(link.output);
}

const { t } = useI18n();

/** The field the selected name shows as here. */
const highlight = computed(() => paneFieldOf(props.selectedName, props.locals));

/** A field picked here selects the name the rule reads it by, if any. */
function pick(field: string): void {
  const name = ruleNameOf(field);
  if (name) emit('select-name', name === props.selectedName ? null : name);
}

const current = computed(() => props.frame?.run?.steps[props.stepIndex] ?? null);

interface Change {
  label: string;
  before?: unknown;
  after: unknown;
}

/**
 * What the run left behind, which differs by input. A native run's state is
 * the segment variables it set, which every later run of the rule on the
 * segment reads. An OTLP run can overwrite `service`, `instance`,
 * `endpoint` and `layer` in its own copy of the span's metadata — used by
 * its outputs only; the stored span and the other rules keep the span's
 * own — and reaches the stored span only by the tags it adds and its
 * persist vote. Each part shows only when the run did it.
 */
const effects = computed<{ native: Change[] | null; identity: Change[]; stored: Change[] } | null>(() => {
  const state = props.frame?.run?.state as Record<string, unknown> | undefined;
  if (!state) return null;
  if ('segmentDefs' in state) {
    const defs = (state.segmentDefs ?? {}) as Record<string, unknown>;
    return { native: Object.entries(defs).map(([label, after]) => ({ label, after })), identity: [], stored: [] };
  }
  const received = (props.frame?.entry?.meta ?? {}) as Record<string, unknown>;
  const identity: Change[] = [];
  for (const [key, after] of Object.entries((state.meta ?? {}) as Record<string, unknown>)) {
    if (received[key] !== after) identity.push({ label: key, before: received[key], after });
  }
  const stored: Change[] = Object.entries((state.tags ?? {}) as Record<string, unknown>).map(([key, after]) => ({
    label: `tag ${key}`,
    after,
  }));
  if (state.persist !== undefined) stored.push({ label: 'persist', after: state.persist });
  return { native: null, identity, stored };
});

interface ReadPart {
  path: string;
  label: string;
  value: unknown;
}

/** What the rule reads besides the span: a native segment and what the
 *  analyzer computes from it, or an OTLP span's resource and scope. */
const reads = computed<ReadPart[]>(() => {
  const ctx = props.frame?.record.context;
  if (!ctx) return [];
  if (ctx.kind === 'segment') {
    return [
      { path: 'segment', label: t('Segment'), value: ctx.segment ?? {} },
      { path: 'derived', label: t('Computed by the analyzer before the rules ran'), value: ctx.derived ?? {} },
    ];
  }
  return [
    { path: 'resource', label: t('Resource attributes'), value: ctx.resource ?? {} },
    { path: 'scope', label: t('Instrumentation scope attributes'), value: ctx.scope ?? {} },
  ];
});

const closed = ref<Set<string>>(new Set(['rule']));

function toggle(id: string): void {
  const next = new Set(closed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  closed.value = next;
}

/** An output the run sends after the current step is not out yet. */
function pending(link: TalOutputLink): boolean {
  return link.step !== null && link.step > props.stepIndex;
}
</script>

<template>
  <div class="tvp">
    <div v-if="!frame" class="tvp__empty">{{ t('Select a captured span to see it here.') }}</div>

    <template v-else>
      <section class="tvp__sec">
        <button type="button" class="tvp__sech" @click="toggle('input')">
          <span class="tvp__caret">{{ closed.has('input') ? '▸' : '▾' }}</span>
          <span class="tvp__title">{{ t('Span received') }}</span>
          <span class="tvp__hint">{{ t('what the rule read') }}</span>
        </button>
        <div v-if="!closed.has('input')" class="tvp__secb">
          <TalFieldLines :key="`${frameKey}:span`" :value="frame.entry?.span ?? {}" path="span" :highlight="highlight" @pick="pick" />
          <template v-if="frame.entry?.meta">
            <div class="tvp__sub">{{ t('Span metadata, as the receiver read it') }}</div>
            <TalFieldLines :key="`${frameKey}:meta`" :value="frame.entry.meta" path="meta" :highlight="highlight" @pick="pick" />
          </template>
        </div>
      </section>

      <section v-if="frame.run" class="tvp__sec">
        <button type="button" class="tvp__sech" @click="toggle('locals')">
          <span class="tvp__caret">{{ closed.has('locals') ? '▸' : '▾' }}</span>
          <span class="tvp__title">{{ t('Variables set by the rule') }}</span>
          <span class="tvp__hint">{{ current?.sourceLine
            ? t('as of step {n}, line {line}', { n: stepIndex + 1, line: current.sourceLine })
            : t('at this step') }}</span>
        </button>
        <div v-if="!closed.has('locals')" class="tvp__secb">
          <div v-if="Object.keys(locals).length === 0" class="tvp__none">
            {{ t('The run has set no variable by this step, or the capture is by block.') }}
          </div>
          <template v-for="(local, name) in locals" :key="name">
            <div class="tvp__local" :class="{ 'tvp__local--marked': highlight === `locals.${name}` }">
              <button type="button" class="tvp__localrow" @click="pickLocal(String(name))">
                <span class="tvp__caret">{{ local.value !== null && typeof local.value === 'object' ? (opened.has(`locals.${name}`) ? '▾' : '▸') : '' }}</span>
                <span class="tvp__changek">{{ name }}</span>
                <span class="tvp__after">{{ shortValue(local.value) }}</span>
              </button>
              <button
                type="button"
                class="tvp__goline"
                :title="t('go to the statement that set this value')"
                @click="emit('go-step', local.step, local.line)"
              >{{ t('line {n}', { n: local.line }) }} →</button>
            </div>
            <div v-if="opened.has(`locals.${name}`) && local.value !== null && typeof local.value === 'object'" class="tvp__open">
              <TalValueTree :value="displayValue(local.value)" :open-depth="2" />
            </div>
          </template>
        </div>
      </section>

      <section class="tvp__sec">
        <button type="button" class="tvp__sech" @click="toggle('output')">
          <span class="tvp__caret">{{ closed.has('output') ? '▸' : '▾' }}</span>
          <span class="tvp__title">{{ t('Sent out by the run') }}</span>
          <span class="tvp__count">{{ outputs.length }}</span>
        </button>
        <div v-if="!closed.has('output')" class="tvp__secb">
          <div v-if="!frame.run" class="tvp__none">{{ t('the rule did not run on this span') }}</div>
          <div v-else-if="outputs.length === 0" class="tvp__none">{{ t('The run sent nothing out.') }}</div>
          <template v-for="link in outputs" :key="link.index">
            <div
              class="tvp__outrowwrap"
              :class="{
                'tvp__out--current': current?.output === link.index || (openRowLine !== null && link.line === openRowLine),
                'tvp__out--pending': pending(link),
              }"
            >
              <button
                type="button"
                class="tvp__out"
                :title="link.output.kind === 'pairing'
                  ? t('This span’s half of the call. The rule only asked for it; the trace analyzer sent it after every rule of the span ran, for the first rule that asked, to the node that owns the trace.')
                  : undefined"
                @click="toggleOpen(`output.${link.index}`)"
              >
                <span class="tvp__caret">{{ opened.has(`output.${link.index}`) ? '▾' : '▸' }}</span>
                <span class="tvp__outkind" :class="`tvp__outkind--${link.output.kind}`">{{ link.output.kind }}</span>
                <span class="tvp__outname">{{ link.name }}</span>
                <span class="tvp__outsum">{{ outputSummary(link.output) }}</span>
              </button>
              <button
                v-if="link.line !== null"
                type="button"
                class="tvp__goline"
                :title="t('go to the statement that sent it')"
                @click="emit('go', link)"
              >{{ t('line {n}', { n: link.line }) }} →</button>
            </div>
            <div v-if="opened.has(`output.${link.index}`)" class="tvp__open">
              <TalValueTree :value="outputFields(link)" :open-depth="2" />
            </div>
          </template>
        </div>
      </section>

      <section v-if="effects?.native" class="tvp__sec">
        <button type="button" class="tvp__sech" @click="toggle('segdefs')">
          <span class="tvp__caret">{{ closed.has('segdefs') ? '▸' : '▾' }}</span>
          <span class="tvp__title">{{ t('Segment variables after the run') }}</span>
        </button>
        <div v-if="!closed.has('segdefs')" class="tvp__secb">
          <div v-if="effects.native.length === 0" class="tvp__none">{{ t('The rule set no segment variable.') }}</div>
          <div v-for="row in effects.native" :key="row.label" class="tvp__change">
            <span class="tvp__changek">{{ row.label }}</span>
            <span class="tvp__after">{{ shortValue(row.after) }}</span>
          </div>
        </div>
      </section>

      <section v-if="effects && effects.identity.length > 0" class="tvp__sec">
        <button type="button" class="tvp__sech" @click="toggle('identity')">
          <span class="tvp__caret">{{ closed.has('identity') ? '▸' : '▾' }}</span>
          <span class="tvp__title">{{ t('Identity overwritten for this run') }}</span>
          <span class="tvp__hint">{{ t('its outputs use it; the stored span keeps its own') }}</span>
        </button>
        <div v-if="!closed.has('identity')" class="tvp__secb">
          <div v-for="row in effects.identity" :key="row.label" class="tvp__change">
            <span class="tvp__changek">{{ row.label }}</span>
            <span class="tvp__before">{{ shortValue(row.before) }}</span>
            <span class="tvp__arrow">→</span>
            <span class="tvp__after">{{ shortValue(row.after) }}</span>
          </div>
        </div>
      </section>

      <section v-if="effects && effects.stored.length > 0" class="tvp__sec">
        <button type="button" class="tvp__sech" @click="toggle('stored')">
          <span class="tvp__caret">{{ closed.has('stored') ? '▸' : '▾' }}</span>
          <span class="tvp__title">{{ t('Added to the stored span') }}</span>
          <span class="tvp__hint">{{ t('tags and persist vote') }}</span>
        </button>
        <div v-if="!closed.has('stored')" class="tvp__secb">
          <div v-for="row in effects.stored" :key="row.label" class="tvp__change">
            <span class="tvp__changek">{{ row.label }}</span>
            <span class="tvp__after">{{ shortValue(row.after) }}</span>
          </div>
        </div>
      </section>

      <section v-if="reads.length > 0" class="tvp__sec">
        <button type="button" class="tvp__sech" @click="toggle('reads')">
          <span class="tvp__caret">{{ closed.has('reads') ? '▸' : '▾' }}</span>
          <span class="tvp__title">{{ t('Also read by the rule') }}</span>
        </button>
        <div v-if="!closed.has('reads')" class="tvp__secb">
          <template v-for="part in reads" :key="`${frameKey}:${part.path}`">
            <div class="tvp__sub">{{ part.label }}</div>
            <TalFieldLines :value="part.value" :path="part.path" :highlight="highlight" @pick="pick" />
          </template>
        </div>
      </section>

      <section class="tvp__sec">
        <button type="button" class="tvp__sech" @click="toggle('rule')">
          <span class="tvp__caret">{{ closed.has('rule') ? '▸' : '▾' }}</span>
          <span class="tvp__title">{{ t('Rule definition') }}</span>
        </button>
        <div v-if="!closed.has('rule')" class="tvp__secb">
          <TalFieldLines :key="`${frameKey}:rule`" :value="frame.record.rule" path="rule" :highlight="highlight" @pick="pick" />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.tvp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  font-size: var(--sw-fs-sm);
}

.tvp__empty,
.tvp__none {
  padding: 6px 4px;
  font-family: var(--rr-font-ui);
  color: var(--rr-dim);
}

/* Headings are UI text, the data under them monospace. */
.tvp__sech {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  background: var(--rr-bg3);
  border: 0;
  border-left: 3px solid var(--rr-accent);
  border-top: 1px solid var(--rr-border);
  font-family: var(--rr-font-ui);
  font-size: var(--sw-fs-base);
  text-align: left;
  cursor: pointer;
}

.tvp__caret {
  width: 10px;
  color: var(--rr-dim);
}

.tvp__title {
  font-weight: var(--sw-fw-semibold);
  color: var(--rr-heading);
}

.tvp__hint {
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
}

.tvp__count {
  padding: 0 6px;
  border-radius: var(--rr-radius-sm);
  background: var(--rr-bg);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-ink2);
}

.tvp__secb {
  padding: 4px 8px 10px;
}

.tvp__sub {
  margin: 8px 0 2px;
  padding-bottom: 2px;
  border-bottom: 1px dashed var(--rr-border);
  font-family: var(--rr-font-ui);
  font-size: var(--sw-fs-sm);
  color: var(--rr-info);
}

.tvp__outrowwrap,
.tvp__local {
  display: flex;
  align-items: baseline;
  gap: 6px;
  border-left: 2px solid transparent;
}

.tvp__local--marked {
  background: var(--sw-info-soft);
  border-left-color: var(--rr-info);
}

.tvp__out,
.tvp__localrow {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 1px 2px;
  background: transparent;
  border: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  line-height: 1.6;
  text-align: left;
  cursor: pointer;
}

.tvp__out:hover,
.tvp__localrow:hover {
  background: var(--rr-bg3);
}

/* The one control that moves the rule file: an explicit go-to-line. */
.tvp__goline {
  flex-shrink: 0;
  padding: 0 6px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-active);
  cursor: pointer;
}

.tvp__goline:hover {
  border-color: var(--rr-active);
}

.tvp__open {
  margin: 0 0 4px 16px;
  padding: 4px 8px;
  background: var(--rr-bg);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
}

.tvp__out--current {
  border-left-color: var(--rr-active);
  background: var(--sw-accent-soft);
}

.tvp__out--pending {
  opacity: 0.45;
}

.tvp__outkind {
  flex-shrink: 0;
  color: var(--rr-accent);
}

.tvp__outkind--pairing,
.tvp__outkind--writeNetworkAlias {
  color: var(--rr-info);
}

.tvp__outkind--persist {
  color: var(--rr-warn);
}

.tvp__outname {
  flex-shrink: 0;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rr-ink);
}

.tvp__outsum {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: italic;
  color: var(--rr-dim);
}

.tvp__change {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 1px 4px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  line-height: 1.6;
}

.tvp__changek {
  flex-shrink: 0;
  min-width: 9ch;
  color: var(--rr-ink);
}

.tvp__before {
  color: var(--rr-dim);
  text-decoration: line-through;
}

.tvp__arrow {
  color: var(--rr-dim);
}

.tvp__after {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rr-ok);
}
</style>
