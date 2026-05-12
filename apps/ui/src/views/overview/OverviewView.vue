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
import { RouterLink } from 'vue-router';
import { useLayers } from '@/composables/useLayers';
import { useLandingOrder } from '@/composables/useLandingOrder';
import AlarmsPanel from './AlarmsPanel.vue';
import LayerKpiTile from './LayerKpiTile.vue';
import LayerLandingCard from './LayerLandingCard.vue';

const { availableLayers, oapReachable, oapError, isLoading } = useLayers();
const orderedLayers = useLandingOrder(availableLayers);

/* Top 6 only — beyond six the page gets noisy and the user has to
 * scroll past low-priority layers to reach the Alarms / Throughput
 * panels. Operators with >6 reporting layers can re-order via setup
 * to surface the ones that matter on the Overview. */
const topSix = computed(() => orderedLayers.value.slice(0, 6));
/* Featured pair = top-2 by priority. These get the full LayerLandingCard
 * with the topN service table. */
const featured = computed(() => topSix.value.slice(0, 2));
/* The next 4 render as compact LayerKpiTile (KPI + sparkline + inline
 * aggregates, no service table). 4 fits a 2×2 grid neatly. */
const compact = computed(() => topSix.value.slice(2, 6));
const overflow = computed(() => Math.max(0, orderedLayers.value.length - 6));
const empty = computed(() => !isLoading.value && orderedLayers.value.length === 0);
</script>

<template>
  <div class="overview">
    <header class="page-head">
      <div>
        <div class="kicker">Overview</div>
        <h1>Cross-layer landing</h1>
        <p class="lede">
          The top 2 layers (by priority) get full top-N cards; the next 4 render as compact KPI
          tiles. Adjust priority, columns, aggregation, and the throughput metric in
          <RouterLink to="/setup">Overview setup</RouterLink>.
        </p>
      </div>
    </header>

    <div v-if="!oapReachable && !isLoading" class="banner err">
      <strong>OAP unreachable.</strong>
      {{ oapError ?? 'Check that the OAP query host is up and reachable from the BFF.' }}
    </div>

    <div v-if="empty" class="empty">
      <div class="empty-card">
        <h2>No layer is reporting services yet</h2>
        <p>
          Once data starts flowing through OAP, every reporting layer appears here automatically,
          ordered by the priority you assign in
          <RouterLink to="/setup">Overview setup</RouterLink>.
        </p>
        <RouterLink class="sw-btn is-primary" to="/setup">Open Overview setup</RouterLink>
      </div>
    </div>

    <div v-else class="overview-grid">
      <!-- Top 2 featured cards: side-by-side, each 2/5 of the page width. -->
      <LayerLandingCard
        v-for="L in featured"
        :key="L.key"
        :layer="L"
        :class="`featured featured-${featured.indexOf(L) + 1}`"
      />

      <!-- Alarms rail: pinned to the right column, rowspans all visible rows. -->
      <AlarmsPanel class="alarms-rail" />

      <!-- Compact tiles: 2x2 grid filling 3/5 of the page width across 2 rows. -->
      <div class="compact-grid">
        <LayerKpiTile v-for="L in compact" :key="L.key" :layer="L" />
      </div>

      <div v-if="overflow > 0" class="overflow-note">
        {{ overflow }} more layer{{ overflow === 1 ? '' : 's' }} not shown.
        <RouterLink to="/setup">Re-order via setup</RouterLink>
        to surface them.
      </div>
    </div>
  </div>
</template>

<style scoped>
.overview {
  padding: 20px 20px 60px;
  max-width: 1440px;
  margin: 0 auto;
}
.page-head {
  margin-bottom: 18px;
}
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 720px;
}
.lede a {
  color: var(--sw-accent-2);
  text-decoration: none;
}
.banner.err {
  margin: 0 0 16px;
  padding: 10px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 12px;
  line-height: 1.5;
}
.empty {
  margin-top: 20px;
}
.empty-card {
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 10px;
  padding: 28px;
  text-align: center;
  max-width: 600px;
  margin: 0 auto;
}
.empty-card h2 {
  font-size: 15px;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.empty-card p {
  font-size: 12px;
  color: var(--sw-fg-2);
  margin: 0 0 16px;
  line-height: 1.5;
}
.empty-card .sw-btn {
  display: inline-flex;
  text-decoration: none;
}
.empty-card a {
  color: var(--sw-accent-2);
  text-decoration: none;
}

/* Layout — 5fr grid:
 *  Row 1: featured-1 (2/5) · featured-2 (2/5) · alarms-rail (1/5)
 *  Row 2: compact-grid (4 tiles, 2x2 — 3/5 wide) ·   alarms-rail (continues, 2/5)
 *
 * The alarms rail widens from 1/5 in row 1 to 2/5 in row 2 — driven by
 * the compact-grid only occupying 3/5 of the row. This matches the
 * "top 2 = 2/5 each, other 4 = 3/5" allocation in the operator brief.
 */
.overview-grid {
  display: grid;
  grid-template-columns: 2fr 2fr 1fr;
  grid-template-rows: auto auto;
  grid-template-areas:
    'feat1 feat2 alarms'
    'compact compact alarms';
  gap: 14px;
  align-items: start;
}
.featured-1 {
  grid-area: feat1;
  min-width: 0;
}
.featured-2 {
  grid-area: feat2;
  min-width: 0;
}
.alarms-rail {
  grid-area: alarms;
  min-width: 0;
  align-self: stretch;
}
.compact-grid {
  grid-area: compact;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  min-width: 0;
}
.overflow-note {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--sw-fg-3);
  padding: 4px 8px;
}
.overflow-note a {
  color: var(--sw-accent-2);
  text-decoration: none;
}

/* Below ~1100px the rail crowds the featured cards — fall back to a
 * single column. The Alarms panel still has utility at narrow widths. */
@media (max-width: 1100px) {
  .overview-grid {
    grid-template-columns: 1fr 1fr;
    grid-template-areas:
      'feat1 feat2'
      'compact compact'
      'alarms alarms';
  }
  .compact-grid {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 720px) {
  .overview-grid {
    grid-template-columns: 1fr;
    grid-template-areas:
      'feat1'
      'feat2'
      'compact'
      'alarms';
  }
  .compact-grid {
    grid-template-columns: 1fr;
  }
}
</style>
