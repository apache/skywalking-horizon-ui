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
import { computed } from 'vue';
import { useRoute } from 'vue-router';

interface NavLink {
  label: string;
  to?: string;
  active?: (path: string) => boolean;
  hint?: string;
  disabled?: boolean;
}

interface NavSection {
  kicker: string;
  links: NavLink[];
}

const route = useRoute();
const path = computed(() => route.fullPath);

const sections: NavSection[] = [
  {
    kicker: 'cluster',
    links: [
      {
        label: 'Cluster status',
        to: '/cluster',
        active: (p) => p.startsWith('/cluster'),
      },
    ],
  },
  {
    kicker: 'DSL management',
    links: [
      {
        label: 'MAL · OTEL',
        to: '/catalog/otel-rules',
        active: (p) => p.startsWith('/catalog/otel-rules'),
      },
      {
        label: 'MAL · Telegraf',
        to: '/catalog/telegraf-rules',
        active: (p) => p.startsWith('/catalog/telegraf-rules'),
      },
      {
        label: 'LAL',
        to: '/catalog/lal',
        active: (p) => p.startsWith('/catalog/lal'),
      },
      /* `log-mal-rules` is MAL applied to LAL-derived logs — placed
       * below LAL so the data-flow direction (LAL → MAL) reads
       * naturally as the eye scans the sidebar. */
      {
        label: 'LAL → MAL',
        to: '/catalog/log-mal-rules',
        active: (p) => p.startsWith('/catalog/log-mal-rules'),
      },
      {
        label: 'OAL · read-only',
        to: '/oal',
        active: (p) => p.startsWith('/oal'),
      },
    ],
  },
  {
    kicker: 'inspect',
    links: [
      {
        label: 'Inspect',
        to: '/inspect',
        active: (p) => p.startsWith('/inspect'),
      },
    ],
  },
  {
    kicker: 'live debugger',
    links: [
      {
        label: 'Live debugger',
        to: '/debug',
        /* Match /debug and /debug/{tab} but NOT /debug/history — the
         * history page is its own peer entry below. */
        active: (p) => p === '/debug' || /^\/debug\/(mal|lal|oal)/.test(p),
      },
      {
        label: 'Capture history',
        to: '/debug/history',
        active: (p) => p.startsWith('/debug/history'),
      },
    ],
  },
  {
    kicker: 'dump',
    links: [
      {
        label: 'Dump & restore',
        to: '/dump',
        active: (p) => p.startsWith('/dump'),
      },
    ],
  },
  {
    kicker: 'account',
    links: [
      {
        label: 'Permissions',
        to: '/dsl',
        active: (p) => p.startsWith('/dsl'),
      },
    ],
  },
];

function isActive(link: NavLink): boolean {
  if (!link.active) return false;
  return link.active(path.value);
}
</script>

<template>
  <nav class="catalognav">
    <section v-for="(section, idx) in sections" :key="idx" class="catalognav__section">
      <div class="catalognav__kicker">{{ section.kicker }}</div>
      <ul class="catalognav__links">
        <li v-for="link in section.links" :key="link.label" class="catalognav__item">
          <router-link
            v-if="link.to && !link.disabled"
            :to="link.to"
            class="catalognav__link"
            :class="{ 'catalognav__link--active': isActive(link) }"
          >
            <span class="catalognav__label">{{ link.label }}</span>
          </router-link>
          <span
            v-else
            class="catalognav__link catalognav__link--disabled"
            :title="link.hint ?? 'coming later'"
          >
            <span class="catalognav__label">{{ link.label }}</span>
            <span v-if="link.hint" class="catalognav__hint">{{ link.hint }}</span>
          </span>
        </li>
      </ul>
    </section>
  </nav>
</template>

<style scoped>
.catalognav {
  padding: 14px 0;
  font-family: var(--rr-font-mono);
  font-size: 12.5px;
}

.catalognav__section {
  margin-bottom: 16px;
}

.catalognav__kicker {
  padding: 0 16px 6px;
  font-size: 11.5px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--rr-dim);
}

.catalognav__links {
  list-style: none;
  margin: 0;
  padding: 0;
}

.catalognav__item {
  margin: 0;
}

.catalognav__link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px;
  color: var(--rr-ink2);
  text-decoration: none;
  border-left: 2px solid transparent;
}

.catalognav__link:hover {
  background: var(--rr-bg2);
  color: var(--rr-heading);
  text-decoration: none;
}

.catalognav__link--active {
  background: var(--rr-bg3);
  color: var(--rr-heading);
  border-left-color: var(--rr-active);
}

.catalognav__link--disabled {
  color: var(--rr-dim);
  cursor: not-allowed;
}
.catalognav__link--disabled:hover {
  background: transparent;
  color: var(--rr-dim);
}

.catalognav__hint {
  font-size: 11.5px;
  color: var(--rr-dim);
  font-style: italic;
}
</style>
