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
import { computed } from 'vue';
import type { AdminLayerTemplate } from '@/api/client';
import type { AdminScope, ComponentKey, SlotKey } from './layer-dashboards.scopes';

// `template` is a model (not a plain prop) so the alias / group-split inputs
// can v-model directly onto it and the component can mutate the shared draft's
// `components` / `slots` IN PLACE. The parent passes `draft.template`; we never
// reassign the whole object (only nested keys), so no `update:template` fires.
const template = defineModel<AdminLayerTemplate>('template', { required: true });
const props = defineProps<{
  activeScope: AdminScope;
  instanceTopologyEnabled: boolean;
}>();
const emit = defineEmits<{ jump: [scope: AdminScope] }>();

/**
 * Component toggles surfaced in the admin editor. Each entry binds to
 * a key on the template's `components` block; flipping the toggle
 * shows / hides the matching sidebar entry + per-layer route.
 */
const COMPONENT_TOGGLES: Array<{ key: ComponentKey; label: string; hint: string }> = [
  { key: 'service', label: 'Service', hint: "The layer's primary landing — widget grid driven by dashboards.service." },
  { key: 'instances', label: 'Instances', hint: 'Per-instance dashboard (dashboards.instance widget set).' },
  { key: 'endpoints', label: 'Endpoints', hint: 'Per-endpoint dashboard (dashboards.endpoint widget set).' },
  // Order mirrors the real sidebar: Topology sits before API dependency.
  { key: 'topology', label: 'Topology', hint: 'Service topology graph for this layer.' },
  { key: 'deployment', label: 'Deployment', hint: 'Deployment topology of all of a service’s instances — the instance-to-instance call graph within one service. Needs a deployment config block to appear.' },
  { key: 'endpointDependency', label: 'API dependency', hint: 'Endpoint-to-endpoint dependency view.' },
  { key: 'traces', label: 'Traces', hint: 'Trace explorer scoped to this layer.' },
  { key: 'logs', label: 'Logs', hint: 'Log explorer scoped to this layer.' },
  { key: 'browserErrors', label: 'Browser Logs', hint: 'BROWSER-layer JS error logs with source-map de-obfuscation of the minified stack.' },
  { key: 'podLogs', label: 'Pod Logs', hint: 'On-demand Kubernetes pod-log live tail. Only K8s-deployed layers (k8s_service, mesh) carry pods that resolve.' },
  { key: 'traceProfiling', label: 'Trace Profiling', hint: 'Trace-driven thread profiling — the original SkyWalking profile.' },
  { key: 'ebpfProfiling', label: 'eBPF Profiling', hint: 'Kernel-level CPU / off-CPU profiling via eBPF agents.' },
  { key: 'asyncProfiling', label: 'Async Profiling', hint: 'JVM async-profiler integration (Java-only).' },
];

function ensureComponents(): AdminLayerTemplate['components'] {
  if (!template.value.components) {
    (template.value as AdminLayerTemplate).components = {};
  }
  return template.value.components;
}
function toggleComponent(key: ComponentKey): void {
  const c = ensureComponents();
  c[key] = !c[key];
}

/** Inverse of SCOPE_COMPONENT, narrowed to the toggle keys — maps each
 *  Components checkbox to the editor scope its config lives under, so a
 *  menu-preview click can jump straight to that scope's widget editor. */
const COMPONENT_SCOPE: Record<ComponentKey, AdminScope> = {
  service: 'service',
  instances: 'instance',
  endpoints: 'endpoint',
  endpointDependency: 'dependency',
  topology: 'topology',
  deployment: 'deployment',
  traces: 'trace',
  logs: 'logs',
  // Browser Errors + Pod Logs have no editable widget grid — filler to
  // satisfy the exhaustive Record; the menu-preview click no-ops for them.
  browserErrors: 'logs',
  podLogs: 'logs',
  traceProfiling: 'traceProfiling',
  ebpfProfiling: 'ebpfProfiling',
  asyncProfiling: 'asyncProfiling',
  // Legacy umbrella flag — no checkbox of its own (the three granular
  // profiling toggles drive the menu), so this entry only satisfies the
  // exhaustive Record; it is never surfaced as a menu item.
  profiling: 'traceProfiling',
};
/** Component → slot-alias key. The layer's `slots` carry per-layer term
 *  aliases (services → "ClickHouse clusters", instances → "Nodes", …);
 *  the menu preview shows these instead of the generic component label,
 *  matching what the real sidebar renders. */
