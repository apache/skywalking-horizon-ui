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
  Topology focus picker — the toolbar dropdown that seeds the service
  map's BFS. Multi-select + search; rows are grouped by the service's
  own GROUP (OAP's `Service.group`, the `<group>::` prefix). Lives INSIDE
  the topology box so the layer-wide map stays the default. The selection
  is a v-model array of raw service names (comma-joined upstream into the
  `?service=` query).
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import {
  resolveServiceIdentity,
  type ServiceIdentity,
} from '@/utils/serviceName';
import type { LandingServiceRow } from '@/api/client';
import type { ServiceNamingRule } from '@skywalking-horizon-ui/api-client';

const props = defineProps<{
  selected: string[];
  landingRows: LandingServiceRow[];
  namingRule: ServiceNamingRule | null;
}>();
const emit = defineEmits<{ 'update:selected': [string[]] }>();

const open = ref(false);
const search = ref('');
useEscapeToClose(() => open.value, () => { open.value = false; });
function toggleOpen(): void { open.value = !open.value; }
function identity(name: string | null | undefined): ServiceIdentity {
  return resolveServiceIdentity(name, props.namingRule);
}

function setSelected(next: string[]): void { emit('update:selected', next); }
function toggleService(name: string): void {
  const i = props.selected.indexOf(name);
  if (i >= 0) setSelected(props.selected.filter((x) => x !== name));
  else setSelected([...props.selected, name]);
}
function clearFocus(): void { setSelected([]); open.value = false; }

// Service-list rows grouped by the service's own GROUP — OAP's
// `Service.group` (the `<group>::` prefix, e.g. `agent`,
// `skywalking-showcase`), a per-service attribute that needs no per-layer
// setup. The search panel renders one section per group (`group · agent`);
// a service with no group falls into one header-less section.
interface GroupedRow { name: string; id: string; raw: string }
const groupedRows = computed<Map<string, GroupedRow[]>>(() => {
  const map = new Map<string, GroupedRow[]>();
  const term = search.value.trim().toLowerCase();
  for (const r of props.landingRows) {
    const id = identity(r.serviceName);
    if (term && !r.serviceName.toLowerCase().includes(term)) continue;
    // Group by the service's own group — OAP's served `Service.group`,
    // falling back to the `::` prefix parsed from the name. NOT the
    // per-layer topology-cluster rule, so it works on every layer.
    const grp = r.group ?? id.legacyGroup ?? '';
    if (!map.has(grp)) map.set(grp, []);
    map.get(grp)!.push({ name: id.display, id: r.serviceId, raw: r.serviceName });
  }
  return map;
});
const groupAliasLabel = 'group';

// Batch select / unselect every service in a group from its header.
// Tri-state drives the header glyph: 'all' = every row of the group is
// focused, 'none' = none, 'some' = partial.
function groupSelState(rows: GroupedRow[]): 'all' | 'some' | 'none' {
  let n = 0;
  for (const r of rows) if (props.selected.includes(r.raw)) n++;
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some';
}
function toggleGroup(rows: GroupedRow[]): void {
  const raws = rows.map((r) => r.raw);
  const allSel = raws.every((x) => props.selected.includes(x));
  // Already all-selected ⇒ drop the whole group; otherwise add the
  // missing ones (dedup) so a partial group fills to full.
  setSelected(
    allSel
      ? props.selected.filter((x) => !raws.includes(x))
      : [...new Set([...props.selected, ...raws])],
  );
}

defineExpose({ open });
</script>

<template>
  <!-- Focus picker — lives INSIDE the topology box so the header service
       picker stays out of the layer-wide map. Supports multi-select +
       search. Closes by clicking outside the chips (via the wrapper
       @click.stop). -->
  <div class="focus-wrap" @click.stop>
    <button class="focus-btn sw-btn small" type="button" @click="toggleOpen">
      <span class="focus-btn-label">
        {{ selected.length === 0 ? 'All services' : selected.length + ' selected' }}
      </span>
      <span class="caret" :class="{ open }">▾</span>
    </button>
    <div v-if="open" class="focus-pop sw-card">
      <input
        v-model="search"
        class="focus-search"
        type="text"
        placeholder="Search services…"
        autofocus
      />
      <div class="focus-list">
        <button
          class="focus-row clear"
          :class="{ selected: selected.length === 0 }"
          type="button"
          @click="clearFocus"
        >
          <span class="focus-check" :class="{ on: selected.length === 0 }" />
          <span class="focus-name">All services</span>
          <span class="focus-aside">{{ landingRows.length }} total</span>
        </button>
        <template v-for="[gkey, rows] in groupedRows" :key="gkey">
          <button
            v-if="gkey"
            class="focus-group-head"
            type="button"
            :title="groupSelState(rows) === 'all' ? `Unselect all in ${gkey}` : `Select all in ${gkey}`"
            @click="toggleGroup(rows)"
          >
            <span class="focus-check" :class="groupSelState(rows)" />
            <span class="focus-group-val">{{ gkey }}</span>
            <span class="focus-group-alias">[{{ groupAliasLabel }}]</span>
          </button>
          <div :class="['focus-group-body', { grouped: gkey }]">
            <button
              v-for="r in rows"
              :key="r.id"
              class="focus-row"
              :class="{ selected: selected.includes(r.raw), 'in-group': gkey }"
              type="button"
              @click="toggleService(r.raw)"
            >
              <span class="focus-check" :class="{ on: selected.includes(r.raw) }" />
              <span class="focus-name">{{ r.name }}</span>
            </button>
          </div>
        </template>
        <div v-if="groupedRows.size === 0" class="focus-empty">no matches</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Focus selector — opens a search-driven multi-select panel anchored
   to the button. Wide enough to read group + name in one row even on
   long k8s service names. */
.focus-wrap { position: relative; }
.focus-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 160px;
  justify-content: space-between;
}
.focus-btn .caret { font-size: 9px; color: var(--sw-fg-3); transition: transform 0.12s; }
.focus-btn .caret.open { transform: rotate(180deg); }
.focus-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 360px;
  max-height: 380px;
  display: flex;
  flex-direction: column;
  padding: 8px;
  z-index: 30;
}
.focus-search {
  height: 32px;
  padding: 0 10px;
  margin-bottom: 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.focus-search:focus { border-color: var(--sw-accent-line); }
.focus-list { overflow-y: auto; flex: 1 1 auto; }
.focus-group-head {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sw-fg-3);
  padding: 6px 8px 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: transparent;
  border: 0;
  border-radius: 4px;
  text-align: left;
  cursor: pointer;
}
.focus-group-head:hover { background: var(--sw-bg-2); }
/* Tri-state batch-select glyph on a group header: filled = all of the
   group focused, half = some, hollow = none. */
