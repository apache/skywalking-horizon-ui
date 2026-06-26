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
  CSS class; the row set itself is identical, capability-gated off the
  layer's `caps`/`slots`. The visible tab order mirrors `firstLayerTab` in
  `useLayers`.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import { firstLayerTab } from '@/shell/useLayers';
import { useRouteActive } from '@/shell/useSidebarActive';

const props = defineProps<{ layer: LayerDef; inGroup?: boolean }>();

const { t } = useI18n({ useScope: 'global' });
const { route, isActive } = useRouteActive();

const L = computed(() => props.layer);
const hasInstances = computed(() => L.value.caps.instances ?? Boolean(L.value.slots.instances));
const hasEndpoints = computed(() => L.value.caps.endpoints ?? Boolean(L.value.slots.endpoints));
const hasTopology = computed(() =>
  Boolean(L.value.caps.serviceMap || L.value.caps.instanceTopology || L.value.caps.processTopology),
);
</script>

<template>
  <div class="layer-children" :class="{ 'in-group': inGroup }">
    <RouterLink
      v-if="L.caps.dashboards"
      :to="`/layer/${L.key}/${firstLayerTab(L)}`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/${firstLayerTab(L)}`) || route.path === `/layer/${L.key}` }"
    >
      <Icon name="svc" /><span>Service</span>
      <span class="sw-badge" style="margin-left: auto">{{ L.serviceCount }}</span>
    </RouterLink>
    <RouterLink
      v-if="hasInstances"
      :to="`/layer/${L.key}/instance`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/instance`) }"
    >
      <Icon name="prof" /><span>{{ L.slots.instances ?? 'Instance' }}</span>
    </RouterLink>
    <RouterLink
      v-if="hasEndpoints"
      :to="`/layer/${L.key}/endpoint`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/endpoint`) }"
    >
      <Icon name="ep" /><span>{{ L.slots.endpoints ?? 'Endpoint' }}</span>
    </RouterLink>
    <RouterLink
      v-if="hasTopology"
      :to="`/layer/${L.key}/topology`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/topology`) }"
    >
      <Icon name="topo" /><span>{{ L.slots.topology ?? 'Topology' }}</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.deployment"
      :to="`/layer/${L.key}/deployment`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/deployment`) }"
    >
      <Icon name="topo" /><span>{{ L.slots.deployment ?? 'Deployment' }}</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.endpointDependency"
      :to="`/layer/${L.key}/dependency`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/dependency`) }"
    >
      <Icon name="ep" /><span>{{ L.slots.endpointDependency ?? `${L.slots.endpoints ?? 'Endpoint'} dependency` }}</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.traces"
      :to="`/layer/${L.key}/trace`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/trace`) }"
    >
      <Icon name="trace" /><span>Traces</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.traces && L.traces?.source === 'both'"
      :to="`/layer/${L.key}/zipkin-trace`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/zipkin-trace`) }"
    >
      <Icon name="trace" /><span>OTel &amp; Zipkin Traces</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.logs"
      :to="`/layer/${L.key}/logs`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/logs`) }"
    >
      <Icon name="log" /><span>Logs</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.browserErrors"
      :to="`/layer/${L.key}/browser-errors`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/browser-errors`) }"
    >
      <Icon name="web" /><span>{{ t('Browser Logs') }}</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.podLogs"
      :to="`/layer/${L.key}/pod-logs`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/pod-logs`) }"
    >
      <Icon name="log" /><span>Pod Logs</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.traceProfiling"
      :to="`/layer/${L.key}/trace-profiling`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/trace-profiling`) }"
    >
      <Icon name="flame" /><span>Trace Profiling</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.ebpfProfiling"
      :to="`/layer/${L.key}/ebpf-profiling`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/ebpf-profiling`) }"
    >
      <Icon name="flame" /><span>eBPF Profiling</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.networkProfiling"
      :to="`/layer/${L.key}/network-profiling`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/network-profiling`) }"
    >
      <Icon name="prof" /><span>Network Profiling</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.pprofProfiling"
      :to="`/layer/${L.key}/pprof`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/pprof`) }"
    >
      <Icon name="prof" /><span>pprof (Go)</span>
    </RouterLink>
    <RouterLink
      v-if="L.caps.asyncProfiling"
      :to="`/layer/${L.key}/async-profiling`"
      class="sw-nav-item"
      :class="{ 'is-active': isActive(`/layer/${L.key}/async-profiling`) }"
    >
      <Icon name="flame" /><span>Async Profiling</span>
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
