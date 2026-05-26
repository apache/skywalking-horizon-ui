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
  Theme preview card — ported from the design bundle's
  `screens/style-setup.jsx > ThemeCard`. Self-themed via inline styles
  that read the ThemeDef's token snapshot (NOT --sw-* vars), so each
  card renders in its OWN theme regardless of the page's active theme.
  That's the whole point of the preview: see the palette before you
  switch.

  Three stacked regions, matching the design:
    1. Hero strip (110px) — gradient + faint grid + mini brand chip
    2. Mini-app preview — Primary/Tonal/Ghost buttons, KPI strip
       (cpm / p99 / err), sparkline, density/font/radius/mode badges
    3. Description block — name + tagline + desc + actions
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ThemeDef } from '@/state/theme';

const { t } = useI18n({ useScope: 'global' });

defineProps<{
  theme: ThemeDef;
  /** This card represents the currently-active theme (drives ribbon +
   *  primary-button label). Distinct from `selected`: a card can be
   *  selected (radio state) without yet being applied. */
  active: boolean;
  /** Hovered/clicked but not yet committed via Save. */
  selected: boolean;
}>();

defineEmits<{ pick: [] }>();

function tagBadgeStyle(t: ThemeDef): Record<string, string> {
  return {
    background: t.bg0 + 'cc',
    color: t.fg1,
    border: `1px solid ${t.line}`,
  };
}
function chipStyle(t: ThemeDef, kind: 'primary' | 'tonal' | 'ghost'): Record<string, string> {
  if (kind === 'primary') {
    return {
      background: t.accent,
      color: t.appearance === 'light' ? '#fff' : '#0a0d12',
      borderRadius: `${t.radius}px`,
    };
  }
  if (kind === 'tonal') {
    return {
      background: t.accentSoft,
      color: t.accent,
      border: `1px solid ${t.accentLine}`,
      borderRadius: `${t.radius}px`,
    };
  }
  return {
    background: t.bg2,
    color: t.fg1,
    border: `1px solid ${t.line}`,
    borderRadius: `${t.radius}px`,
  };
}
function kpiTileStyle(t: ThemeDef): Record<string, string> {
  return {
    background: t.bg2,
    border: `1px solid ${t.line}`,
    borderRadius: `${Math.max(2, t.radius - 2)}px`,
  };
}
function metaBadgeStyle(t: ThemeDef): Record<string, string> {
  return {
    background: t.bg2,
    border: `1px solid ${t.line}`,
  };
}
</script>

