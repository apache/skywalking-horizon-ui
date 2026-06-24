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
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { ListRow } from '@skywalking-horizon-ui/api-client';
import Pill from '@/components/primitives/Pill.vue';
import StatusDot from '@/components/primitives/StatusDot.vue';
import { overrideKind, formatRelativeTime } from './grouping.js';

const props = defineProps<{ rule: ListRow }>();

const router = useRouter();
const { t } = useI18n();

/** Translate the status enum for display. The wire value stays the
 *  ACTIVE/INACTIVE/BUNDLED/n/a token; only the operator-facing label
 *  swaps with the locale. */
/** Status token → localized label. A keyed record (vs a switch)
 *  returns a value directly — no dead fallback branch to satisfy the
 *  computed-must-return lint — while TS still enforces that every
 *  member of the status union has an entry (a drift errors here). */
const statusLabel = computed<string>(() => ({
  ACTIVE: t('active'),
  INACTIVE: t('inactive'),
  BUNDLED: t('bundled'),
  'n/a': t('n/a'),
}[props.rule.status]));

const statusTone = computed(() => {
  switch (props.rule.status) {
    case 'ACTIVE':
      return 'ok' as const;
    case 'INACTIVE':
      return 'warn' as const;
    case 'BUNDLED':
      return 'dim' as const;
    case 'n/a':
      return 'err' as const;
  }
  return 'dim' as const;
});

const isSuspended = computed(() => props.rule.localState === 'SUSPENDED');

const override = computed(() => overrideKind(props.rule));

/** ACTIVE/INACTIVE rows carry updateTime + lastApplyError; bundled /
 *  orphan rows don't. The discriminated union lets us narrow safely. */
const updateLabel = computed(() => {
  if (props.rule.status === 'ACTIVE' || props.rule.status === 'INACTIVE') {
    return formatRelativeTime(props.rule.updateTime);
  }
  return null;
});

const errorMessage = computed(() => {
  if (props.rule.status === 'ACTIVE' || props.rule.status === 'INACTIVE') {
    return props.rule.lastApplyError || null;
  }
  return null;
});

const hashShort = computed(() => props.rule.contentHash.slice(0, 7) || '—');

function open(): void {
  void router.push({
    name: 'edit',
    query: { catalog: props.rule.catalog, name: props.rule.name },
  });
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    open();
  }
}

/** Live debugger jump target. MAL goes to `/debug/mal?catalog=&name=`
 *  — the MAL view then loads the file content, parses
 *  `metricsRules[].name`, and surfaces a metric picker inside (the
 *  OAP install needs `(name=<file>, ruleName=<metric>)` granularity).
 *  LAL goes to `/operate/live-debug/lal?name=<rule>` — LAL rules are
 *  file-grained on the catalog side already, so the picker is
 *  single-step. OAL catalog isn't writable; rule cards aren't shown
 *  for it. */
const debugTarget = computed(() => {
  if (props.rule.catalog === 'lal') {
    return { path: '/operate/live-debug/lal', query: { name: props.rule.name } };
  }
  return {
    path: '/operate/live-debug/mal',
    query: { catalog: props.rule.catalog, name: props.rule.name },
  };
});

function jumpToDebug(ev: MouseEvent): void {
  ev.stopPropagation();
  void router.push(debugTarget.value);
}
</script>

<template>
  <!-- Outer is a div (not <button>) so the inner ▶ button can nest
       without invalid markup. Keyboard support preserved via
       role+tabindex+keydown. -->
  <button
    type="button"
    class="card"
    :class="{ 'card--suspended': isSuspended, 'card--orphan': rule.status === 'n/a' }"
    :data-testid="`rule-card-${rule.name}`"
    @click="open"
    @keydown="onKey"
  >
    <div class="card__head">
      <button
        type="button"
        class="card__dbgbtn"
        :title="t('Live debug {catalog} · {name}', { catalog: rule.catalog, name: rule.name })"
        :aria-label="t('Live debug {name}', { name: rule.name })"
        @click="jumpToDebug"
      >▶</button>
      <div class="card__name" :title="rule.name">{{ rule.name }}</div>
    </div>

    <!-- Bottom row: hash/updated at the left, every status pill (BUNDLED /
         modified / override / applying) grouped in the bottom-right corner
         so the name above gets the full card width. -->
    <div class="card__foot">
      <span class="card__meta">
        <span class="card__hash">{{ hashShort }}</span>
        <span v-if="updateLabel" class="card__updated">· {{ updateLabel }}</span>
      </span>
      <span class="card__badges">
        <Pill v-if="override === 'modified'" tone="warn">{{ t('modified') }}</Pill>
        <Pill v-else-if="override === 'override'" tone="info">{{ t('override') }}</Pill>
        <span v-if="isSuspended" class="card__suspending">
          <StatusDot tone="warn" :size="6" />
          {{ t('applying…') }}
        </span>
        <Pill class="card__status" :tone="statusTone">{{ statusLabel }}</Pill>
      </span>
    </div>

    <p v-if="errorMessage" class="card__error" :title="errorMessage">
      {{ errorMessage }}
    </p>
  </button>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: 240px;
  text-align: left;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-md);
  padding: 10px 12px;
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition: border-color 0.08s ease, background 0.08s ease;
}

.card:hover {
  background: var(--rr-bg3);
  border-color: var(--rr-active);
}

.card:focus-visible {
  outline: 1px solid var(--rr-active);
  outline-offset: -1px;
  border-color: var(--rr-active);
}

.card--orphan {
  border-style: dashed;
  border-color: color-mix(in oklch, var(--rr-err) 50%, var(--rr-border));
}

.card--suspended {
  animation: cardpulse 2s ease-in-out infinite;
}

@keyframes cardpulse {
  0%,
  100% {
    border-color: var(--rr-warn);
  }
  50% {
    border-color: color-mix(in oklch, var(--rr-warn) 30%, var(--rr-border));
  }
}

.card__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 18px;
}

/* margin-top: auto pins the foot to the card's bottom, so the badges line
 * up across a stretched grid row no matter how many lines the name took. */
.card__foot {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-top: auto;
}

.card__badges {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  justify-content: flex-end;
}

.card__name {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-md);
  color: var(--rr-heading);
  font-weight: var(--sw-fw-medium);
  /* Show the full rule name, wrapping onto a second line (clamped at two
   * so an extreme path can't blow the card height). The status pills moved
   * to the foot, so the name now gets the full card width. */
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.card__status {
  flex-shrink: 0;
}

.card__suspending {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-warn);
  letter-spacing: var(--sw-ls-caps);
}

.card__meta {
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-shrink: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
}

.card__hash {
  letter-spacing: 0.4px;
}

.card__error {
  margin: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-err);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* IDE-style "run" arrow on the left of every rule name. Sits in the
   gutter so the rule name's left edge stays aligned across cards. */
.card__dbgbtn {
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
  color: var(--rr-dim);
  font-family: inherit;
  font-size: var(--sw-fs-sm);
  line-height: var(--sw-lh-tight);
  width: 16px;
  flex-shrink: 0;
  cursor: pointer;
  transition: color 80ms;
  user-select: none;
}

.card:hover .card__dbgbtn {
  color: var(--rr-ok);
}

.card__dbgbtn:hover,
.card__dbgbtn:focus-visible {
  color: var(--rr-active);
  outline: none;
}
</style>
