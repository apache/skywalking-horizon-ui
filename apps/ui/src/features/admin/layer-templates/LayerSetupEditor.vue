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
  Layer setup card — the always-visible header of the layer editor.
  Left = a live preview of the layer's sidebar menu (alias header + the
  enabled components, in checkbox order); clicking an item emits `jump`
  so the parent focuses that component's config + preview below. Right =
  the layer alias, the per-group menu-split flag, the Components toggles
  (which sub-views the layer exposes), and the menu-label / slot-alias
  editors (shown only for enabled components, rename the per-component
  nouns into the layer's own vocabulary).

  Owns its slice of the shared `template` IN PLACE — `components`, `slots`,
  `alias`, `splitByServiceGroup` are mutated on the same object the parent's
  draft holds (never cloned). `activeScope` + `instanceTopologyEnabled` are
  read-only inputs the parent owns; the activeScope write happens in the
  parent via the emitted `jump` event.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { isBuiltInOrder, pruneMenuOrder } from './menuOrder';
import type { AdminLayerTemplate } from '@/api/client';
import type { AdminScope, ComponentKey, SlotKey } from './layer-dashboards.scopes';
import { resolveLayerMenuRows } from '@skywalking-horizon-ui/api-client';
import { componentsToCaps } from '@/shell/layerFromTemplate';

const { t } = useI18n({ useScope: 'global' });

// `template` is a model (not a plain prop) so the alias / group-split inputs
// can v-model directly onto it and the component can mutate the shared draft's
// `components` / `slots` IN PLACE. The parent passes `draft.template`; we never
// reassign the whole object (only nested keys), so no `update:template` fires.
const template = defineModel<AdminLayerTemplate>('template', { required: true });
const props = defineProps<{
  activeScope: AdminScope;
  /** Page currently open in the editor, so the preview row for it can
   *  show as active — a row that can never highlight looks inert even
   *  though clicking it works. */
  activePage?: string | null;
  instanceTopologyEnabled: boolean;
}>();
const activePage = computed(() => props.activePage ?? null);
const emit = defineEmits<{
  jump: [target: { scope: AdminScope; page: string | null }];
  'confirm-disable': [key: ComponentKey];
}>();

/**
 * Component toggles surfaced in the admin editor. Each entry binds to
 * a key on the template's `components` block; flipping the toggle
 * shows / hides the matching sidebar entry + per-layer route.
 */
const COMPONENT_TOGGLES = computed((): Array<{ key: ComponentKey; label: string; hint: string }> => [
  { key: 'service', label: t('Service'), hint: t("The layer's primary landing — widget grid driven by dashboards.service.") },
  { key: 'instances', label: t('Instances'), hint: t('Per-instance dashboard (dashboards.instance widget set).') },
  { key: 'endpoints', label: t('Endpoints'), hint: t('Per-endpoint dashboard (dashboards.endpoint widget set).') },
  // Order mirrors the real sidebar: Topology sits before API dependency.
  { key: 'topology', label: t('Topology'), hint: t('Service topology graph for this layer.') },
  { key: 'deployment', label: t('Deployment'), hint: t('Deployment topology of all of a service’s instances — the instance-to-instance call graph within one service. Needs a deployment config block to appear.') },
  { key: 'endpointDependency', label: t('API dependency'), hint: t('Endpoint-to-endpoint dependency view.') },
  { key: 'traces', label: t('Traces'), hint: t('Trace explorer scoped to this layer.') },
  { key: 'logs', label: t('Logs'), hint: t('Log explorer scoped to this layer.') },
  { key: 'browserErrors', label: t('Browser Logs'), hint: t('BROWSER-layer JS error logs with source-map de-obfuscation of the minified stack.') },
  { key: 'podLogs', label: t('Pod Logs'), hint: t('On-demand Kubernetes pod-log live tail. Only K8s-deployed layers (k8s_service, mesh) carry pods that resolve.') },
  { key: 'traceProfiling', label: t('Trace Profiling'), hint: t('Trace-driven thread profiling — the original SkyWalking profile.') },
  { key: 'ebpfProfiling', label: t('eBPF Profiling'), hint: t('Kernel-level CPU / off-CPU profiling via eBPF agents.') },
  { key: 'asyncProfiling', label: t('Async Profiling'), hint: t('JVM async-profiler integration (Java-only).') },
  { key: 'continuousProfiling', label: t('Continuous Profiling'), hint: t('Auto-trigger policies — rules that make an eBPF agent start an ON_CPU / OFF_CPU / NETWORK task by itself. Needs the same Rover agent as eBPF Profiling; there is no continuous trace / async / pprof profiling.') },
]);

function ensureComponents(): AdminLayerTemplate['components'] {
  if (!template.value.components) {
    (template.value as AdminLayerTemplate).components = {};
  }
  return template.value.components;
}
/**
 * Turning an entity component OFF destroys the config only it can reach:
 * its widget grid, its extension pages and their widgets, and its rows in
 * a custom menu order. None of that is recoverable from the editor once
 * the draft is saved, and none of it is visible while the component is
 * off — so the parent confirms first and performs the removal.
 *
 * Turning one ON, and every non-entity component, is the plain toggle it
 * has always been.
 */
function toggleComponent(key: ComponentKey): void {
  const c = ensureComponents();
  if (c[key] && DESTRUCTIVE_OFF.has(key)) {
    emit('confirm-disable', key);
    return;
  }
  c[key] = !c[key];
}

/**
 * Drop order entries for rows the layer no longer has.
 *
 * A stored order naming a row that does not resolve is refused at
 * publish, and switching a component off is how one gets there: preview
 * stops drawing the row, so the draft looks correct while the push
 * fails. Filtering against the rows that ACTUALLY resolve covers every
 * component rather than a table of which owns what — Traces alone owns
 * two rows, and a component added later would own more.
 *
 * Turning a component back ON needs no counterpart: an unnamed row keeps
 * its default position, which is what absence from the order means.
 */
// Watched rather than called from the toggle: the destructive path flips
// the flag itself, after its confirmation, so a toggle-only hook would
// have covered half the ways a component goes off.
// Watches everything that decides which rows EXIST, not just the
// component flags: pages (deleting one prunes its entry) and `traces`,
// whose `source` gates the zipkin-trace row. Miss one and the preview
// stops drawing a row while the stored order keeps naming it — the draft
// looks right and the push is refused for a row the editor no longer
// shows anywhere.
watch(
  () => [
    JSON.stringify(template.value.components ?? {}),
    JSON.stringify(template.value.dashboardExtPages ?? {}),
    JSON.stringify(template.value.traces ?? {}),
  ].join('|'),
  () => pruneMenuOrderToRows(),
);

function pruneMenuOrderToRows(): void {
  const order = template.value.menuOrder;
  if (!Array.isArray(order)) return;
  const kept = pruneMenuOrder(order, menuRows.value.map((r) => r.path));
  // Normalised here rather than only on a drag: a page deleted or a
  // component switched off can leave an order that says exactly what
  // absence says, and storing that is a pending change against OAP that
  // moves no menu.
  if (isBuiltInOrder(kept, builtInOrder.value)) {
    delete template.value.menuOrder;
    return;
  }
  if (kept.length !== order.length) template.value.menuOrder = kept;
}

/** Components whose OFF destroys configuration only they can reach.
 *
 *  The three entity ones own a widget grid and its pages. The rest own a
 *  config block each — the MQE an operator tuned for that view — which is
 *  just as unreachable once the component is off, and just as invisible:
 *  it would sit in the draft, unrendered, until a future toggle brought
 *  back a configuration nobody remembered writing. `traces` is absent on
 *  purpose: its `traces.source` picks a receiver, not a view's content,
 *  and it is one enum an operator retypes in a second. */
const DESTRUCTIVE_OFF = new Set<ComponentKey>([
  'service',
  'instances',
  'endpoints',
  'topology',
  'deployment',
  'endpointDependency',
]);


/**
 * The layer's REAL sidebar rows, resolved exactly as the runtime resolves
 * them — components, their extension pages, and every feature tab. This is
 * the menu-order editor, so it has to be the menu, not a summary of it.
 */
const ROW_TO_ADMIN_SCOPE: Record<string, AdminScope | undefined> = {
  service: 'service',
  instance: 'instance',
  endpoint: 'endpoint',
  topology: 'topology',
  deployment: 'deployment',
  dependency: 'dependency',
  trace: 'trace',
  logs: 'logs',
  'network-profiling': 'networkProfiling',
};

/** The order this layer resolves to with NO stored arrangement — what
 *  "the built-in order" means for these components and pages. */
const builtInOrder = computed<string[]>(() => {
  const tpl = template.value;
  return resolveLayerMenuRows({
    caps: componentsToCaps(tpl.components, tpl.topology, tpl.deployment),
    slots: tpl.slots ?? {},
    traces: tpl.traces,
    extPages: extPagesForPreview(tpl),
  }).map((r) => r.path);
});

const menuRows = computed(() => {
  const tpl = template.value;
  const rows = resolveLayerMenuRows({
    caps: componentsToCaps(tpl.components, tpl.topology, tpl.deployment),
    slots: tpl.slots ?? {},
    traces: tpl.traces,
    extPages: extPagesForPreview(tpl),
    menuOrder: tpl.menuOrder,
  });
  return rows.map((r) => {
    const [component, pageId] = r.path.split('/');
    return {
      path: r.path,
      // A page carries its own name; a built-in row is labelled by its slot
      // alias where the layer renames it, else by the row's own wording.
      label: r.name ?? labelForRow(r.path),
      // Two pages may share a display name — the id is what tells them
      // apart, here and in the page selector.
      hint: pageId,
      page: !!pageId,
      scope: ROW_TO_ADMIN_SCOPE[component],
      pageId,
      // Profiling, pod logs and browser errors have no editable config, so
      // their rows are labels rather than dead buttons.
      jumpable: !!ROW_TO_ADMIN_SCOPE[component],
    };
  });
});

function extPagesForPreview(tpl: AdminLayerTemplate) {
  const src = tpl.dashboardExtPages;
  if (!src) return undefined;
  const out: Record<string, Array<{ id: string; name: string }>> = {};
  for (const scope of ['service', 'instance', 'endpoint'] as const) {
    const pages = src[scope];
    if (pages?.length) out[scope] = pages.map((p) => ({ id: p.id, name: p.name }));
  }
  return Object.keys(out).length ? out : undefined;
}

function labelForRow(path: string): string {
  const slots = template.value.slots ?? {};
  switch (path) {
    case 'service': return slots.services || t('Service');
    case 'instance': return slots.instances || t('Instance');
    case 'endpoint': return slots.endpoints || t('Endpoint');
    case 'topology': return slots.topology || t('Topology');
    case 'deployment': return slots.deployment || t('Deployment');
    case 'dependency': return slots.endpointDependency || t('Dependency');
    case 'trace': return t('Traces');
    case 'zipkin-trace': return t('OTel & Zipkin Traces');
    case 'logs': return t('Logs');
    case 'browser-errors': return t('Browser Logs');
    case 'pod-logs': return t('Pod Logs');
    case 'trace-profiling': return t('Trace Profiling');
    case 'ebpf-profiling': return t('eBPF Profiling');
    case 'network-profiling': return t('Network Profiling');
    case 'continuous-profiling': return t('Continuous Profiling');
    case 'pprof': return t('pprof (Go)');
    case 'async-profiling': return t('Async Profiling');
    default: return path;
  }
}

/** A stored arrangement exists. Independent of whether dragging is on:
 *  closing the drag mode must not throw the arrangement away. */
const customOrder = computed(() => Array.isArray(template.value.menuOrder));
/** Dragging is a MODE, not the setting: closing it keeps the arrangement,
 *  and it starts off — an operator arrives to read the menu, not to move
 *  it. Reset on a layer change because the parent reuses this component
 *  across layers, which left the next layer in drag mode. */
const rearranging = ref(false);
watch(() => template.value.key, () => (rearranging.value = false));
/** The row the editor is currently on, so its id can be shown once
 *  rather than on every row. */
const selectedRow = computed(
  () => menuRows.value.find((m) => m.scope === props.activeScope && (m.pageId ?? null) === (activePage.value ?? null)) ?? null,
);

/** Turning the mode on stores NOTHING: an arrangement identical to the
 *  built-in one is still a stored field, and would show as a pending
 *  change against OAP that says nothing. The first drop writes it. */
function setRearranging(on: boolean): void {
  rearranging.value = on;
}

/** The only way back to the built-in order. Absence IS that order, so
 *  this deletes the field rather than storing a second spelling of it. */
function resetOrder(): void {
  delete template.value.menuOrder;
  rearranging.value = false;
}

const dragFrom = ref<number | null>(null);
const dragOver = ref<number | null>(null);
function onOrderDragStart(i: number): void {
  dragFrom.value = i;
}
function onOrderDrop(to: number): void {
  const from = dragFrom.value;
  dragFrom.value = null;
  dragOver.value = null;
  if (from === null || from === to) return;
  // Always store the FULL resolved order, never a partial list — a stored
  // order that names only some rows leaves the rest to default placement,
  // which is not what dragging one row is meant to express.
  const paths = menuRows.value.map((r) => r.path);
  const [moved] = paths.splice(from, 1);
  paths.splice(to, 0, moved);
  writeOrder(paths);
}

/** Storing an order equal to the built-in one is storing nothing: absence
 *  IS that order, so the field would be a pending change against OAP that
 *  changes no menu. Dragging back to where you started removes it. */
function writeOrder(paths: string[]): void {
  if (isBuiltInOrder(paths, builtInOrder.value)) {
    delete template.value.menuOrder;
    return;
  }
  template.value.menuOrder = paths;
}

/** The configurable slot aliases. Shown for the components the
 *  layer actually exposes so the editor mirrors the menu. */
const ALIAS_FIELDS = computed((): Array<{ slot: SlotKey; label: string; comp: ComponentKey; def: string; requireInstanceTopology?: boolean }> => [
  // Order mirrors the real sidebar / menu: Topology (+ its Instance map
  // drill-down) sits before API dependency.
  { slot: 'services', label: t('Services'), comp: 'service', def: t('Service') },
  { slot: 'instances', label: t('Instances'), comp: 'instances', def: t('Instance') },
  { slot: 'endpoints', label: t('Endpoints'), comp: 'endpoints', def: t('Endpoint') },
  { slot: 'topology', label: t('Topology'), comp: 'topology', def: t('Topology') },
  { slot: 'instanceTopology', label: t('Instance topology'), comp: 'topology', def: t('Instance map'), requireInstanceTopology: true },
  { slot: 'deployment', label: t('Deployment'), comp: 'deployment', def: t('Deployment') },
  { slot: 'endpointDependency', label: t('API dependency'), comp: 'endpointDependency', def: t('Dependency') },
]);
const visibleAliasFields = computed(() =>
  ALIAS_FIELDS.value.filter(
    (f) => !!template.value.components?.[f.comp] && (!f.requireInstanceTopology || props.instanceTopologyEnabled),
  ),
);
function ensureSlots(): NonNullable<AdminLayerTemplate['slots']> {
  if (!template.value.slots) (template.value as AdminLayerTemplate).slots = {};
  return template.value.slots;
}
/** Write a slot alias. `slots` is the canonical field the loader reads;
 *  mirror to the JSON's legacy `aliases` so the saved file stays
 *  internally consistent (the loader prefers `slots`, but keeping both
 *  in step avoids a confusing stale `aliases` block in the bundle). */
function setSlot(slot: SlotKey, value: string): void {
  const s = ensureSlots();
  const v = value.trim();
  if (v) s[slot] = v;
  else delete s[slot];
  const a = ((template.value as { aliases?: Record<string, string> }).aliases ??= {});
  if (v) a[slot] = v;
  else delete a[slot];
}
</script>

<template>
  <!-- Layer setup: left = live menu preview (alias header + the
       enabled components, in checkbox order — clicking an item
       jumps to that component's config + preview below). Right =
       alias edit (before Components, per request) + the Components
       toggles that drive which menu entries exist. -->
  <section class="sw-card setup-card">
    <div class="setup-grid">
      <div class="menu-preview">
        <div class="menu-preview-head">
          <span class="dot inline" :style="{ background: template.color || 'var(--sw-fg-3)' }" />
          <span class="menu-preview-title">{{ template.alias || template.key }}</span>
          <code v-if="template.alias && template.alias !== template.key" class="key-tag">{{ template.key }}</code>
        </div>
        <p v-if="menuRows.length === 0" class="menu-preview-empty">
          {{ t('No components enabled — toggle one on the right to populate the menu.') }}
        </p>
        <!-- A switch, not a checkbox: this turns a MODE on — the rows
             stop being links and become draggable — rather than ticking
             an option that takes effect on save. The checkbox beside the
             component list means the other thing, and reading both as the
             same control is what made this one look like a setting. -->
        <label v-else class="order-toggle">
          <input
            type="checkbox"
            role="switch"
            class="order-switch"
            :aria-checked="rearranging"
            :checked="rearranging"
            @change="setRearranging(!rearranging)"
          />
          <span>{{ t('Rearrange menu') }}</span>
          <span class="order-hint">{{
            rearranging
              ? t('drag an entry to move it')
              : customOrder
                ? t('the menu uses your order')
                : t('the menu follows the built-in order')
          }}</span>
        </label>
        <button v-if="customOrder" type="button" class="sw-btn xs ghost order-reset" @click="resetOrder">
          {{ t('Reset to built-in order') }}
        </button>
        <button
          v-for="(m, i) in menuRows"
          :key="m.path"
          type="button"
          class="menu-item"
          :class="{
            on: activeScope === m.scope && (m.pageId ?? null) === (activePage ?? null),
            'is-page': !!m.page,
            'is-inert': !m.jumpable,
            draggable: rearranging,
            over: dragOver === i,
          }"
          :disabled="!rearranging && !m.jumpable"
          :draggable="rearranging"
          :title="rearranging
            ? t('Drag to move {label}', { label: m.hint ? `${m.label} (${m.hint})` : m.label })
            : m.jumpable
              ? t('Jump to {label} config', { label: m.label })
              : t('{label} has no editable configuration', { label: m.label })"
          @dragstart="onOrderDragStart(i)"
          @dragover.prevent="dragOver = i"
          @drop.prevent="onOrderDrop(i)"
          @dragend="dragFrom = null; dragOver = null"
          @click="!rearranging && m.jumpable && emit('jump', { scope: m.scope!, page: m.pageId ?? null })"
        >
          <span v-if="rearranging" class="menu-grip">⠿</span>
          <span class="menu-item-label">{{ m.label }}</span>
          <!-- Shown because two pages may share a display name; the id is
               what tells them apart. Not in the runtime sidebar. -->
          <code v-if="m.hint" class="menu-item-hint">{{ m.hint }}</code>
          <span v-if="!rearranging && m.jumpable" class="menu-item-arrow">›</span>
        </button>
        <!-- The key is the route segment, the `menuOrder` entry and the
             translation anchor. Hidden while rearranging. -->
        <p v-if="!rearranging && selectedRow" class="menu-detail">
          <span class="menu-detail-field">{{ t('Menu key') }}</span>
          <code>{{ selectedRow.path }}</code>
          <span class="menu-detail-kind">{{ selectedRow.page ? t('extra page') : t('built-in entry') }}</span>
        </p>
      </div>
      <div class="setup-right">
        <label class="alias-field">
          <span>{{ t('Alias') }}</span>
          <input
            v-model="template.alias"
            type="text"
            class="alias-input"
            :placeholder="template.key"
            spellcheck="false"
          />
          <span class="alias-hint">{{ t('Display name in the sidebar, layer list, and landing KPI tile. Defaults to the layer key.') }}</span>
        </label>
        <div class="alias-field">
          <span>{{ t('Group split') }}</span>
          <label class="split-check">
            <input type="checkbox" v-model="template.splitByServiceGroup" />
            <span>{{ t("Split this layer's menu by service group") }}</span>
          </label>
          <span class="alias-hint">{{ t('One sidebar entry per OAP') }} <code>Service.group</code> {{ t('(the') }} <code>group::</code> {{ t('prefix), each scoped to its group. Off keeps all groups in one menu.') }}</span>
        </div>
        <div class="setup-section-head">
          <h4>{{ t('Components') }}</h4>
          <span class="sub">{{ t('which sub-views this layer exposes') }}</span>
        </div>
        <div class="comp-grid">
          <label
            v-for="t in COMPONENT_TOGGLES"
            :key="t.key"
            class="comp-toggle"
            :class="{ on: !!template.components?.[t.key] }"
            :title="t.hint"
          >
            <input
              type="checkbox"
              :checked="!!template.components?.[t.key]"
              @change="toggleComponent(t.key)"
            />
            <span class="comp-label">{{ t.label }}</span>
          </label>
        </div>
        <!-- Menu labels (slot aliases): rename the per-component
             nouns the way the layer's own vocabulary reads (e.g.
             services → "ClickHouse clusters", instances → "Nodes").
             Shown only for enabled components; drives the menu
             preview, scope tabs, and section headings live. -->
        <template v-if="visibleAliasFields.length > 0">
          <div class="setup-section-head">
            <h4>{{ t('Menu labels') }}</h4>
            <span class="sub">{{ t('rename the nouns shown in the menu & tabs (optional)') }}</span>
          </div>
          <div class="alias-grid">
            <label v-for="f in visibleAliasFields" :key="f.slot" class="alias-grid-field">
              <span>{{ f.label }}</span>
              <input
                type="text"
                class="alias-input sm"
                :value="template.slots?.[f.slot] ?? ''"
                :placeholder="f.def"
                spellcheck="false"
                @input="setSlot(f.slot, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Layer setup card — menu preview (left) + alias/components (right).
   (.sw-card / .sw-btn are global; everything else is duplicated scoped.) */
