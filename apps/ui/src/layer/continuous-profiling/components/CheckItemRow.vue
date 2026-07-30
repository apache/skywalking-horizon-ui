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

<!-- One armed condition inside a policy target. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  ContinuousProfilingMonitorType,
  ContinuousProfilingPolicyItem,
} from '@skywalking-horizon-ui/api-client';
import Btn from '@/components/primitives/Btn.vue';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import Icon from '@/components/icons/Icon.vue';
import {
  MONITOR_TYPES,
  THRESHOLD_SPEC,
  modeOf,
  shouldReseedUriMode,
  supportsUriFilter,
  thresholdError,
  type UriMode,
} from '../data';

const props = defineProps<{
  item: ContinuousProfilingPolicyItem;
  /** Measurements already used by sibling conditions in this target. */
  taken: ContinuousProfilingMonitorType[];
  removable: boolean;
}>();
const emit = defineEmits<{ update: [ContinuousProfilingPolicyItem]; remove: [] }>();

const { t } = useI18n();

// The unit rides on the OPTION too, so the format is known before the type is
// even chosen — the enum name alone says nothing about what to type.
const monitorOptions = computed(() =>
  MONITOR_TYPES.filter((m) => m === props.item.type || !props.taken.includes(m)).map((m) => ({
    value: m,
    label: m,
    hint: t(THRESHOLD_SPEC[m].measures),
  })),
);
const spec = computed(() => THRESHOLD_SPEC[props.item.type]);
/** OAP answers a bad policy with ONE string for the first bad item, so without
 *  this the operator bisects their own rules. */
const thresholdBad = computed(() => thresholdError(props.item.type, props.item.threshold));
const rangeHint = computed(() =>
  spec.value.max === null
    ? t('whole number, greater than 0')
    : t('whole number, 1–{max}', { max: spec.value.max }),
);
/** OAP validates all three: whole numbers above zero, and
 *  "count must be equal to or smaller than period". */
const periodBad = computed(() => !Number.isInteger(props.item.period) || props.item.period <= 0);
const countBad = computed(
  () =>
    !Number.isInteger(props.item.count) ||
    props.item.count <= 0 ||
    (Number.isInteger(props.item.period) && props.item.count > props.item.period),
);
const countHint = computed(() =>
  Number.isInteger(props.item.count) && props.item.count > 0
    ? t('Cannot exceed the period.')
    : t('Whole number, greater than 0.'),
);
const showUri = computed(() => supportsUriFilter(props.item.type));
const uriListText = computed(() => (props.item.uriList ?? []).join('\n'));

/** A check item carrying BOTH a list and a regex passes every backend check —
 *  Rover's http_checker just takes the list and ignores the regex. Nothing
 *  upstream will catch it, so the form is what keeps the choice explicit. */
function patch(part: Partial<ContinuousProfilingPolicyItem>): void {
  emit('update', { ...props.item, ...part });
}

function changeMonitor(type: ContinuousProfilingMonitorType): void {
  pendingMode.value = null;
  // A URI filter left on a non-HTTP monitor still ships, from a field the form
  // no longer shows.
  patch(supportsUriFilter(type) ? { type } : { type, uriList: undefined, uriRegex: undefined });
}

// The mode is its own state, only SEEDED from the item. Deriving it cannot
// work: picking "URI list" clears the regex, leaving both sides empty, which
// derives back to "All traffic". `modeOf` / `shouldReseedUriMode` are pure
// and unit-tested in ../data.test.ts.
const uriMode = ref<UriMode>(modeOf(props.item));
/** Set while a switch is waiting on confirmation, because it would erase a
 *  value the operator typed. Declared ABOVE the watchers below — they clear
 *  it, so it must exist before either can run (Vue compiles `<script setup>`
 *  top-to-bottom; a `const` referenced before its own line is a TDZ error). */
const pendingMode = ref<UriMode | null>(null);
/** Re-seed when the item changes underneath us, never on our own edits. A
 *  pending confirmation belongs to the item this row was PREVIOUSLY showing;
 *  carrying it onto a different item lets "Clear and switch" erase a field
 *  the operator never touched. */
watch(
  () => props.item.type,
  () => {
    uriMode.value = modeOf(props.item);
    pendingMode.value = null;
  },
);
/** Removing a condition shifts every row below it onto a different item at the
 *  same index (`:key="i"` in the parent, not the item's own identity — see
 *  PolicyTargetCard.vue). Our own edits only move the item toward the mode
 *  already held, so a different AND non-empty incoming mode means the row was
 *  swapped onto an unrelated item and any pending confirmation is stale. */
