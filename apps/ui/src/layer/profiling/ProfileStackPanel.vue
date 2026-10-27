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
  A trace-profile analyze result with its view controls: Tree | Flame, the
  frame patterns to hide (typed, or from per-agent presets), a find box, the
  top-slow highlight and Pop out. The page renders one in place and another
  inside the pop-out; both bind the same models, so a change in either shows
  in the other.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProfileAnalyzationTree } from '@/api/client';
import ChipInput from '@/components/primitives/ChipInput.vue';
import FloatingPanel from '@/components/primitives/FloatingPanel.vue';
import Icon from '@/components/icons/Icon.vue';
import ProfileStackTable from './ProfileStackTable.vue';
import ProfileFlameGraph from './ProfileFlameGraph.vue';
import { FRAME_PRESETS, foldStack, isFrameHidden, normalizeHidePattern, stackStats } from './profileStackFold';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  trees: ProfileAnalyzationTree[];
  /** Rendered inside the pop-out: no Pop out button of its own. */
  inPopout?: boolean;
}>();
const emit = defineEmits<{ popout: [] }>();

const displayMode = defineModel<'tree' | 'flame'>('displayMode', { required: true });
const hidePatterns = defineModel<string[]>('hidePatterns', { required: true });
const highlightTop = defineModel<boolean>('highlightTop', { required: true });
const search = defineModel<string>('search', { required: true });

const table = ref<InstanceType<typeof ProfileStackTable> | null>(null);
function nextMatch(): void {
  void table.value?.jumpToNext('match');
}
function nextSlow(): void {
  void table.value?.jumpToNext('top');
}
const hideButton = ref<HTMLElement | null>(null);
const hideOpen = ref(false);

// The flame graph folds every group; only the Tree lets one be opened. Reset
// here as well as in the table, which is not mounted while Flame is showing.
const unfolded = ref<Set<string>>(new Set());
watch([() => props.trees, hidePatterns], () => {
  unfolded.value = new Set();
});
const stats = computed(() =>
  stackStats(
    foldStack(props.trees, {
      hidePatterns: hidePatterns.value,
      unfolded: displayMode.value === 'tree' ? unfolded.value : undefined,
      search: search.value,
    }),
  ),
);

interface Preset {
  label: string;
  patterns: readonly string[];
}
const presetGroups = computed<{ agent: string; presets: Preset[] }[]>(() => [
  {
    agent: 'Java',
    presets: [
      { label: 'JDK', patterns: FRAME_PRESETS.jdk },
      { label: 'Tomcat', patterns: FRAME_PRESETS.tomcat },
      { label: 'Jetty', patterns: FRAME_PRESETS.jetty },
      { label: 'Undertow', patterns: FRAME_PRESETS.undertow },
      { label: 'Spring', patterns: FRAME_PRESETS.spring },
      { label: 'Netty', patterns: FRAME_PRESETS.netty },
      { label: 'gRPC', patterns: FRAME_PRESETS.grpcJava },
      { label: t('SkyWalking agent'), patterns: FRAME_PRESETS.skywalkingJava },
    ],
  },
  { agent: 'Python', presets: [{ label: t('Libraries'), patterns: FRAME_PRESETS.pythonLibraries }] },
  {
    agent: 'Go',
    presets: [
      { label: t('Standard library'), patterns: FRAME_PRESETS.goStd },
      { label: t('SkyWalking agent'), patterns: FRAME_PRESETS.skywalkingGo },
    ],
  },
]);
const presetOn = (p: Preset) => p.patterns.every((x) => hidePatterns.value.includes(x));
// Offered only when it would hide something in this stack — or is on, so it
// can be turned off again.
const shownPresetGroups = computed(() => {
  const signatures = props.trees.flatMap((tree) => tree.elements.map((e) => e.codeSignature));
  return presetGroups.value
    .map((g) => ({
      ...g,
      presets: g.presets.filter((p) => presetOn(p) || signatures.some((s) => isFrameHidden(s, p.patterns))),
    }))
    .filter((g) => g.presets.length);
});
function togglePreset(p: Preset): void {
  hidePatterns.value = presetOn(p)
    ? hidePatterns.value.filter((x) => !p.patterns.includes(x))
    : [...hidePatterns.value, ...p.patterns.filter((x) => !hidePatterns.value.includes(x))];
}
</script>

