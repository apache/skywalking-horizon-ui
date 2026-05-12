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
  Active-alarms panel on the Overview. Phase 5 wires this to OAP's
  `getAlarm` GraphQL query; for now it renders a structural placeholder
  so the Overview layout matches the design spec ahead of the data
  plumbing.

  Alarms are read-only per the project's operator-model decision —
  recovery is OAP-side automatic, no acknowledge / close / silence here.
-->
<script setup lang="ts">
import { RouterLink } from 'vue-router';
import Icon from '@/components/icons/Icon.vue';

// Static seed rows from the design prototype — visually communicates
// the panel's shape until the Phase 5 OAP query is wired in. Kept
// internal so removing them later is a one-file change.
const placeholderRows = [
  { sev: 'err', rule: 'Service SLA below 98%', scope: '— · awaiting OAP getAlarm', since: '—' },
  { sev: 'warn', rule: 'JVM Old GC > 5s/min', scope: '— · awaiting OAP getAlarm', since: '—' },
  { sev: 'info', rule: 'Deployment detected', scope: '— · awaiting OAP getAlarm', since: '—' },
];
</script>

<template>
  <section class="sw-card alarms-panel">
    <header class="head">
      <h4>Active alarms</h4>
      <span class="sw-badge">Phase 5</span>
      <RouterLink class="all-link" to="/alarms">
        <span>View all</span>
        <Icon name="chev" :size="10" />
      </RouterLink>
    </header>
    <div class="body">
      <p class="lede">
        Read-only — alarms recover backend-side. This panel will surface live entries from
        <code>getAlarm</code> once Phase 5 lands. The layout below is a placeholder.
      </p>
      <div class="rows">
        <div v-for="(a, i) in placeholderRows" :key="i" class="alarm-row">
          <span class="sw-badge dot" :class="a.sev">{{ a.sev }}</span>
          <div class="alarm-text">
            <div class="rule">{{ a.rule }}</div>
            <div class="scope">{{ a.scope }}</div>
          </div>
          <span class="since">{{ a.since }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.alarms-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--sw-line);
}
.head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
  letter-spacing: -0.01em;
}
.all-link {
  margin-left: auto;
  font-size: 11px;
  color: var(--sw-fg-2);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.all-link:hover {
  color: var(--sw-accent-2);
}
.body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
}
.lede {
  margin: 0;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  line-height: 1.5;
}
.lede code {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.alarm-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--sw-line);
  font-size: 11px;
}
.alarm-row:first-child {
  border-top: none;
}
.sw-badge.dot::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
  margin-right: 3px;
}
.alarm-text {
  flex: 1;
  min-width: 0;
}
.alarm-text .rule {
  color: var(--sw-fg-1);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.alarm-text .scope {
  font-family: var(--sw-mono);
  color: var(--sw-fg-3);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.since {
  color: var(--sw-fg-3);
  font-size: 10px;
  flex: 0 0 auto;
}
</style>
