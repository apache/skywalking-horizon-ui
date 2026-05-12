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
import { ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import Icon, { type IconName } from '@/components/icons/Icon.vue';
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
async function signOut(): Promise<void> {
  await auth.logout();
  await router.push({ name: 'login' });
}

// Phase 2 will replace this stub with real getMenuItems / listLayers data.
const layers = ref([
  { key: 'general', name: 'General Service', svc: 84, color: 'var(--sw-accent)' },
  { key: 'mesh', name: 'Service Mesh', svc: 22, color: 'var(--sw-info)' },
  { key: 'k8s', name: 'Kubernetes', svc: 62, color: 'var(--sw-purple)' },
  { key: 'rum', name: 'Browser (RUM)', svc: 8, color: 'var(--sw-cyan)' },
  { key: 'mq', name: 'Virtual MQ', svc: 6, color: 'var(--sw-ok)' },
  { key: 'db', name: 'Virtual Database', svc: 6, color: 'var(--sw-warn)' },
  { key: 'otel', name: 'OpenTelemetry', svc: 18, color: 'var(--sw-purple)' },
  { key: 'faas', name: 'FaaS', svc: 3, color: 'var(--sw-err)' },
]);
const expandedLayer = ref<string | null>('general');

const route = useRoute();
function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(path + '/');
}

interface NavRow {
  icon: IconName;
  label: string;
  to: string;
  badge?: { text: string; kind?: 'ok' | 'warn' | 'err' | 'info' };
}

const telemetry: NavRow[] = [
  { icon: 'metric', label: 'Dashboards', to: '/dashboards' },
  { icon: 'trace', label: 'Traces', to: '/operate/traces' },
  { icon: 'log', label: 'Logs', to: '/operate/logs' },
  { icon: 'prof', label: 'Profiling', to: '/profiling' },
  { icon: 'event', label: 'Events', to: '/operate/events' },
];
const operate: NavRow[] = [
  { icon: 'alert', label: 'Alarms', to: '/operate/alarms', badge: { text: '7', kind: 'err' } },
];
const admin: NavRow[] = [
  { icon: 'svc', label: 'Cluster status', to: '/cluster' },
  { icon: 'user', label: 'Users', to: '/admin/users' },
  { icon: 'set', label: 'Roles', to: '/admin/roles' },
  { icon: 'log', label: 'Audit log', to: '/admin/audit' },
];
</script>

