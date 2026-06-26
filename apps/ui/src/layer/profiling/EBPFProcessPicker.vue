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
  Process picker for the eBPF profiling tab — the trigger button plus the
  popout that teleports to <body> on open so it overlays the layer-tab card
  instead of pushing the flamegraph down. Owns the anchoring math, the
  outside-click / ESC / resize listener lifecycle (attached only while open,
  torn down on unmount), and the per-row expand state. Pinned processes are
  a two-way `v-model` of ids — selection lives entirely on this component,
  the parent only reacts to the resulting id list.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { EBPFProcess } from '@/api/client';
import Icon from '@/components/icons/Icon.vue';

const props = defineProps<{
  processes: EBPFProcess[];
  modelValue: string[];
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', ids: string[]): void;
}>();

const processSearch = ref('');
const showProcessPicker = ref(false);
// Trigger button + computed popout coordinates. The picker is teleported
// to <body> on open so it can overflow the layer-tab card without
// pushing the flamegraph down. Position is anchored to the trigger
// button's viewport rect (BCR) at open-time + on resize; we don't
// re-anchor on scroll because the toolbar sits inside the page's own
// scroller and tracking that would cost a listener per repaint for
// negligible UX gain — the picker just closes if the operator scrolls
// it offscreen.
const pickerBtnEl = ref<HTMLElement | null>(null);
const pickerPos = reactive({ top: 0, left: 0, width: 0 });
const PICKER_WIDTH = 880;
const PICKER_MAX_HEIGHT = 480;
function anchorPicker(): void {
  const el = pickerBtnEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  // Flip up when there's not enough room below, so the body isn't clipped
  // at the viewport bottom.
  const gap = 8;
  const spaceBelow = window.innerHeight - r.bottom - gap;
  const wantDown = spaceBelow >= 240 || spaceBelow >= r.top - gap;
  pickerPos.top = wantDown
    ? r.bottom + gap
    : Math.max(8, r.top - gap - PICKER_MAX_HEIGHT);
  // Right-align under the trigger's right edge, clamped to viewport.
  const wantLeft = Math.min(
    r.right - PICKER_WIDTH,
    window.innerWidth - PICKER_WIDTH - 8,
  );
  pickerPos.left = Math.max(8, wantLeft);
  pickerPos.width = Math.min(PICKER_WIDTH, window.innerWidth - 16);
}
function openProcessPicker(): void {
  showProcessPicker.value = true;
  // Schedule the anchor compute after the button's reactive class/text
  // flip lands in the DOM, so the BCR is the post-render rect.
  void Promise.resolve().then(anchorPicker);
}
function closeProcessPicker(): void {
  showProcessPicker.value = false;
}
function onPickerOutsideMouseDown(ev: MouseEvent): void {
  if (!showProcessPicker.value) return;
  const target = ev.target as Node;
  // Trigger button toggles via its own @click; ignore.
  if (pickerBtnEl.value && pickerBtnEl.value.contains(target)) return;
  const popout = document.querySelector('.process-picker-pop');
  if (popout && popout.contains(target)) return;
  closeProcessPicker();
}
function onPickerKeyDown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && showProcessPicker.value) closeProcessPicker();
}
const expandedProcessIds = ref<Set<string>>(new Set());
function toggleProcessExpanded(id: string): void {
  const next = new Set(expandedProcessIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedProcessIds.value = next;
}

const filteredProcesses = computed<EBPFProcess[]>(() => {
  const q = processSearch.value.toLowerCase().trim();
  if (!q) return props.processes;
  return props.processes.filter((p) => {
    if (p.name?.toLowerCase().includes(q)) return true;
    if (p.instanceName?.toLowerCase().includes(q)) return true;
    const cmd = (p.attributes ?? []).find((a) => a.name === 'command_line');
    return Boolean(cmd?.value.toLowerCase().includes(q));
  });
});

function attrLine(p: EBPFProcess): string {
  return (p.attributes ?? []).map((a) => `${a.name}=${a.value}`).join(' · ');
}
function toggleProcessId(id: string): void {
  const i = props.modelValue.indexOf(id);
  const next = props.modelValue.slice();
  if (i === -1) next.push(id);
  else next.splice(i, 1);
  emit('update:modelValue', next);
}

watch(showProcessPicker, (open) => {
  if (open) {
    window.addEventListener('resize', anchorPicker);
    document.addEventListener('mousedown', onPickerOutsideMouseDown);
    document.addEventListener('keydown', onPickerKeyDown);
  } else {
    window.removeEventListener('resize', anchorPicker);
    document.removeEventListener('mousedown', onPickerOutsideMouseDown);
    document.removeEventListener('keydown', onPickerKeyDown);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', anchorPicker);
  document.removeEventListener('mousedown', onPickerOutsideMouseDown);
  document.removeEventListener('keydown', onPickerKeyDown);
});
</script>

<template>
  <div class="tb-block grow">
    <label class="lbl">Processes ({{ modelValue.length }} pinned)</label>
    <button
      ref="pickerBtnEl"
      class="btn-secondary"
      :class="{ open: showProcessPicker }"
      :aria-expanded="showProcessPicker"
      aria-haspopup="dialog"
      @click="showProcessPicker ? closeProcessPicker() : openProcessPicker()"
    >
      {{ showProcessPicker ? 'Close picker' : 'Pick processes' }}
    </button>
  </div>

  <Teleport to="body">
    <div
      v-if="showProcessPicker"
      class="process-picker-pop sw-card"
      role="dialog"
      aria-label="Process picker"
      :style="{
        top: pickerPos.top + 'px',
        left: pickerPos.left + 'px',
        width: pickerPos.width + 'px',
      }"
    >
      <div class="pp-head">
        <input
          v-model="processSearch"
          placeholder="Search by name / instance / command line…"
          class="ti-input wide"
          autofocus
        />
        <span class="pp-count">{{ modelValue.length }} pinned</span>
        <!-- Textual ×, not an icon glyph (no SVG asset exists for
             close and a one-off SVG would violate CLAUDE.md's
             single-icon-component rule). Same shape as the prior
             dialog close buttons across the codebase. -->
        <button class="pp-close" aria-label="Close picker" title="Close (Esc)" @click="closeProcessPicker">×</button>
      </div>
      <div class="proc-table">
        <div class="ph">
          <div class="cc cc-sel"></div>
          <div class="cc cc-name">Process</div>
          <div class="cc cc-inst">Instance</div>
          <div class="cc cc-attrs">Attributes</div>
          <div class="cc cc-exp"></div>
        </div>
        <div v-if="!filteredProcesses.length" class="empty">No matches.</div>
        <template v-for="p in filteredProcesses" :key="p.id">
          <!-- Row click toggles the detail panel; pin/unpin lives only on
               the checkbox. The checkbox cell uses `@click.stop` so its
               clicks don't bubble to the row's expand toggle. The chevron
               button has no own handler — its click bubbles to the row's
               expand toggle, giving keyboard users a focusable affordance. -->
          <div
            class="pr"
            :class="{ on: modelValue.includes(p.id) }"
            @click="toggleProcessExpanded(p.id)"
          >
            <div class="cc cc-sel" @click.stop>
              <input
                type="checkbox"
                :checked="modelValue.includes(p.id)"
                :aria-label="`Pin process ${p.name}`"
                @change="toggleProcessId(p.id)"
              />
            </div>
            <div class="cc cc-name" :title="p.name">{{ p.name }}</div>
            <div class="cc cc-inst" :title="p.instanceName ?? ''">{{ p.instanceName }}</div>
            <div class="cc cc-attrs" :title="attrLine(p)">{{ attrLine(p) }}</div>
            <button
              type="button"
              class="cc cc-exp pr-caret"
              :class="{ open: expandedProcessIds.has(p.id) }"
              :aria-expanded="expandedProcessIds.has(p.id)"
              :aria-label="expandedProcessIds.has(p.id) ? 'Collapse details' : 'Expand details'"
            >
              <Icon name="caret" :size="10" />
            </button>
          </div>
          <div v-if="expandedProcessIds.has(p.id)" class="pr-expand">
            <dl class="pe-rows">
              <div class="pe-row"><dt>Process</dt><dd class="mono">{{ p.name }}</dd></div>
              <div v-if="p.serviceName" class="pe-row">
                <dt>Service</dt><dd class="mono">{{ p.serviceName }}</dd>
              </div>
              <div v-if="p.instanceName" class="pe-row">
                <dt>Instance</dt><dd class="mono">{{ p.instanceName }}</dd>
              </div>
              <div v-if="p.agentId" class="pe-row">
                <dt>Agent</dt><dd class="mono">{{ p.agentId }}</dd>
              </div>
              <div v-if="p.detectType" class="pe-row">
                <dt>Detect type</dt><dd class="mono">{{ p.detectType }}</dd>
              </div>
              <div v-if="(p.labels ?? []).length" class="pe-row">
                <dt>Labels</dt>
                <dd>
                  <span v-for="l in p.labels" :key="l" class="pe-chip">{{ l }}</span>
                </dd>
              </div>
              <!-- The "ATTRIBUTES" label is a divider hint, NOT a header —
                   the attribute rows still live at the same dl level. -->
              <div v-if="(p.attributes ?? []).length" class="pe-sep">
                <span class="pe-sep-label">Attributes</span>
              </div>
              <div v-for="a in p.attributes ?? []" :key="`attr-${a.name}`" class="pe-row">
                <dt>{{ a.name }}</dt>
                <dd class="mono">{{ a.value }}</dd>
              </div>
            </dl>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tb-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tb-block.grow {
  flex: 1 1 auto;
}
.lbl {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.btn-secondary {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 3px;
  padding: 5px 12px;
  font-size: 11px;
  cursor: pointer;
}

.ti-input,
.ti-input.wide {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  border: 1px solid var(--sw-line);
  border-radius: 3px;
  padding: 4px 6px;
  font-size: 11.5px;
  font-family: var(--sw-mono);
  outline: none;
}
.ti-input.wide {
  width: 100%;
}
.proc-table {
  border: 1px solid var(--sw-line);
  border-radius: 3px;
}
.ph,
.pr {
  display: grid;
  grid-template-columns: 30px minmax(120px, 1.2fr) minmax(120px, 1fr) minmax(160px, 2fr) 26px;
  align-items: center;
  font-size: 11px;
}
.ph {
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
}
.ph .cc {
  padding: 6px 8px;
  font-weight: 600;
  color: var(--sw-fg-1);
}
.pr {
  border-bottom: 1px dotted var(--sw-line);
  cursor: pointer;
}
.pr:hover {
  background: var(--sw-bg-2);
}
.pr.on {
  background: var(--sw-bg-3, var(--sw-bg-2));
}
.pr .cc {
  padding: 5px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pr-caret {
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  line-height: 0;
}
.pr-caret:hover { color: var(--sw-accent); }
.pr-caret :deep(svg) {
  transition: transform 0.15s ease;
  transform-origin: 50% 50%;
}
.pr-caret.open :deep(svg) {
  transform: rotate(180deg);
  color: var(--sw-accent);
}

/* Expanded detail panel. overflow-wrap (vs. the row ellipsis) so long JVM
 * command lines wrap inside the box instead of pushing past it. */
.pr-expand {
  background: var(--sw-bg-2);
  border-bottom: 1px solid var(--sw-line);
  padding: 8px 12px 10px 38px;  /* 38px = 30px sel-col + 8px row padding */
  font-size: 11px;
  color: var(--sw-fg-1);
}
.pe-rows {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pe-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 12px;
  align-items: baseline;
}
.pe-row dt {
  margin: 0;
  color: var(--sw-fg-3);
  font-weight: 600;
  letter-spacing: 0.02em;
}
.pe-row dd {
  margin: 0;
  color: var(--sw-fg-0);
  overflow-wrap: anywhere;
  word-break: break-all;
}
.pe-row .mono { font-family: var(--sw-mono, monospace); }
.pe-chip {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--sw-bg-3, var(--sw-bg-1));
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  margin: 0 4px 4px 0;
  font-size: 10.5px;
}
/* Purely a visual divider between the identity rows and the attribute
 * rows; the attribute rows stay at the same dl level so the grid alignment
 * carries through. */
.pe-sep {
  margin: 6px 0 4px;
  border-top: 1px dashed var(--sw-line);
  position: relative;
}
.pe-sep-label {
  position: relative;
  top: -7px;
  display: inline-block;
  padding: 0 6px;
  margin-left: 4px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-3);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
/* Popout shell — teleported to <body>; Vue scoped CSS data-v-X attrs
 * still match because teleport preserves the component's attribute
 * assignment. Fixed-positioned, max-height capped so very large process
 * lists scroll inside the popout instead of overflowing the viewport. */
.process-picker-pop {
  position: fixed;
  z-index: 9000;
  max-height: 480px;
  display: flex;
  flex-direction: column;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.pp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.pp-head .ti-input.wide { flex: 1 1 auto; margin-bottom: 0; }
.pp-count {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.pp-close {
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  font-size: 18px;
  line-height: 1;
  padding: 0 6px;
  border-radius: 3px;
  cursor: pointer;
}
.pp-close:hover {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
}
/* The proc-table inside the popout grows / scrolls instead of pushing
 * the popout taller — the head row stays sticky at the top so column
 * labels remain visible while the body scrolls. */
.process-picker-pop .proc-table {
  flex: 1 1 auto;
  overflow: auto;
  border: none;
  border-radius: 0;
}
.process-picker-pop .ph {
  position: sticky;
  top: 0;
  z-index: 1;
}
.empty {
  padding: 10px;
  text-align: center;
  font-size: 11px;
  color: var(--sw-fg-3);
}
</style>
