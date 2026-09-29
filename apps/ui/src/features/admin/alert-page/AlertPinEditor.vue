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
  A page's pins: the tiles it shows, in order, and the picker that adds one.
  A pin is a layer and, optionally, OAP service groups in it, written in the
  grant grammar (`GENERAL`, `GENERAL[payments, -]`). The group suggestions are
  the groups the layer's services carry now; a group typed by hand is kept
  with a warning, because a pin is configuration and a group that is empty
  today can fill tomorrow.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery } from '@tanstack/vue-query';
import { UNGROUPED_PIN, formatAlarmPin, parseAlarmPin, type AlarmPin } from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import { duplicatePinIndexes, pinIdentity, pinLabel, prettyLayer } from './alertPages';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  modelValue: string[];
  /** Canonical layer keys the menu knows, sorted. */
  knownLayers: string[];
  max: number;
  readOnly: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [pins: string[]] }>();

const ungrouped = computed(() => t('no group'));

const pinned = computed(() => {
  const dup = duplicatePinIndexes(props.modelValue);
  return props.modelValue.map((text, i) => {
    const pin = parseAlarmPin(text);
    const problem = !pin ? t('Not a valid pin. Remove it and add it again.') : dup.has(i) ? t('Already pinned.') : null;
    return { text, pin, problem, label: pin ? pinLabel(pin, ungrouped.value) : text };
  });
});

function removePin(i: number): void {
  if (props.readOnly) return;
  emit('update:modelValue', props.modelValue.filter((_, j) => j !== i));
}

function movePin(i: number, dir: -1 | 1): void {
  if (props.readOnly) return;
  const j = i + dir;
  if (j < 0 || j >= props.modelValue.length) return;
  const next = [...props.modelValue];
  [next[i], next[j]] = [next[j]!, next[i]!];
  emit('update:modelValue', next);
}

const pickLayer = ref<string | null>(null);
/** `''` is the services with no group. Kept in the order they were picked. */
const pickGroups = ref<string[]>([]);
const typed = ref('');
const typedError = ref<string | null>(null);

function chooseLayer(key: string): void {
  if (props.readOnly || pickLayer.value === key) return;
  pickLayer.value = key;
  pickGroups.value = [];
  typed.value = '';
  typedError.value = null;
}

const groupsQ = useQuery({
  queryKey: computed(() => ['alarms/services', pickLayer.value ?? '']),
  queryFn: () => bff.alarms.services(pickLayer.value!),
  enabled: computed(() => pickLayer.value !== null),
  staleTime: 60_000,
});

/** The distinct groups of the layer's services now, `''` last; `null` until
 *  the roster is read (or when it could not be). */
const rosterGroups = computed<string[] | null>(() => {
  const data = groupsQ.data.value;
  if (!data) return null;
  const seen = new Set<string>();
  for (const s of data.services) seen.add(typeof s.group === 'string' ? s.group.trim() : '');
  const named = [...seen].filter((g) => g !== '').sort((a, b) => a.localeCompare(b));
  return seen.has('') ? [...named, ''] : named;
});

const groupChips = computed<string[]>(() => {
  const roster = rosterGroups.value ?? [];
  return [...roster, ...pickGroups.value.filter((g) => !roster.includes(g))];
});

const unknownPicked = computed<string[]>(() => {
  const roster = rosterGroups.value;
  if (!roster) return [];
  return pickGroups.value.filter((g) => !roster.includes(g));
});

function groupText(g: string): string {
  return g === '' ? ungrouped.value : g;
}

/** A group OAP holds that a pin cannot name: the pin grammar reserves `,`,
 *  `[` and `]`, and `-` already means the services with no group. */
function unwritable(g: string): boolean {
  return g !== '' && (g === UNGROUPED_PIN || /[,[\]]/.test(g));
}

function toggleGroup(g: string): void {
  if (props.readOnly || unwritable(g)) return;
  pickGroups.value = pickGroups.value.includes(g)
    ? pickGroups.value.filter((x) => x !== g)
    : [...pickGroups.value, g];
}