watch(
  () => modeOf(props.item),
  (incoming) => {
    if (shouldReseedUriMode(incoming, uriMode.value)) {
      uriMode.value = incoming;
      pendingMode.value = null;
    }
  },
);

/** A rule written outside Horizon can carry BOTH fields; `modeOf` picks one,
 *  leaving the other invisible and the policy unsavable. */
const conflicted = computed(
  () => (props.item.uriList ?? []).length > 0 && !!props.item.uriRegex,
);

const currentHasValue = computed(
  () => (props.item.uriList ?? []).length > 0 || !!props.item.uriRegex,
);

function applyMode(mode: UriMode): void {
  uriMode.value = mode;
  pendingMode.value = null;
  // Only one side may be sent, so the other is dropped as the mode changes.
  if (mode === 'none') patch({ uriList: undefined, uriRegex: undefined });
  else if (mode === 'list') patch({ uriRegex: undefined });
  else patch({ uriList: undefined });
}

/** One source for both the chip and the warning sentence. */
function modeLabel(mode: UriMode): string {
  if (mode === 'none') return t('All traffic');
  return mode === 'list' ? t('URI list') : t('URI regex');
}

const modeHint = computed(() => {
  if (uriMode.value === 'none') return t('Every request counts toward the threshold.');
  if (uriMode.value === 'list') return t('Only the URIs listed below count. A list excludes a regex.');
  return t('Only URIs matching the pattern below count. A regex excludes a list.');
});

function setUriMode(mode: UriMode): void {
  if (mode === uriMode.value) return;
  // Never discard typed input silently — ask, and name what goes.
  if (currentHasValue.value) {
    pendingMode.value = mode;
    return;
  }
  applyMode(mode);
}

function changeUriList(raw: string): void {
  const list = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  patch({ uriList: list.length ? list : undefined });
}
</script>

<template>
  <div class="check-item">
    <div class="grid">
      <label class="field">
        <!-- OAP calls this field `ContinuousProfilingMonitorType` and documents
             it as "the monitor type to collect metrics". Every value is a
             MEASUREMENT — process CPU, thread count, load, error rate, response
             time — so the label says what is being picked; the enum values
             stay verbatim, as OAP vocabulary always does. -->
        <span class="label">{{ t('Measurement') }}</span>
        <TypeaheadSelect
          :model-value="item.type"
          :options="monitorOptions"
          :aria-label="t('Measurement')"
          @update:model-value="changeMonitor($event as ContinuousProfilingMonitorType)"
        />
      </label>

      <label class="field">
        <span class="label">
          {{ t('Threshold') }}
          <em class="hint">{{ rangeHint }}</em>
        </span>
        <span class="with-unit" :class="{ bad: thresholdBad }">
          <input
            class="input"
            type="number"
            min="1"
            step="1"
            :max="spec.max ?? undefined"
            :value="item.threshold"
            :placeholder="spec.example"
            @input="patch({ threshold: ($event.target as HTMLInputElement).value })"
          />
          <span class="unit">{{ t(spec.unit) }}</span>
        </span>
        <em v-if="thresholdBad" class="bad-hint">{{ t(thresholdBad.key, thresholdBad.params ?? {}) }}</em>
      </label>

      <label class="field narrow">
        <span class="label">{{ t('Period (seconds)') }}</span>
        <input
          class="input"
          type="number"
          min="1"
          step="1"
          :class="{ bad: periodBad }"
          :value="item.period"
          @input="patch({ period: Number(($event.target as HTMLInputElement).value) })"
        />
        <em v-if="periodBad" class="bad-hint">{{ t('Whole seconds, greater than 0.') }}</em>
      </label>

      <label class="field narrow">
        <span class="label">{{ t('Times before triggering') }}</span>
        <input
          class="input"
          type="number"
          min="1"
          step="1"
          :max="item.period"
          :class="{ bad: countBad }"
          :value="item.count"
          @input="patch({ count: Number(($event.target as HTMLInputElement).value) })"
        />
        <em v-if="countBad" class="bad-hint">{{ countHint }}</em>
      </label>

      <Btn
        v-if="removable"
        kind="ghost"
        size="sm"
        class="remove"
        :aria-label="t('Remove condition')"
        @click="emit('remove')"
      >
        <Icon name="close" />
      </Btn>
    </div>

    <div v-if="showUri" class="uri">
      <!-- The choice and, when a switch would erase something, the warning
           and its actions in the SAME row with the target option highlighted. -->
      <div class="uri-mode" :class="{ warning: pendingMode || conflicted }">
        <span class="label">{{ t('URI filter') }}</span>

        <div class="segmented" role="group" :aria-label="t('URI filter')">
          <button
            v-for="m in (['none', 'list', 'regex'] as const)"
            :key="m"
            type="button"
            class="seg"
            :class="{ on: uriMode === m, target: pendingMode === m }"
            :aria-pressed="uriMode === m"
            @click="setUriMode(m)"
          >
            {{ modeLabel(m) }}
          </button>
        </div>

        <template v-if="conflicted">
          <Icon name="alert" />
          <span class="warn-msg">
            {{ t('This rule carries both a URI list and a URI regex. The agent applies the list and ignores the regex — keep one to save.') }}
          </span>
          <Btn kind="ghost" size="sm" @click="applyMode('list')">{{ t('Keep the URI list') }}</Btn>
          <Btn kind="ghost" size="sm" @click="applyMode('regex')">{{ t('Keep the URI regex') }}</Btn>
        </template>
        <template v-else-if="pendingMode">
          <Icon name="alert" />
          <span class="warn-msg">
            {{ uriMode === 'list'
              ? t('Switching to {target} clears the URI list you entered.', { target: modeLabel(pendingMode) })
              : t('Switching to {target} clears the URI regex you entered.', { target: modeLabel(pendingMode) }) }}
          </span>
          <Btn kind="ghost" size="sm" @click="applyMode(pendingMode)">{{ t('Clear and switch') }}</Btn>
          <Btn kind="ghost" size="sm" @click="pendingMode = null">{{ t('Keep it') }}</Btn>
        </template>
        <em v-else class="hint">{{ modeHint }}</em>
      </div>

      <label v-if="uriMode === 'list'" class="field wide">
        <span class="label">{{ t('URI list — one per line') }}</span>
        <textarea
          class="input area"
          rows="2"
          :value="uriListText"
          placeholder="/api/v1/orders"
          @input="changeUriList(($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </label>
      <label v-else-if="uriMode === 'regex'" class="field wide">
        <span class="label">{{ t('URI regex') }}</span>
        <input
          class="input"
          type="text"
          :value="item.uriRegex ?? ''"
          placeholder="/api/.*"
          @input="patch({ uriRegex: ($event.target as HTMLInputElement).value || undefined })"
        />
      </label>
    </div>
  </div>