<template>
  <div class="psp">
    <div class="psp-bar">
      <div class="seg" role="group" :aria-label="t('Display')">
        <button type="button" :class="{ on: displayMode === 'tree' }" @click="displayMode = 'tree'">{{ t('Tree') }}</button>
        <button type="button" :class="{ on: displayMode === 'flame' }" @click="displayMode = 'flame'">{{ t('Flame') }}</button>
      </div>
      <div class="psp-group">
        <button
          ref="hideButton"
          type="button"
          class="psp-btn"
          :class="{ on: hidePatterns.length > 0 }"
          :aria-expanded="hideOpen"
          @click="hideOpen = !hideOpen"
        >
          {{ t('Hide frames') }}
          <span v-if="hidePatterns.length" class="psp-count">{{ hidePatterns.length }}</span>
          <Icon name="caret" :size="9" />
        </button>
        <span v-if="stats.hidden" class="psp-note">{{ t('{n} frames hidden', { n: stats.hidden }) }}</span>
      </div>
      <div class="psp-group">
        <input
          v-model="search"
          class="psp-search"
          type="search"
          :placeholder="t('Find frame…')"
          :title="displayMode === 'tree' ? t('Press Enter to jump to the next match') : ''"
          @keydown.enter="nextMatch"
        />
        <span v-if="search.trim()" class="psp-note">
          {{ stats.matches === 1 ? t('{n} match', { n: stats.matches }) : t('{n} matches', { n: stats.matches }) }}
        </span>
      </div>
      <div v-if="displayMode === 'tree'" class="psp-joined" role="group">
        <button
          type="button"
          class="psp-btn"
          :class="{ on: highlightTop }"
          :aria-pressed="highlightTop"
          :title="t('Highlight top 10 slow methods')"
          @click="highlightTop = !highlightTop"
        >{{ t('top slow') }}</button>
        <button
          v-if="highlightTop"
          type="button"
          class="psp-btn psp-next"
          :title="t('Jump to the next slow frame')"
          :aria-label="t('Jump to the next slow frame')"
          @click="nextSlow"
        >↓</button>
      </div>
      <button
        v-if="!inPopout"
        type="button"
        class="psp-btn psp-pop"
        :disabled="!trees.length"
        @click="emit('popout')"
      ><Icon name="expand" :size="11" /> {{ t('Pop out') }}</button>
    </div>
    <!-- Clicks stop here: removing a chip detaches its × before the click
         reaches the panel's outside-click check, which would then close it. -->
    <FloatingPanel :open="hideOpen" :anchor="hideButton" :width="480" @close="hideOpen = false">
      <div class="psp-hide-panel" @click.stop>
        <div class="psp-hide-head">{{ t('Hide frames') }}</div>
        <p class="psp-hide-help">
          {{ t('A frame whose name starts with one of these patterns folds into one row, which keeps its time. * matches any text.') }}
        </p>
        <ChipInput
          v-model="hidePatterns"
          :placeholder="t('e.g. org.apache.tomcat. or */site-packages/')"
          :normalize="normalizeHidePattern"
          :invalid-message="(v: string) => t('Not a frame pattern: {value}', { value: v })"
          :aria-label="t('Hide frames')"
        />
        <div v-for="g in shownPresetGroups" :key="g.agent" class="psp-presets">
          <span class="psp-agent">{{ g.agent }}</span>
          <div class="psp-preset-list">
            <button
              v-for="p in g.presets"
              :key="p.label"
              type="button"
              class="psp-preset"
              :class="{ on: presetOn(p) }"
              :aria-pressed="presetOn(p)"
              :title="p.patterns.join('  ')"
              @click="togglePreset(p)"
            >{{ presetOn(p) ? '✓' : '+' }} {{ p.label }}</button>
          </div>
        </div>
        <p v-if="trees.length && !shownPresetGroups.length" class="psp-hide-help">{{ t('No preset matches a frame in this stack.') }}</p>
        <div class="psp-hide-actions">
          <button
            type="button"
            class="psp-btn"
            :disabled="!hidePatterns.length"
            @click="hidePatterns = []"
          >{{ t('Clear') }}</button>
        </div>
      </div>
    </FloatingPanel>
    <div class="psp-view">
      <ProfileStackTable
        v-if="displayMode === 'tree'"
        ref="table"
        v-model:unfolded="unfolded"
        :trees="trees"
        v-model:highlight-top="highlightTop"
        :hide-patterns="hidePatterns"
        :search="search"
      />
      <ProfileFlameGraph
        v-else
        :trees="trees"
        metric-key="count"
        duration-unit="ms"
        :hide-patterns="hidePatterns"
        :search="search"
      />
    </div>
  </div>
