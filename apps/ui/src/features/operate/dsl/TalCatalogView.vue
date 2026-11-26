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
/**
 * TAL rules, read-only: the files a node loaded with their rules, and each
 * file's YAML with a ▶ on every rule a debug session can install on, which
 * opens the live debugger with the rule picked.
 *
 * TAL rules load once, at boot, from `talFiles` (OTLP spans) and
 * `nativeTalFiles` (SkyWalking native segments, run in their listed order);
 * the runtime-rule API does not manage them.
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type { TalFileListing, TalRuleListing } from '@skywalking-horizon-ui/api-client';
import { BffApiError, bff } from '@/api/client';
import Pill from '@/components/primitives/Pill.vue';
import Btn from '@/components/primitives/Btn.vue';
import AdminFeatureWarning from '@/shell/AdminFeatureWarning.vue';
import OapVersionBanner from '@/shell/OapVersionBanner.vue';
import { tokenizeLine } from './syntaxHighlight.js';
import { ruleLines } from './talRuleLines.js';

const { t } = useI18n();
const router = useRouter();

const filesQuery = useQuery({
  queryKey: ['tal/files'],
  queryFn: async () => bff.dsl.talFiles(),
});
const files = computed<TalFileListing[]>(() => filesQuery.data.value?.files ?? []);
const selectedName = ref<string | null>(null);
const selected = computed(() => files.value.find((f) => f.name === selectedName.value) ?? null);

watch(
  files,
  (list) => {
    const held = list.some((f) => f.name === selectedName.value);
    if (!held) selectedName.value = list.length > 0 ? list[0]!.name : null;
  },
  // The listing may come from the cache on mount, with no change to watch.
  { immediate: true },
);
/** OAP answers 404 for the TAL rule listing before 11.2, which added it. */
const notServed = computed(
  () => filesQuery.error.value instanceof BffApiError && filesQuery.error.value.status === 404,
);

const fileQuery = useQuery({
  queryKey: computed(() => ['tal/file', selectedName.value]),
  queryFn: async () => bff.dsl.talFileContent(selectedName.value!),
  enabled: computed(() => selectedName.value !== null),
});

/** Read the listing and the open file again: the rule lines a listing gives are lines of the file as OAP has it
 *  now, so the text they mark is read again with them. */
function refresh(): void {
  void filesQuery.refetch();
  if (selectedName.value !== null) void fileQuery.refetch();
}

const textLines = computed<string[] | null>(() => {
  const text = fileQuery.data.value;
  // A file saved with Windows line endings reads as any other.
  return typeof text === 'string' ? text.replace(/\r?\n$/, '').split(/\r?\n/) : null;
});

/** The rule each declaring line of the text on screen holds (`talRuleLines`), so no ▶ marks a line not its rule's. */
const rulesByLine = computed(() => ruleLines(textLines.value ?? [], selected.value?.rules ?? []));

const fileLines = computed(() =>
  (textLines.value ?? []).map((line, i) => ({
    num: i + 1,
    tokens: tokenizeLine(line, 'tal'),
    rule: rulesByLine.value.get(i + 1) ?? null,
  })),
);

function debugRule(rule: TalRuleListing): void {
  if (!selected.value) return;
  void router.push({
    path: '/operate/live-debug/tal',
    query: { file: selected.value.name, ruleName: rule.name },
  });
}

function listLabel(file: TalFileListing): string {
  return file.inputType === 'sw-native' ? 'native' : 'OTLP';
}
</script>

