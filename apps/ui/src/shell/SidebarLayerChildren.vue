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
  The L2 tab cluster under an expanded layer row — one canonical copy for
  every placement (grouped, ungrouped, operate). `inGroup` only nudges the
  CSS class; which rows exist and in what order comes from the layer's
  resolved `menuRows`, so this component decides only how a row LOOKS.

  Labels are resolved by literal translation calls in the map below rather
  than travelling as data on the row: `check-ui-i18n.mjs` only recognises
  literal keys, so passing a key through a variable would report every
  sidebar string as an orphan.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import { layerMenuRows } from '@/shell/useLayers';
import { useRouteActive } from '@/shell/useSidebarActive';

const props = defineProps<{ layer: LayerDef; inGroup?: boolean }>();

const { t } = useI18n({ useScope: 'global' });
const { route, isActive, isActiveExact } = useRouteActive();

const L = computed(() => props.layer);

function labelFor(path: string): string {
  const slots = L.value.slots;
  switch (path) {
    case 'service': return t('Service');
    case 'instance': return slots.instances ?? t('Instance');
    case 'endpoint': return slots.endpoints ?? t('Endpoint');
    case 'topology': return slots.topology ?? t('Topology');
    case 'deployment': return slots.deployment ?? t('Deployment');
    case 'dependency':
      return slots.endpointDependency ?? t('{endpoint} dependency', { endpoint: slots.endpoints ?? t('Endpoint') });
    case 'trace': return t('Traces');
    case 'zipkin-trace': return t('OTel & Zipkin Traces');
    case 'logs': return t('Logs');
    case 'evaluation-record': return t('View evaluation records');
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

const rows = computed(() =>
  layerMenuRows(L.value).map((r) => ({
    ...r,
    to: `/layer/${L.value.key}/${r.path}`,
    // The page's own name when it has one; otherwise the component's
    // literal translation.
    label: r.name ?? labelFor(r.path),
    // An extension page's route sits UNDER its component's, so the
    // prefix match that lights up a component would light it up for
    // every one of its pages too. Component rows therefore match
    // exactly; only they can be a prefix of another row.
    exact: !r.path.includes('/'),
  })),
);
// The layer's own row already links here, and the bare `/layer/:key` URL
// redirects to it — both light up the first row.
const firstRowTo = computed(() => rows.value[0]?.to ?? '');
</script>

<template>
  <div class="layer-children" :class="{ 'in-group': inGroup }">
    <RouterLink
      v-for="row in rows"
      :key="row.path"
      :to="row.to"
      class="sw-nav-item"
      :class="{
        'is-active':
          (row.exact ? isActiveExact(row.to) : isActive(row.to)) ||
          (row.to === firstRowTo && route.path === `/layer/${L.key}`),
      }"
    >
      <Icon :name="row.icon" /><span>{{ row.label }}</span>
      <span v-if="row.path === 'service'" class="sw-badge" style="margin-left: auto">{{ L.serviceCount }}</span>
    </RouterLink>
  </div>
</template>

<style scoped>
/* L2 — children of an expanded layer. Vertical rail at left:22 with
 * a per-row horizontal tick; the last child masks the rail's tail
 * with --sw-bg-1 so it reads as a half-line. */
.layer-children {
  position: relative;
  padding: 2px 0 4px;
  margin-bottom: 4px;
}
.layer-children::before {
  content: '';
  position: absolute;
  left: 22px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--sw-line-2);
}
.layer-children .sw-nav-item {
  position: relative;
  margin: 1px 8px 1px 28px;
  padding: 5px 9px;
  border-radius: 5px;
  font-size: 11.5px;
  font-weight: 500;
  text-decoration: none;
  gap: 8px;
  color: var(--sw-fg-1);
}
.layer-children .sw-nav-item::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 50%;
  width: 8px;
  height: 1px;
  background: var(--sw-line-2);
}
.layer-children .sw-nav-item:last-child::after {
  content: '';
  position: absolute;
  left: -7px;
  top: calc(50% + 1px);
  bottom: -4px;
  width: 2px;
  background: var(--sw-bg-1);
}
.layer-children .sw-nav-item :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  color: var(--sw-fg-2);
  opacity: 1;
}
.layer-children .sw-nav-item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--sw-fg-0);
}
.layer-children .sw-nav-item.is-active {
  background: rgba(249, 115, 22, 0.12);
  color: var(--sw-fg-0);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--sw-accent);
}
.layer-children .sw-nav-item.is-active :deep(svg) {
  color: var(--sw-accent);
}
/* Grouped layer rows sit at the same indent — the group header already
 * delineates the section, so no extra tree-style nest. */
.layer-children.in-group { }
.sw-nav-item {
  text-decoration: none;
}
</style>