function addTyped(): void {
  if (props.readOnly) return;
  const raw = typed.value.trim();
  if (raw === '') return;
  if (/[,[\]]/.test(raw)) {
    typedError.value = t('A group name cannot contain “,”, “[” or “]”.');
    return;
  }
  const g = raw === UNGROUPED_PIN ? '' : raw;
  if (!pickGroups.value.includes(g)) pickGroups.value = [...pickGroups.value, g];
  typed.value = '';
  typedError.value = null;
}

const candidate = computed<AlarmPin | null>(() => {
  if (!pickLayer.value) return null;
  return pickGroups.value.length > 0
    ? { layer: pickLayer.value, groups: [...pickGroups.value] }
    : { layer: pickLayer.value };
});
const candidateText = computed<string | null>(() => (candidate.value ? formatAlarmPin(candidate.value) : null));
const duplicate = computed<boolean>(() => {
  const text = candidateText.value;
  if (!text) return false;
  const id = pinIdentity(text);
  return props.modelValue.some((p) => pinIdentity(p) === id);
});
const full = computed<boolean>(() => props.modelValue.length >= props.max);
/** The written pin reads back as exactly the layer and groups picked. */
const candidateReadsBack = computed<boolean>(() => {
  const pin = candidateText.value ? parseAlarmPin(candidateText.value) : null;
  if (!pin || pin.layer !== pickLayer.value?.toUpperCase()) return false;
  const groups = pin.groups ?? [];
  return groups.length === pickGroups.value.length && groups.every((g, i) => g === pickGroups.value[i]);
});
const canAdd = computed<boolean>(
  () => !props.readOnly && candidateReadsBack.value && !duplicate.value && !full.value,
);

function addPin(): void {
  const text = candidateText.value;
  if (!canAdd.value || !text) return;
  emit('update:modelValue', [...props.modelValue, text]);
  pickGroups.value = [];
}
</script>