</template>

<style scoped>
.check-item {
  padding: 10px 12px;
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
  background: var(--sw-bg-2);
}
.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 190px;
  flex: 1;
}
.field.narrow {
  min-width: 120px;
  flex: 0 0 130px;
}
.label {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.hint {
  font-style: normal;
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-xs);
}
.input {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-sm);
  padding: 5px 8px;
  width: 100%;
}
.with-unit {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
  background: var(--sw-bg-1);
  overflow: hidden;
}
.with-unit .input {
  border: 0;
  border-radius: 0;
}
.with-unit.bad {
  border-color: var(--sw-err);
}
.unit {
  display: flex;
  align-items: center;
  padding: 0 8px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  border-left: 1px solid var(--sw-line);
  white-space: nowrap;
}
.bad-hint {
  font-style: normal;
  font-size: var(--sw-fs-xs);
  color: var(--sw-err);
}
.input:disabled {
  opacity: 0.5;
}
.area {
  resize: vertical;
  font-family: var(--sw-mono);
}
.uri {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.uri-mode {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  padding: 6px 10px;
  border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius);
  background: var(--sw-bg-1);
}
.uri-mode.warning {
  border-color: var(--sw-warn);
  background: var(--sw-warn-soft);
}
.segmented {
  display: inline-flex;
  border: 1px solid var(--sw-line-2);
  border-radius: var(--sw-radius);
  overflow: hidden;
}
.seg {
  background: var(--sw-bg-2);
  border: 0;
  border-right: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-xs);
  padding: 3px 12px;
  cursor: pointer;
}
.seg:last-child {
  border-right: 0;
}
.seg:hover:not(.on) {
  color: var(--sw-fg-0);
}
.seg.on {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  font-weight: var(--sw-fw-semibold);
}
/* Two equally bright fills read as two selections, so the current option steps
   back while a switch is pending. */
.uri-mode.warning .seg.on {
  background: transparent;
  color: var(--sw-fg-3);
  font-weight: var(--sw-fw-regular);
  text-decoration: line-through;
}
/* The option the pending switch would move TO. */
.seg.target {
  background: var(--sw-warn);
  color: var(--sw-bg-0);
  font-weight: var(--sw-fw-semibold);
}
.warn-msg {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-1);
}
.field.wide {
  min-width: 100%;
}
.remove {
  flex: 0 0 auto;
}
</style>