const COMPONENT_SLOT: Partial<Record<ComponentKey, SlotKey>> = {
  service: 'services',
  instances: 'instances',
  endpoints: 'endpoints',
  endpointDependency: 'endpointDependency',
  topology: 'topology',
  deployment: 'deployment',
};
/** The layer's sidebar menu as the operator would see it — only the
 *  enabled components, in COMPONENT_TOGGLES order, labelled with the
 *  layer's slot aliases where defined. Drives the menu preview. */
const menuItems = computed<Array<{ key: string; label: string; scope: AdminScope; child?: boolean }>>(() => {
  const slots = template.value.slots ?? {};
  const items = COMPONENT_TOGGLES.filter((t) => !!template.value.components?.[t.key]).map((t) => {
    const slotKey = COMPONENT_SLOT[t.key];
    return {
      key: t.key as string,
      label: (slotKey && slots[slotKey]) || t.label,
      scope: COMPONENT_SCOPE[t.key],
      child: false,
    };
  });
  // Instance topology has no component flag of its own (it's a drill-down
  // of the topology tab, not a sidebar entry); show it as a NESTED child
  // under Topology so the preview reads "reached from Topology" — and so
  // it doesn't double-highlight when the topology scope is active. Only
  // when the Topology component is itself enabled (`topoIdx >= 0`): a
  // drill-down of a disabled tab must not appear, even if a stale
  // `topology.instanceTopology` block lingers in the config.
  const topoIdx = items.findIndex((i) => i.key === 'topology');
  if (props.instanceTopologyEnabled && topoIdx >= 0) {
    const instItem = { key: 'instanceTopology', label: slots.instanceTopology || 'Instance map', scope: 'topology' as AdminScope, child: true };
    items.splice(topoIdx + 1, 0, instItem);
  }
  return items;
});

/** The configurable slot aliases. Shown for the components the
 *  layer actually exposes so the editor mirrors the menu. */
const ALIAS_FIELDS: Array<{ slot: SlotKey; label: string; comp: ComponentKey; def: string; requireInstanceTopology?: boolean }> = [
  // Order mirrors the real sidebar / menu: Topology (+ its Instance map
  // drill-down) sits before API dependency.
  { slot: 'services', label: 'Services', comp: 'service', def: 'Service' },
  { slot: 'instances', label: 'Instances', comp: 'instances', def: 'Instance' },
  { slot: 'endpoints', label: 'Endpoints', comp: 'endpoints', def: 'Endpoint' },
  { slot: 'topology', label: 'Topology', comp: 'topology', def: 'Topology' },
  { slot: 'instanceTopology', label: 'Instance topology', comp: 'topology', def: 'Instance map', requireInstanceTopology: true },
  { slot: 'deployment', label: 'Deployment', comp: 'deployment', def: 'Deployment' },
  { slot: 'endpointDependency', label: 'API dependency', comp: 'endpointDependency', def: 'Dependency' },
];
const visibleAliasFields = computed(() =>
  ALIAS_FIELDS.filter(
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
        <p v-if="menuItems.length === 0" class="menu-preview-empty">
          No components enabled — toggle one on the right to populate the menu.
        </p>
        <button
          v-for="m in menuItems"
          :key="m.key"
          type="button"
          class="menu-item"
          :class="{ on: activeScope === m.scope && !m.child, 'is-child': m.child }"
          :title="`Jump to ${m.label} config`"
          @click="emit('jump', m.scope)"
        >
          <span class="menu-item-label">{{ m.child ? '↳ ' : '' }}{{ m.label }}</span>
          <span class="menu-item-arrow">›</span>
        </button>
      </div>
      <div class="setup-right">
        <label class="alias-field">
          <span>Alias</span>
          <input
            v-model="template.alias"
            type="text"
            class="alias-input"
            :placeholder="template.key"
            spellcheck="false"
          />
          <span class="alias-hint">Display name in the sidebar, layer list, and landing KPI tile. Defaults to the layer key.</span>
        </label>
        <div class="alias-field">
          <span>Group split</span>
          <label class="split-check">
            <input type="checkbox" v-model="template.splitByServiceGroup" />
            <span>Split this layer's menu by service group</span>
          </label>
          <span class="alias-hint">One sidebar entry per OAP <code>Service.group</code> (the <code>group::</code> prefix), each scoped to its group. Off keeps all groups in one menu.</span>
        </div>
        <div class="setup-section-head">
          <h4>Components</h4>
          <span class="sub">which sub-views this layer exposes</span>
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
            <h4>Menu labels</h4>
            <span class="sub">rename the nouns shown in the menu &amp; tabs (optional)</span>
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