/* Selection markers are CSS-drawn circles, NOT font glyphs, so the
   group header's dot and a service row's dot are pixel-identical
   regardless of font fallback: a ring when empty, filled when on / all,
   half-filled for a partially-selected group. */
.focus-check {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  box-sizing: border-box;
  border-radius: 50%;
  border: 1.5px solid var(--sw-accent);
  background: transparent;
}
.focus-check.on,
.focus-check.all { background: var(--sw-accent); }
.focus-check.some {
  background: linear-gradient(90deg, var(--sw-accent) 0 50%, transparent 50% 100%);
}
/* A group's services nest under its header: a left guide line + extra
   indent make the parent → children relationship read at a glance.
   Ungrouped rows (no header) keep the base indent and no guide. */
.focus-group-body.grouped {
  margin-left: 15px;
  border-left: 1px solid var(--sw-line);
}
.focus-row.in-group { padding-left: 14px; }
.focus-group-val {
  color: var(--sw-accent-2);
  font-family: var(--sw-mono);
  font-size: 12px;
  font-weight: 700;
  text-transform: none;
  letter-spacing: 0;
}
/* `[GROUP]` qualifier trailing the value — subdued so the group name reads first. */
.focus-group-alias {
  color: var(--sw-fg-3);
  font-size: 9px;
  font-weight: 600;
  opacity: 0.85;
}
.focus-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.focus-row:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.focus-row.selected { color: var(--sw-accent-2); }
.focus-row .focus-name { flex: 1; font-family: var(--sw-mono); }
.focus-row .focus-aside { font-size: 10.5px; color: var(--sw-fg-3); }
.focus-row.clear { border-bottom: 1px dashed var(--sw-line); padding-bottom: 8px; margin-bottom: 4px; }
.focus-empty { padding: 16px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
</style>