.setup-card { padding: 0; }
.setup-grid {
  display: grid;
  grid-template-columns: 240px 1fr;
  align-items: stretch;
}
.menu-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 12px 14px;
  border-right: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  border-radius: var(--sw-radius, 8px) 0 0 var(--sw-radius, 8px);
}
.menu-preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--sw-line);
}
.menu-preview-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.menu-preview-empty {
  margin: 4px 8px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  line-height: 1.5;
}
.dot.inline {
  width: 12px; height: 12px;
  border-radius: 50%;
  display: inline-block;
}
/* Dim mono chip for the raw layer key, shown next to the alias so the
 * operator sees both the display name and the OAP layer identity. */
.key-tag {
  flex: 0 0 auto;
  font-family: var(--sw-mono);
  font-size: 9.5px;
  letter-spacing: 0.02em;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.order-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 2px 8px;
  font-size: 11px;
  color: var(--sw-fg-1);
  cursor: pointer;
}
/* A track with a knob, sized off the label's own line-height so it sits
   on the text baseline rather than floating above it. */
.order-switch {
  appearance: none;
  flex: none;
  position: relative;
  width: 26px;
  height: 14px;
  margin: 0;
  border: 1px solid var(--sw-line-2);
  border-radius: 999px;
  background: var(--sw-bg-2);
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.order-switch::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 1px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--sw-fg-3);
  transition: transform 120ms ease, background 120ms ease;
}
.order-switch:checked {
  background: color-mix(in srgb, var(--sw-accent) 30%, transparent);
  border-color: var(--sw-accent);
}
.order-switch:checked::after {
  transform: translateX(12px);
  background: var(--sw-accent);
}
.order-switch:focus-visible { outline: 1px solid var(--sw-accent); outline-offset: 2px; }
.order-hint {
  color: var(--sw-fg-3);
  font-size: 10.5px;
}
.menu-detail {
  margin: 8px 0 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 7px;
  font-size: 11px;
  color: var(--sw-fg-3);
}
.menu-detail-field { color: var(--sw-fg-3); }
.menu-detail code { font-family: var(--sw-mono); color: var(--sw-fg-1); }
.menu-detail-kind { color: var(--sw-fg-3); }
.menu-item-id {
  font-size: 9.5px;
  color: var(--sw-fg-3);
  margin-left: 4px;
}
.menu-item:disabled {
  cursor: default;
  opacity: 0.75;
}
.menu-grip {
  color: var(--sw-fg-3);
  cursor: grab;
  margin-right: 2px;
}
/* No indent: pages are FLAT siblings in the sidebar, and a custom order
   can place one anywhere — an indent would claim a parent three rows
   away. The id chip beside the label is what marks a page. */