</template>

<style scoped>
/* Buttons do not inherit the page font on their own; the bar sets the
 * theme's UI font once and every control takes it. */
.psp {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  font-family: var(--sw-sans);
}
.psp button {
  font-family: inherit;
}
.psp-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 6px 10px;
  background: var(--sw-bg-1);
  border-bottom: 1px solid var(--sw-line);
}
.psp-view {
  flex: 1 1 0;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  overflow: hidden;
}
.seg button {
  background: transparent;
  border: none;
  color: var(--sw-fg-2);
  padding: 4px 11px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
}
.seg button + button {
  border-left: 1px solid var(--sw-line-2);
}
.seg button.on {
  background: var(--sw-accent);
  color: #fff;
}
.psp-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.psp-note {
  font-size: 11px;
  color: var(--sw-fg-3);
  white-space: nowrap;
}
.psp-search {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11.5px;
  font-family: var(--sw-mono);
  width: 160px;
  outline: none;
}
.psp-search:focus {
  border-color: var(--sw-accent-line);
}
.psp-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  font-size: 11.5px;
  font-weight: 500;
  border-radius: 4px;
  border: 1px solid var(--sw-line-2);
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  cursor: pointer;
  white-space: nowrap;
}
.psp-btn:hover:not(:disabled) {
  border-color: var(--sw-accent-line);
  color: var(--sw-fg-0);
}
.psp-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.psp-btn.on {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line);
  color: var(--sw-accent);
}
.psp-joined {
  display: inline-flex;
}
.psp-joined .psp-btn:not(:last-child) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.psp-joined .psp-btn + .psp-btn {
  border-left: none;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.psp-next {
  padding: 0 8px;
}
.psp-count {
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  background: var(--sw-accent-soft);
  border-radius: 8px;
  padding: 0 6px;
}
.psp-pop {
  margin-left: auto;
}
/* The floating panel caps its height and hides overflow; min-height: 0 is
 * what lets this flex child shrink and scroll instead of being cut off. */
.psp-hide-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  width: 100%;
  box-sizing: border-box;
  min-height: 0;
  overflow: auto;
  font-family: var(--sw-sans);
}
.psp-hide-panel button {
  font-family: inherit;
}
.psp-hide-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.psp-hide-help {
  margin: 0;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  line-height: 1.45;
}
.psp-presets {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.psp-preset-list {
  flex: 1 1 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.psp-agent {
  flex: 0 0 56px;
  line-height: 22px;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.psp-preset {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--sw-line-2);
  background: transparent;
  color: var(--sw-fg-2);
  cursor: pointer;
  white-space: nowrap;
}
.psp-preset:hover {
  border-color: var(--sw-accent-line);
  color: var(--sw-fg-0);
}
.psp-preset.on {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line);
  color: var(--sw-accent);
}
.psp-hide-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