<template>
  <div
    class="tpc"
    :class="{ 'tpc--selected': selected, 'tpc--active': active }"
    :style="{
      background: theme.bg1,
      color: theme.fg0,
      borderColor: selected || active ? theme.accent : theme.line,
      boxShadow: selected || active
        ? `0 0 0 2px ${theme.accent}55, 0 12px 32px rgba(0,0,0,0.4)`
        : '0 4px 12px rgba(0,0,0,0.25)',
    }"
    @click="$emit('pick')"
  >
    <!-- Top-left badges: tag + 'active' chip when this is the live theme. -->
    <div class="tpc__badges">
      <span class="tpc__tag" :style="tagBadgeStyle(theme)">{{ theme.tag }}</span>
      <span
        v-if="active"
        class="tpc__active"
        :style="{ background: theme.accent, color: '#0a0d12' }"
      >{{ t('active') }}</span>
    </div>

    <!-- Hero strip — theme-specific gradient + faint grid + brand chip. -->
    <div class="tpc__hero" :style="{ background: theme.heroTint }">
      <div
        class="tpc__hero-grid"
        :style="{
          opacity: theme.appearance === 'light' ? 0.06 : 0.12,
          backgroundImage:
            `linear-gradient(${theme.line} 1px, transparent 1px), ` +
            `linear-gradient(90deg, ${theme.line} 1px, transparent 1px)`,
        }"
      />
      <div
        class="tpc__brand"
        :style="{ color: theme.appearance === 'light' ? '#1a1d24' : '#fff' }"
      >
        <span
          class="tpc__brand-sigil"
          :style="{ background: `linear-gradient(135deg, ${theme.accent}, ${theme.purple})` }"
        />
        SkyWalking · {{ theme.label }}
      </div>
    </div>

    <!-- Mini-app preview. -->
    <div class="tpc__body" :style="{ background: theme.bg0, color: theme.fg1, fontFamily: theme.font }">
      <div class="tpc__buttons">
        <span class="tpc__chip" :style="chipStyle(theme, 'primary')">{{ t('Primary') }}</span>
        <span class="tpc__chip" :style="chipStyle(theme, 'tonal')">{{ t('Tonal') }}</span>
        <span class="tpc__chip" :style="chipStyle(theme, 'ghost')">{{ t('Ghost') }}</span>
      </div>
      <div class="tpc__kpis">
        <div class="tpc__kpi" :style="kpiTileStyle(theme)">
          <div class="tpc__kpi-k" :style="{ color: theme.fg2 }">cpm</div>
          <div class="tpc__kpi-v" :style="{ color: theme.accent }">284k</div>
        </div>
        <div class="tpc__kpi" :style="kpiTileStyle(theme)">
          <div class="tpc__kpi-k" :style="{ color: theme.fg2 }">p99</div>
          <div class="tpc__kpi-v" :style="{ color: theme.warn }">412ms</div>
        </div>
        <div class="tpc__kpi" :style="kpiTileStyle(theme)">
          <div class="tpc__kpi-k" :style="{ color: theme.fg2 }">err</div>
          <div class="tpc__kpi-v" :style="{ color: theme.err }">0.4%</div>
        </div>
      </div>
      <div
        class="tpc__chart"
        :style="{
          background: theme.bg2,
          border: `1px solid ${theme.line}`,
          borderRadius: `${Math.max(2, theme.radius - 2)}px`,
        }"
      >
        <svg viewBox="0 0 100 28" preserveAspectRatio="none">
          <defs>
            <linearGradient :id="`tpc-g-${theme.id}`" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  :stop-color="theme.accent" stop-opacity="0.35" />
              <stop offset="100%" :stop-color="theme.accent" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M0 22 L10 18 L20 14 L30 16 L40 9 L50 13 L60 7 L70 11 L80 6 L90 9 L100 4 L100 28 L0 28 Z"
            :fill="`url(#tpc-g-${theme.id})`"
          />
          <path
            d="M0 22 L10 18 L20 14 L30 16 L40 9 L50 13 L60 7 L70 11 L80 6 L90 9 L100 4"
            fill="none"
            :stroke="theme.accent"
            stroke-width="1.4"
          />
        </svg>
      </div>
      <div class="tpc__meta">
        <span class="tpc__meta-pill" :style="metaBadgeStyle(theme)">
          <span :style="{ color: theme.fg3 }">{{ t('font') }}</span>
          <span :style="{ color: theme.fg1 }">{{ theme.font }}</span>
        </span>
        <span class="tpc__meta-pill" :style="metaBadgeStyle(theme)">
          <span :style="{ color: theme.fg3 }">r</span>
          <span :style="{ color: theme.fg1 }">{{ theme.radius }}px</span>
        </span>
        <span class="tpc__meta-pill" :style="metaBadgeStyle(theme)">
          <span :style="{ color: theme.fg3 }">{{ t('density') }}</span>
          <span :style="{ color: theme.fg1 }">{{ theme.density.toLowerCase() }}</span>
        </span>
        <span class="tpc__meta-pill" :style="metaBadgeStyle(theme)">
          <span :style="{ color: theme.fg3 }">{{ t('mode') }}</span>
          <span :style="{ color: theme.fg1 }">{{ theme.appearance }}</span>
        </span>
      </div>
    </div>

    <!-- Description block. -->
    <div
      class="tpc__desc"
      :style="{
        background: theme.bg1,
        color: theme.fg1,
        borderTop: `1px solid ${theme.line}`,
      }"
    >
      <div class="tpc__name" :style="{ color: theme.fg0, fontFamily: theme.font }">{{ theme.label }}</div>
      <div class="tpc__tagline" :style="{ color: theme.fg2 }">{{ theme.tagline }}</div>
      <div class="tpc__lede" :style="{ color: theme.fg2 }">{{ theme.description }}</div>
      <div class="tpc__cta">
        <span
          class="tpc__use"
          :style="{
            background: active ? theme.bg2 : theme.accent,
            color: active ? theme.fg1 : (theme.appearance === 'light' ? '#fff' : '#0a0d12'),
            border: `1px solid ${active ? theme.line : theme.accent}`,
          }"
        >{{ active ? t('Currently active') : (selected ? t('Selected') : t('Use this theme')) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tpc {
  /* `position: relative` is load-bearing — the absolute-positioned
   * `.tpc__badges` (top:8 left:8 z:2 pill cluster) and the
   * `.tpc__brand` chip inside the hero look up the tree for the
   * nearest positioned ancestor; without this they escape the card
   * entirely and end up floating against `<body>`. */
  position: relative;
  border: 1px solid;
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  transition: transform 0.1s ease, box-shadow 0.1s ease;
}
.tpc:hover { transform: translateY(-1px); }

.tpc__badges {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 6px;
}
.tpc__tag, .tpc__active {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 700;
  backdrop-filter: blur(6px);
}

.tpc__hero {
  position: relative;
  height: 110px;
}
.tpc__hero-grid {
  position: absolute;
  inset: 0;
  background-size: 56px 56px, 56px 56px;
  background-position: 0 0, 0 0;
  pointer-events: none;
}
.tpc__brand {
  position: absolute;
  bottom: 10px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: -0.2px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}
.tpc__brand-sigil {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: inline-block;
}

.tpc__body { padding: 10px; }
.tpc__buttons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.tpc__chip {
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 700;
  font-family: inherit;
}
.tpc__kpis {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 5px;
}
.tpc__kpi { padding: 5px 6px; }
.tpc__kpi-k {
  font-size: 8px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 600;
}
.tpc__kpi-v {
  font-size: 12px;
  font-weight: 700;
  font-family: ui-monospace, monospace;
}
.tpc__chart {
  margin-top: 8px;
  height: 36px;
  padding: 4px;
}
.tpc__chart svg {
  width: 100%;
  height: 100%;
}
.tpc__meta {
  margin-top: 8px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  font-size: 9px;
}
.tpc__meta-pill {
  padding: 1px 6px;
  border-radius: 999px;
  display: inline-flex;
  gap: 4px;
}

.tpc__desc {
  padding: 8px 10px 10px;
  margin-top: auto;
}
.tpc__name {
  font-size: 13px;
  font-weight: 700;
}
.tpc__tagline {
  font-size: 10px;
  margin-top: 2px;
}
.tpc__lede {
  font-size: 10.5px;
  line-height: 1.5;
  margin-top: 6px;
}
.tpc__cta {
  margin-top: 8px;
}
.tpc__use {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
}
</style>