<template>
  <div class="apin">
    <div v-if="pinned.length === 0" class="apin__empty">{{ t('No pins yet. Add one below.') }}</div>
    <ol v-else class="apin__pinned">
      <li
        v-for="(p, i) in pinned"
        :key="`${i}:${p.text}`"
        class="apin__pin"
        :class="{ 'apin__pin--bad': p.problem !== null }"
        :title="p.problem ?? ''"
      >
        <button
          type="button"
          class="apin__arrow"
          :disabled="readOnly || i === 0"
          :title="t('Move left')"
          @click="movePin(i, -1)"
        >‹</button>
        <span class="apin__pos">{{ i + 1 }}</span>
        <span class="apin__label">{{ p.label }}</span>
        <code class="apin__code">{{ p.text }}</code>
        <button
          type="button"
          class="apin__arrow"
          :disabled="readOnly || i === pinned.length - 1"
          :title="t('Move right')"
          @click="movePin(i, 1)"
        >›</button>
        <button
          type="button"
          class="apin__del"
          :disabled="readOnly"
          :title="t('Unpin')"
          @click="removePin(i)"
        >×</button>
      </li>
    </ol>

    <div class="apin__add">
      <div class="apin__step">{{ t('Add a pin · layer') }}</div>
      <div class="apin__layers">
        <button
          v-for="key in knownLayers"
          :key="key"
          type="button"
          class="apin__layer"
          :class="{ active: pickLayer === key }"
          :disabled="readOnly"
          @click="chooseLayer(key)"
        >
          <span>{{ prettyLayer(key) }}</span>
          <code>{{ key }}</code>
        </button>
      </div>

      <template v-if="pickLayer">
        <div class="apin__step">{{ t('Service groups (optional — none picked pins the whole layer)') }}</div>
        <div v-if="groupsQ.isLoading.value" class="apin__note">{{ t('Reading the service groups of {layer}…', { layer: pickLayer }) }}</div>
        <div v-else-if="groupsQ.isError.value" class="apin__note apin__note--warn">
          {{ t('Could not read the service groups of this layer. Type a group below instead.') }}
        </div>
        <div v-else-if="rosterGroups && rosterGroups.length === 0" class="apin__note">
          {{ t('This layer has no services now.') }}
        </div>
        <div v-if="groupChips.length > 0" class="apin__groups">
          <button
            v-for="g in groupChips"
            :key="`group:${g}`"
            type="button"
            class="apin__group"
            :class="{ active: pickGroups.includes(g), 'apin__group--none': g === '' }"
            :disabled="readOnly || unwritable(g)"
            :title="unwritable(g) ? t('This group cannot be written in a pin: its name contains “,”, “[” or “]”, or is “-”.') : ''"
            @click="toggleGroup(g)"
          >{{ groupText(g) }}</button>
        </div>
        <div class="apin__typed">
          <input
            v-model="typed"
            type="text"
            class="apin__in"
            :disabled="readOnly"
            :placeholder="t('Another group — press Enter')"
            :aria-label="t('Another group')"
            @keydown.enter.prevent="addTyped"
          />
          <button type="button" class="apin__btn" :disabled="readOnly || typed.trim() === ''" @click="addTyped">{{ t('Add group') }}</button>
          <span v-if="typedError" class="apin__err">{{ typedError }}</span>
        </div>
        <div v-if="unknownPicked.length > 0" class="apin__note apin__note--warn">
          {{ t('No service in {layer} is in {groups} now. The pin is kept; its tile stays empty until a service joins.', { layer: pickLayer, groups: unknownPicked.map(groupText).join(', ') }) }}
        </div>
        <div class="apin__commit">
          <code v-if="candidateText" class="apin__candidate">{{ candidateText }}</code>
          <button type="button" class="apin__btn apin__btn--primary" :disabled="!canAdd" @click="addPin">{{ t('Add pin') }}</button>
          <span v-if="duplicate" class="apin__note">{{ t('Already pinned.') }}</span>
          <span v-else-if="full" class="apin__note">{{ t('The page already has {n} pins.', { n: max }) }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.apin__empty {
  padding: 16px 14px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: var(--sw-fs-base);
}
.apin__pinned {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.apin__pin {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
}
.apin__pin--bad { border-color: var(--sw-warn); }
.apin__pos {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-accent);
  font-weight: var(--sw-fw-semibold);
}
.apin__label {
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-medium);
  color: var(--sw-fg-0);
}
.apin__code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
  background: var(--sw-bg-1);
  padding: 1px 5px;
  border-radius: 3px;
}
.apin__arrow,
.apin__del {
  background: transparent;
  border: 0;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: var(--sw-fs-lg);
  line-height: 1;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  cursor: pointer;
}
.apin__arrow:not(:disabled):hover { background: var(--sw-bg-3); color: var(--sw-fg-0); }
.apin__del:not(:disabled):hover { background: var(--sw-err-soft); color: var(--sw-err); }
.apin__arrow:disabled,
.apin__del:disabled { opacity: 0.3; cursor: not-allowed; }

.apin__add {
  border-top: 1px solid var(--sw-line);
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.apin__step {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.apin__layers,
.apin__groups {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.apin__layer,
.apin__group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.apin__layer code {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-3);
}
.apin__layer:not(:disabled):hover,
.apin__group:not(:disabled):hover {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
  border-color: var(--sw-line-2);
}
.apin__layer.active,
.apin__group.active {
  border-color: var(--sw-accent);
  background: var(--sw-accent-soft);
  color: var(--sw-fg-0);
}
.apin__group--none { font-style: italic; }
.apin__layer:disabled,
.apin__group:disabled { opacity: 0.4; cursor: not-allowed; }
.apin__note {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-3);
}
.apin__note--warn { color: var(--sw-warn); }
.apin__typed,
.apin__commit {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.apin__in {
  width: 220px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-base);
  padding: 4px 8px;
  border-radius: 4px;
}
.apin__in:disabled { opacity: 0.5; cursor: not-allowed; }
.apin__err { font-size: var(--sw-fs-sm); color: var(--sw-err); }
.apin__candidate {
  font-family: var(--sw-mono);
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-0);
  background: var(--sw-bg-2);
  padding: 2px 6px;
  border-radius: 3px;
}
.apin__btn {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: var(--sw-fs-sm);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.apin__btn:not(:disabled):hover { background: var(--sw-bg-2); }
.apin__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.apin__btn--primary {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: var(--sw-fw-semibold);
}
.apin__btn--primary:not(:disabled):hover { background: var(--sw-accent-2); }
</style>