<template>
  <div class="tal">
    <AdminFeatureWarning module="dsl-debugging" :feature-label="t('Trace Analysis Language')" />
    <header class="tal__header">
      <h1 class="tal__h1">{{ t('Trace Analysis Language') }}</h1>
      <Pill tone="dim">{{ t('read-only') }}</Pill>
      <Btn size="sm" :disabled="filesQuery.isFetching.value" @click="refresh()">
        {{ filesQuery.isFetching.value ? t('refreshing…') : t('refresh') }}
      </Btn>
      <i18n-t
        keypath="TAL rules load at boot from {otlp} (OTLP spans) and {native} (SkyWalking native segments, in their listed order). Each rule with a ▶ can be debugged in the {liveDebugger}."
        tag="span"
        class="tal__hint"
        scope="global"
      >
        <template #otlp><code>talFiles</code></template>
        <template #native><code>nativeTalFiles</code></template>
        <template #liveDebugger>
          <router-link to="/operate/live-debug/tal" class="tal__link">{{ t('Live debugger') }}</router-link>
        </template>
      </i18n-t>
    </header>

    <section class="tal__pane">
      <div v-if="filesQuery.isPending.value" class="tal__msg">{{ t('loading…') }}</div>
      <OapVersionBanner
        v-else-if="notServed"
        :feature-label="t('Trace Analysis Language')"
        min-version="11.2"
        :detail="t('OAP answers 404 for its TAL rule listing, /runtime/tal/files.')"
      />
      <div v-else-if="filesQuery.isError.value" class="tal__msg tal__msg--err">
        {{ t('Could not load TAL files.') }}
        <button type="button" @click="filesQuery.refetch()">{{ t('retry') }}</button>
      </div>
      <div v-else-if="files.length === 0" class="tal__msg">{{ t('no TAL files loaded') }}</div>
      <div v-else class="tal__split">
        <ul class="tal__files">
          <li v-for="f in files" :key="f.name">
            <button
              type="button"
              class="tal__file"
              :class="{ 'tal__file--active': selectedName === f.name }"
              @click="selectedName = f.name"
            >
              <code>{{ f.name }}</code>
              <span class="tal__fmeta">{{ listLabel(f) }} · {{ t('{n} rules', { n: f.rules.length }) }}</span>
            </button>
          </li>
        </ul>

        <div class="tal__detail">
          <header v-if="selected" class="tal__dhead">
            <code>{{ selected.name }}</code>
            <span class="tal__fmeta">{{ selected.list }} · {{ selected.inputType }}</span>
            <span v-for="r in selected.rules" :key="`${r.layer}/${r.name}`" class="tal__rulechip" :class="{ 'tal__rulechip--off': !r.debuggable }">
              {{ r.name }} · {{ r.layer }}
            </span>
          </header>
          <div v-if="fileQuery.isPending.value" class="tal__msg">{{ t('loading…') }}</div>
          <div v-else-if="fileQuery.isError.value || fileQuery.data.value === null" class="tal__msg tal__msg--err">
            {{ t('file not found') }}
          </div>
          <pre v-else class="tal__pre"><span v-for="line in fileLines" :key="line.num" class="tal__line"><button
              v-if="line.rule && line.rule.debuggable"
              type="button"
              class="tal__dbg"
              :title="t('Live debug: {rule}', { rule: line.rule.name })"
              @click="debugRule(line.rule)"
            >▶</button><span
              v-else
              class="tal__dbgslot"
              :title="line.rule ? t('This node cannot debug this rule: it runs without the probes, or another rule of the file has its name.') : undefined"
            >{{ line.rule ? '·' : '' }}</span><span class="tal__num">{{ line.num }}</span><span><span
              v-for="(tok, ti) in line.tokens"
              :key="ti"
              :class="`hl hl--${tok.kind}`"
            >{{ tok.text }}</span></span></span></pre>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tal {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 24px;
  color: var(--rr-ink);
  height: calc(100vh - 16px);
  min-height: 0;
}

.tal__header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.tal__h1 {
  font-size: var(--sw-fs-md);
  font-weight: var(--sw-fw-semibold);
  margin: 0;
  color: var(--rr-heading);
}

.tal__hint {
  flex-basis: 100%;
  font-size: var(--sw-fs-base);
  color: var(--rr-dim);
  line-height: 1.5;
}

.tal__hint code {
  font-family: var(--rr-font-mono);
  color: var(--rr-ink2);
}

.tal__link {
  color: var(--rr-active);
  text-decoration: underline;
}

.tal__pane {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
}

.tal__msg {
  padding: 14px;
  color: var(--rr-dim);
}

.tal__msg--err {
  color: var(--rr-err);
}

.tal__split {
  display: grid;
  grid-template-columns: 280px 1fr;
  flex: 1 1 auto;
  min-height: 0;
}

.tal__files {
  list-style: none;
  margin: 0;
  padding: 0;
  border-right: 1px solid var(--rr-border);
  overflow-y: auto;
}

.tal__file {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  text-align: left;
  cursor: pointer;
  color: var(--rr-ink);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
}

.tal__file:hover,
.tal__file--active {
  background: var(--rr-bg3);
}

.tal__file--active {
  border-left-color: var(--rr-active);
}

.tal__fmeta {
  font-size: var(--sw-fs-sm);
  color: var(--rr-dim);
}

.tal__detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.tal__dhead {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--rr-border);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-heading);
}

.tal__rulechip {
  padding: 0 6px;
  border: 1px solid var(--rr-border2);
  border-radius: var(--rr-radius-sm);
  color: var(--rr-ink2);
}

.tal__rulechip--off {
  color: var(--rr-dim);
  border-style: dashed;
}

.tal__pre {
  margin: 0;
  overflow: auto;
  flex: 1 1 auto;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-ink2);
  display: flex;
  flex-direction: column;
}

.tal__line {
  display: flex;
  align-items: baseline;
  min-height: 1.5em;
  white-space: pre;
}

.tal__dbgslot,
.tal__dbg {
  display: inline-flex;
  justify-content: center;
  width: 18px;
  flex-shrink: 0;
  color: var(--rr-dim);
}

.tal__dbg {
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--rr-ok);
  cursor: pointer;
}

.tal__num {
  width: 44px;
  padding-right: 10px;
  text-align: right;
  color: var(--rr-dim);
  flex-shrink: 0;
  user-select: none;
}

.hl--comment {
  color: var(--rr-dim);
  font-style: italic;
}

.hl--string {
  color: var(--rr-ok);
}

.hl--keyword {
  color: var(--rr-accent);
  font-weight: var(--sw-fw-semibold);
}

.hl--fn,
.hl--number {
  color: var(--rr-info);
}

.hl--type {
  color: var(--sw-purple);
}
</style>