.menu-item.is-page .menu-item-label {
  color: var(--sw-fg-1);
}
.menu-item.draggable {
  cursor: grab;
}
.menu-item.is-inert {
  cursor: default;
  opacity: 0.72;
}
.menu-item.over {
  box-shadow: inset 0 2px 0 var(--sw-accent);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 5px;
  background: transparent;
  border: none;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.menu-item:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.menu-item.on {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.menu-item-label { flex: 1; }
.menu-item-hint {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
  margin-left: auto;
  padding-left: 8px;
}
.menu-item-arrow { color: var(--sw-fg-3); font-size: 13px; }
.menu-item.on .menu-item-arrow { color: var(--sw-accent-2); }
/* Instance map — a nested drill-down of Topology, not a sidebar entry. */
.menu-item.is-child { margin-left: 16px; font-size: 11.5px; color: var(--sw-fg-3); }
.menu-item.is-child:hover { color: var(--sw-fg-1); }
.setup-right {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px 14px;
  min-width: 0;
}
.alias-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.alias-field > span:first-child {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
}
.alias-input {
  height: 30px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 13px;
  max-width: 320px;
}
.alias-input:focus { outline: none; border-color: var(--sw-accent); }
.alias-hint { font-size: 10.5px; color: var(--sw-fg-3); line-height: 1.4; }
.alias-hint code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-2);
  padding: 0 3px;
  border-radius: 3px;
}
.split-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--sw-fg-1);
}
.split-check input { accent-color: var(--sw-accent); }
.setup-section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding-top: 4px;
  border-top: 1px dashed var(--sw-line);
}
.setup-section-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.setup-section-head .sub { font-size: 10.5px; color: var(--sw-fg-3); }
.setup-right .comp-grid { padding: 0; }
.comp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 6px;
  padding: 12px 14px;
}
.comp-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.comp-toggle:hover {
  background: var(--sw-bg-3);
}
.comp-toggle.on {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line);
  color: var(--sw-accent-2);
}
.comp-toggle input {
  accent-color: var(--sw-accent);
  margin: 0;
}
.comp-label {
  font-weight: 500;
}
/* Menu-label (slot alias) editor grid. */
.alias-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}
.alias-grid-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sw-fg-3);
}
.alias-input.sm { height: 28px; font-size: 12px; max-width: none; }
</style>