<template>
  <aside class="sw-side">
    <RouterLink to="/" class="sw-brand" aria-label="SkyWalking Horizon">
      <span class="brand-logo" v-html="logoSw" />
      <small>Horizon</small>
    </RouterLink>

    <nav class="sw-nav">
      <div class="sw-nav-section sw-row" style="justify-content: space-between">
        <span>Layers</span>
        <span style="color: var(--sw-fg-3); font-weight: 400">{{ layers.length }} layers</span>
      </div>
      <template v-for="L in layers" :key="L.key">
        <div
          class="sw-nav-item"
          :class="{ 'is-active': expandedLayer === L.key }"
          @click="expandedLayer = expandedLayer === L.key ? null : L.key"
        >
          <span class="layer-dot" :style="{ background: L.color }" />
          <span :style="{ fontWeight: expandedLayer === L.key ? 600 : 500 }">{{ L.name }}</span>
          <span class="sw-badge" style="margin-left: auto">{{ L.svc }}</span>
          <span class="caret" :class="{ open: expandedLayer === L.key }"><Icon name="caret" :size="10" /></span>
        </div>
        <div v-if="expandedLayer === L.key" class="layer-children">
          <RouterLink :to="`/layer/${L.key}`" class="sw-nav-item" :class="{ 'is-active': isActive(`/layer/${L.key}`) }">
            <Icon name="dash" /><span>Layer overview</span>
          </RouterLink>
          <RouterLink :to="`/layer/${L.key}/services`" class="sw-nav-item" :class="{ 'is-active': isActive(`/layer/${L.key}/services`) }">
            <Icon name="svc" /><span>Services</span><span class="sw-badge" style="margin-left: auto">{{ L.svc }}</span>
          </RouterLink>
          <RouterLink :to="`/layer/${L.key}/instances`" class="sw-nav-item" :class="{ 'is-active': isActive(`/layer/${L.key}/instances`) }">
            <Icon name="prof" /><span>Instances</span>
          </RouterLink>
          <RouterLink :to="`/layer/${L.key}/endpoints`" class="sw-nav-item" :class="{ 'is-active': isActive(`/layer/${L.key}/endpoints`) }">
            <Icon name="ep" /><span>Endpoints</span>
          </RouterLink>
          <RouterLink :to="`/layer/${L.key}/topology`" class="sw-nav-item" :class="{ 'is-active': isActive(`/layer/${L.key}/topology`) }">
            <Icon name="topo" /><span>Topology</span>
          </RouterLink>
        </div>
      </template>

      <div class="sw-nav-section">Telemetry</div>
      <RouterLink v-for="row in telemetry" :key="row.to" :to="row.to" class="sw-nav-item" :class="{ 'is-active': isActive(row.to) }">
        <Icon :name="row.icon" /><span>{{ row.label }}</span>
        <span v-if="row.badge" class="sw-badge" :class="row.badge.kind" style="margin-left: auto">{{ row.badge.text }}</span>
      </RouterLink>

      <div class="sw-nav-section">Operate</div>
      <RouterLink v-for="row in operate" :key="row.to" :to="row.to" class="sw-nav-item" :class="{ 'is-active': isActive(row.to) }">
        <Icon :name="row.icon" /><span>{{ row.label }}</span>
        <span v-if="row.badge" class="sw-badge" :class="row.badge.kind" style="margin-left: auto">{{ row.badge.text }}</span>
      </RouterLink>

      <div class="sw-nav-section">Admin</div>
      <RouterLink v-for="row in admin" :key="row.to" :to="row.to" class="sw-nav-item" :class="{ 'is-active': isActive(row.to) }">
        <Icon :name="row.icon" /><span>{{ row.label }}</span>
      </RouterLink>
    </nav>

    <div class="sw-side-foot">
      <div class="sw-avatar">
        {{ auth.user?.username ? auth.user.username.slice(0, 2).toUpperCase() : '?' }}
      </div>
      <div style="line-height: 1.2; flex: 1; min-width: 0; overflow: hidden">
        <div style="color: var(--sw-fg-0); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
          {{ auth.user?.username ?? 'guest' }}
        </div>
        <div>{{ auth.user?.roles?.join(' · ') ?? 'not signed in' }}</div>
      </div>
      <button v-if="auth.isAuthenticated" class="sw-btn is-icon" title="Sign out" @click="signOut">
        <Icon name="share" :size="12" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sw-brand,
.sw-brand:hover {
  text-decoration: none;
  color: inherit;
}
.brand-logo {
  display: inline-flex;
  align-items: center;
  color: var(--sw-fg-0);
}
.brand-logo :deep(svg) {
  height: 16px;
  width: auto;
  display: block;
}
.sw-brand small {
  font-weight: 500;
  color: var(--sw-fg-2);
  margin-left: 2px;
  letter-spacing: 0.02em;
}
.layer-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
}
.caret {
  color: var(--sw-fg-3);
  margin-left: 4px;
  transition: transform 0.15s;
  display: inline-flex;
  width: 10px;
  transform: rotate(-90deg);
}
.caret.open {
  transform: rotate(0);
}
.layer-children {
  padding-left: 12px;
  margin-left: 18px;
  margin-bottom: 4px;
  border-left: 1px dashed var(--sw-line-2);
}
.layer-children .sw-nav-item {
  text-decoration: none;
}
.sw-nav-item {
  text-decoration: none;
}
</style>
