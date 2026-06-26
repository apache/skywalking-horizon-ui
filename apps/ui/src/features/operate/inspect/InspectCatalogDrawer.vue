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
 * Inspect — the slide-in catalog drawer. Two tabs:
 *   - "from catalog": browse /inspect/metrics grouped by source + file,
 *     filter by regex / scope, check the MQE-queryable metrics to add.
 *   - "foreign metric": stage metrics this OAP doesn't define (another OAP
 *     wrote them to shared storage); supply value column + type by hand.
 *
 * Owns all drawer-local browse / filter / form / staging state. Commits flow
 * back to the board view by name (catalog) or spec (foreign); the parent owns
 * widget creation + entity resolution.
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  INSPECT_FOREIGN_VALUE_TYPES,
  type InspectForeignValueType,
  type InspectScope,
} from '@skywalking-horizon-ui/api-client';
import type { InspectCatalogEntry } from '@/api/client';
import Btn from '@/components/primitives/Btn.vue';
import Pill from '@/components/primitives/Pill.vue';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import {
  FOREIGN_SCOPES,
  INSPECT_SOURCES,
  scopeShort,
  type ForeignForm,
  type Source,
} from './inspectTypes';

const props = defineProps<{
  catalog: InspectCatalogEntry[];
  widgetCount: number;
  boardCap: number;
  /** Names already on the board — used to dedupe staged foreign metrics. */
  existingNames: Set<string>;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'commit-catalog', names: string[]): void;
  (e: 'commit-foreign', specs: ForeignForm[]): void;
}>();

const { t } = useI18n({ useScope: 'global' });

useEscapeToClose(
  () => true,
  () => emit('close'),
);

interface FileNode {
  source: Source;
  file: string;
  scopes: InspectScope[];
  metricCount: number;
}

const selection = ref<Set<string>>(new Set());
const query = ref('');
const sourceFilter = ref<Set<Source>>(new Set<Source>(INSPECT_SOURCES));
const activeFile = ref<string | null>(null);
const scopeNarrow = ref<InspectScope | null>(null);

function emptyForeignForm(): ForeignForm {
  return { name: '', scope: 'Service', valueColumn: 'value', valueType: 'LONG' };
}
const foreignForm = ref<ForeignForm>(emptyForeignForm());
const foreignErr = ref('');
/** Foreign metrics staged for bulk add (committed via the drawer footer). */
const foreignStaged = ref<ForeignForm[]>([]);
/** Which drawer tab is active — catalog browse vs foreign-metric entry. */
const drawerTab = ref<'catalog' | 'foreign'>('catalog');

/** Items pending add for the active tab — catalog checkboxes or staged
 *  foreign metrics. Drives the shared footer count + commit. */
const drawerPending = computed(() =>
  drawerTab.value === 'catalog' ? selection.value.size : foreignStaged.value.length,
);
/** How many of the pending items actually fit under the board cap. */
const drawerAddCount = computed(() =>
  Math.min(drawerPending.value, Math.max(0, props.boardCap - props.widgetCount)),
);
function commitDrawerActive(): void {
  if (drawerTab.value === 'catalog') commitDrawer();
  else commitForeign();
}

const drawerRegex = computed(() => {
  if (!query.value) return null;
  try {
    return new RegExp(query.value, 'i');
  } catch {
    return null;
  }
});

const drawerFiles = computed<FileNode[]>(() => {
  const map = new Map<string, FileNode>();
  for (const m of props.catalog) {
    const src = m.attribution.source as Source;
    if (!sourceFilter.value.has(src)) continue;
    /* Group key uses `source::file`. Metrics with `file === null`
     * (orphans / 'unknown' source) get bucketed under a synthetic
     * "(unattributed)" file so the operator can still find them. */
    const fileKey = m.attribution.file ?? '(unattributed)';
    const key = `${src}::${fileKey}`;
    let node = map.get(key);
    if (!node) {
      node = { source: src, file: fileKey, scopes: [], metricCount: 0 };
      map.set(key, node);
    }
    if (!node.scopes.includes(m.scope)) node.scopes.push(m.scope);
    node.metricCount += 1;
  }
  return [...map.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.file.localeCompare(b.file);
  });
});

const drawerGroupedFiles = computed<Record<Source, FileNode[]>>(() => {
  const groups: Record<Source, FileNode[]> = {
    OAL: [],
    'MAL·OTEL': [],
    'MAL·Telegraf': [],
    'LAL→MAL': [],
    unknown: [],
  };
  for (const f of drawerFiles.value) groups[f.source].push(f);
  return groups;
});

const activeFileNode = computed<FileNode | null>(() =>
  drawerFiles.value.find((f) => `${f.source}::${f.file}` === activeFile.value) ?? null,
);

const drawerMetrics = computed<InspectCatalogEntry[]>(() => {
  if (!activeFile.value) return [];
  const list = props.catalog.filter((m) => {
    const src = m.attribution.source as Source;
    const fileKey = m.attribution.file ?? '(unattributed)';
    if (`${src}::${fileKey}` !== activeFile.value) return false;
    if (scopeNarrow.value && m.scope !== scopeNarrow.value) return false;
    if (drawerRegex.value && !drawerRegex.value.test(m.name)) return false;
    return true;
  });
  // Operator scanning a long list expects alphabetical order — the
  // catalog wire order is registration order, which is ~random to
  // the human eye.
  return list.slice().sort((a, b) => a.name.localeCompare(b.name));
});

function isMqeQueryable(type: string): boolean {
  return type === 'REGULAR_VALUE' || type === 'LABELED_VALUE';
}

onMounted(() => {
  if (!activeFile.value || !drawerFiles.value.some((f) => `${f.source}::${f.file}` === activeFile.value)) {
    const first = drawerFiles.value[0];
    activeFile.value = first ? `${first.source}::${first.file}` : null;
  }
});

function toggleDrawerSource(s: Source) {
  const next = new Set(sourceFilter.value);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  sourceFilter.value = next;
  if (activeFile.value && !drawerFiles.value.some((f) => `${f.source}::${f.file}` === activeFile.value)) {
    const first = drawerFiles.value[0];
    activeFile.value = first ? `${first.source}::${first.file}` : null;
  }
}
function selectFile(node: FileNode) {
  activeFile.value = `${node.source}::${node.file}`;
  scopeNarrow.value = null;
}
function toggleDrawerPick(name: string, queryable: boolean) {
  if (!queryable) return;
  const next = new Set(selection.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selection.value = next;
}
function selectAllVisible() {
  const next = new Set(selection.value);
  for (const m of drawerMetrics.value) {
    if (isMqeQueryable(m.type)) next.add(m.name);
  }
  selection.value = next;
}
function clearVisible() {
  const next = new Set(selection.value);
  for (const m of drawerMetrics.value) next.delete(m.name);
  selection.value = next;
}
function selectAllInFile(node: FileNode) {
  activeFile.value = `${node.source}::${node.file}`;
  scopeNarrow.value = null;
  const next = new Set(selection.value);
  for (const m of props.catalog) {
    const src = m.attribution.source as Source;
    const fileKey = m.attribution.file ?? '(unattributed)';
    if (src === node.source && fileKey === node.file && isMqeQueryable(m.type)) {
      next.add(m.name);
    }
  }
  selection.value = next;
}
function commitDrawer() {
  emit('commit-catalog', [...selection.value]);
}

/** Stage the current foreign-metric form onto the pending list. Operators
 *  batch several foreign metrics, then commit them all at once via the shared
 *  drawer footer (same bulk-add + board-cap model as the catalog tab). */
function stageForeignMetric(): void {
  foreignErr.value = '';
  const f = foreignForm.value;
  const name = f.name.trim();
  if (!name) {
    foreignErr.value = t('metric name is required');
    return;
  }
  if (
    props.existingNames.has(name) ||
    foreignStaged.value.some((s) => s.name === name)
  ) {
    foreignErr.value = t('{metric} is already on the board', { metric: name });
    return;
  }
  foreignStaged.value = [
    ...foreignStaged.value,
    { ...f, name, valueColumn: f.valueColumn.trim() || 'value' },
  ];
  /* Keep scope / valueType for the next add (operators batch similar
   * metrics from the same source); clear only the name. */
  foreignForm.value = { ...f, name: '' };
}

function unstageForeign(name: string): void {
  foreignStaged.value = foreignStaged.value.filter((s) => s.name !== name);
}

function commitForeign(): void {
  emit('commit-foreign', foreignStaged.value.slice());
}
</script>

<template>
  <aside class="drawer" @click.self="emit('close')">
    <div class="drawer__panel">
      <header class="drawer__head">
        <div>
          <div class="drawer__kicker">{{ t('catalog · /inspect/metrics') }}</div>
          <h2 class="drawer__title">{{ t('Add metrics to the board') }}</h2>
        </div>
        <button class="iconbtn iconbtn--x" @click="emit('close')">×</button>
      </header>

      <nav class="drawer__tabs">
        <button
          class="drawer__tab"
          :class="{ 'drawer__tab--on': drawerTab === 'catalog' }"
          @click="drawerTab = 'catalog'"
        >{{ t('from catalog') }}</button>
        <button
          class="drawer__tab"
          :class="{ 'drawer__tab--on': drawerTab === 'foreign' }"
          @click="drawerTab = 'foreign'"
        >{{ t('foreign metric') }}</button>
      </nav>

      <template v-if="drawerTab === 'catalog'">
      <div class="drawer__sources">
        <span class="ins__lbl">{{ t('source') }}</span>
        <button
          v-for="s in (['OAL','MAL·OTEL','MAL·Telegraf','LAL→MAL','unknown'] as Source[])"
          :key="s"
          class="chip"
          :class="{ 'chip--on': sourceFilter.has(s) }"
          @click="toggleDrawerSource(s)"
        >{{ s }}</button>
      </div>

      <div class="drawer__search">
        <input v-model="query" :placeholder="t('regex over metric name')" class="ins__input" spellcheck="false" />
        <span class="drawer__count">{{ t('{n} of {total} match', { n: drawerMetrics.length, total: activeFileNode?.metricCount ?? 0 }) }}</span>
      </div>

      <div class="drawer__panes">
        <nav class="drawer__tree">
          <template v-for="src in (['OAL','MAL·OTEL','MAL·Telegraf','LAL→MAL','unknown'] as Source[])" :key="src">
            <div v-if="drawerGroupedFiles[src].length > 0" class="drawer__treeGroup">
              <div class="drawer__treeKicker">{{ src }}</div>
              <div
                v-for="f in drawerGroupedFiles[src]"
                :key="`${f.source}::${f.file}`"
                class="drawer__file"
                :class="{ 'drawer__file--on': activeFile === `${f.source}::${f.file}` }"
              >
                <button class="drawer__fileBtn" @click="selectFile(f)">
                  <span class="drawer__fileName" :title="f.file">{{ f.file }}</span>
                  <span class="drawer__fileMeta">
                    <span class="drawer__fileCount">{{ f.metricCount }}</span>
                  </span>
                </button>
                <button
                  class="drawer__fileAdd"
                  :title="t('select all {n} metrics in this file', { n: f.metricCount })"
                  @click.stop="selectAllInFile(f)"
                >{{ t('+ all') }}</button>
              </div>
            </div>
          </template>
        </nav>

        <div class="drawer__metrics">
          <header v-if="activeFileNode" class="drawer__breadcrumb">
            <span class="dim">{{ activeFileNode.source }} ·</span>
            <code>{{ activeFileNode.file }}</code>
            <template v-if="activeFileNode.scopes.length > 1">
              <span class="dim"> {{ t('· narrow:') }}</span>
              <button
                class="chip chip--sm"
                :class="{ 'chip--on': scopeNarrow === null }"
                @click="scopeNarrow = null"
              >{{ t('all') }}</button>
              <button
                v-for="sc in activeFileNode.scopes"
                :key="sc"
                class="chip chip--sm"
                :class="{ 'chip--on': scopeNarrow === sc }"
                @click="scopeNarrow = sc"
              >{{ scopeShort(sc) }}</button>
            </template>
            <span class="drawer__bcSpacer" />
            <button class="link" :disabled="drawerMetrics.length === 0" @click="selectAllVisible">
              {{ t('select all {n}', { n: drawerMetrics.length }) }}
            </button>
            <button class="link" @click="clearVisible">{{ t('clear') }}</button>
          </header>

          <ul class="drawer__list">
            <li
              v-for="m in drawerMetrics"
              :key="m.name"
              class="drawer__row"
              :class="{
                'drawer__row--off': !isMqeQueryable(m.type),
                'drawer__row--on': selection.has(m.name),
              }"
              @click="toggleDrawerPick(m.name, isMqeQueryable(m.type))"
            >
              <input
                type="checkbox"
                :checked="selection.has(m.name)"
                :disabled="!isMqeQueryable(m.type)"
                @click.stop="toggleDrawerPick(m.name, isMqeQueryable(m.type))"
              />
              <span class="drawer__name">{{ m.name }}</span>
              <Pill tone="dim">{{ m.type }}</Pill>
              <Pill tone="ok">{{ scopeShort(m.scope) }}</Pill>
              <span v-if="!isMqeQueryable(m.type)" class="drawer__why">
                {{ t('not MQE-queryable · /inspect/entities accepts REGULAR_VALUE + LABELED_VALUE') }}
              </span>
            </li>
            <li v-if="drawerMetrics.length === 0" class="drawer__listEmpty">
              {{ t('no metric matches the current filters') }}
            </li>
          </ul>
        </div>
      </div>

      </template>

      <!-- Foreign metric: not in this OAP's catalog (persisted by another
           OAP). Add by hand; charts values via /inspect/values. -->
      <template v-else>
      <section class="drawer__foreignTab">
        <p class="drawer__foreignLede">
          {{ t("A metric this OAP doesn't define — another OAP wrote it to the shared storage. Supply its value column and type (from the OAP that defines it) and Horizon charts the values.") }}
        </p>
        <label class="drawer__ff drawer__ff--full">
          <span class="drawer__ffLabel">{{ t('metric name') }}</span>
          <input
            v-model="foreignForm.name"
            class="ins__input"
            :placeholder="t('e.g. meter_custom_pool')"
            spellcheck="false"
            @keyup.enter="stageForeignMetric"
          />
        </label>
        <div class="drawer__foreignRow">
          <label class="drawer__ff drawer__ff--block">
            <span class="drawer__ffLabel">{{ t('scope') }}</span>
            <select v-model="foreignForm.scope" class="ins__select">
              <option v-for="s in FOREIGN_SCOPES" :key="s" :value="s">{{ scopeShort(s) }}</option>
            </select>
          </label>
          <label class="drawer__ff drawer__ff--block">
            <span class="drawer__ffLabel">{{ t('value column') }}</span>
            <input v-model="foreignForm.valueColumn" class="ins__input" placeholder="value" spellcheck="false" />
          </label>
          <label class="drawer__ff drawer__ff--block">
            <span class="drawer__ffLabel">{{ t('value type') }}</span>
            <select v-model="foreignForm.valueType" class="ins__select">
              <option v-for="vt in (INSPECT_FOREIGN_VALUE_TYPES as InspectForeignValueType[])" :key="vt" :value="vt">{{ vt }}</option>
            </select>
          </label>
        </div>
        <div class="drawer__foreignActions">
          <Btn :disabled="!foreignForm.name.trim()" @click="stageForeignMetric">{{ t('+ add to list') }}</Btn>
          <span v-if="foreignErr" class="drawer__foreignErr">{{ foreignErr }}</span>
        </div>

        <div v-if="foreignStaged.length > 0" class="drawer__staged">
          <div class="drawer__stagedHead">{{ t('staged · {n}', { n: foreignStaged.length }) }}</div>
          <ul class="drawer__stagedList">
            <li v-for="s in foreignStaged" :key="s.name" class="drawer__stagedRow">
              <span class="drawer__stagedName" :title="s.name">{{ s.name }}</span>
              <Pill tone="ok">{{ scopeShort(s.scope) }}</Pill>
              <Pill tone="dim">{{ s.valueColumn }} · {{ s.valueType }}</Pill>
              <button class="link drawer__stagedRemove" @click="unstageForeign(s.name)">{{ t('remove') }}</button>
            </li>
          </ul>
        </div>
      </section>
      </template>

      <footer class="drawer__foot">
        <span class="drawer__count">
          {{ t('{n} selected · {after} / {cap} after add', { n: drawerPending, after: widgetCount + drawerPending, cap: boardCap }) }}
        </span>
        <div class="drawer__foot-btns">
          <Btn @click="emit('close')">{{ t('Cancel') }}</Btn>
          <Btn
            kind="primary"
            :disabled="drawerPending === 0 || widgetCount >= boardCap"
            @click="commitDrawerActive"
          >
            {{ t('Add {n} to board', { n: drawerAddCount }) }}
          </Btn>
        </div>
      </footer>
    </div>
  </aside>
</template>

<style scoped>
.ins__lbl {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.ins__input {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  padding: 4px 8px;
  background: var(--rr-bg);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  min-width: 220px;
}
.ins__input:focus { outline: none; border-color: var(--rr-border2); }
.ins__select {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  padding: 4px 8px;
  background: var(--rr-bg);
  color: var(--rr-ink);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
}

.chip {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  padding: 3px 9px;
  background: transparent;
  color: var(--rr-ink2);
  border: 1px solid var(--rr-border);
  border-radius: 999px;
  cursor: pointer;
}
.chip--sm { padding: 2px 8px; font-size: var(--sw-fs-sm); }
.chip:hover { color: var(--rr-heading); border-color: var(--rr-border2); }
.chip--on { background: color-mix(in oklab, var(--rr-accent) 18%, transparent); border-color: var(--rr-accent); color: var(--rr-heading); }

.iconbtn {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  padding: 1px 6px;
  background: transparent;
  color: var(--rr-ink2);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  cursor: pointer;
  text-transform: lowercase;
  line-height: 1.5;
}
.iconbtn:hover { color: var(--rr-heading); border-color: var(--rr-border2); }
.iconbtn--x { font-size: var(--sw-fs-sm); line-height: 1; padding: 0 6px; }

.link {
  background: transparent;
  border: 0;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-accent);
  cursor: pointer;
  padding: 0;
}
.link:hover { text-decoration: underline; }

/* Drawer */
.drawer {
  position: fixed;
  inset: 0;
  background: rgba(8, 12, 16, 0.6);
  z-index: 50;
  display: flex;
  justify-content: flex-end;
}
.drawer__panel {
  width: 880px;
  max-width: 95vw;
  height: 100%;
  background: var(--rr-bg);
  border-left: 1px solid var(--rr-border);
  display: flex;
  flex-direction: column;
}
.drawer__head {
  padding: 14px 18px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  border-bottom: 1px solid var(--rr-border);
}
.drawer__kicker {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.drawer__title {
  margin: 4px 0 0;
  font-family: var(--rr-font-ui);
  font-weight: var(--sw-fw-medium);
  font-size: var(--sw-fs-md);
  color: var(--rr-heading);
}
.drawer__sources { padding: 10px 18px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.drawer__search { padding: 10px 18px; display: flex; gap: 12px; align-items: center; }
.drawer__search .ins__input { flex: 1; }
.drawer__count { font-family: var(--rr-font-mono); font-size: var(--sw-fs-base); color: var(--rr-dim); }
.drawer__panes {
  display: grid;
  grid-template-columns: 280px 1fr;
  flex: 1;
  min-height: 0;
  border-top: 1px solid var(--rr-border);
}
.drawer__tree { overflow-y: auto; border-right: 1px solid var(--rr-border); padding: 6px 0; }
.drawer__treeGroup { padding: 6px 0 10px; }
.drawer__treeKicker {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  padding: 4px 14px;
}
.drawer__file { display: flex; align-items: stretch; border-left: 2px solid transparent; }
.drawer__file:hover { background: var(--rr-bg2); }
.drawer__file--on { background: var(--rr-bg2); border-left-color: var(--rr-accent); }
.drawer__file--on .drawer__fileBtn { color: var(--rr-heading); }
.drawer__fileBtn {
  flex: 1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-ink2);
  text-align: left;
  min-width: 0;
}
.drawer__fileBtn:hover { color: var(--rr-heading); }
.drawer__fileName { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.drawer__fileMeta { display: flex; align-items: center; gap: 6px; }
.drawer__fileCount { font-size: var(--sw-fs-sm); color: var(--rr-dim); min-width: 18px; text-align: right; }
.drawer__fileAdd {
  background: transparent;
  border: 0;
  padding: 0 12px 0 4px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  color: var(--rr-dim);
  cursor: pointer;
  flex-shrink: 0;
}
.drawer__fileAdd:hover { color: var(--rr-accent); }

.drawer__metrics { display: flex; flex-direction: column; min-height: 0; }
.drawer__breadcrumb {
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  color: var(--rr-ink2);
  border-bottom: 1px solid var(--rr-border);
}
.drawer__breadcrumb code { color: var(--rr-heading); }
.dim { color: var(--rr-dim); }
.drawer__bcSpacer { flex: 1 1 auto; }

.drawer__list { list-style: none; padding: 0; margin: 0; flex: 1; overflow-y: auto; }
/* The global Pill primitive renders at 13.5 px — fine for cluster-status
 * tables but feels chunky in the dense drawer / file-tree rows. Shrink
 * pills appearing inside the drawer panes to match the local font
 * scale (~11.5 px), no effect on Pills elsewhere in the app. */
.drawer__list :deep(.pill),
.drawer__tree :deep(.pill) {
  font-size: var(--sw-fs-sm);
  padding: 1px 6px;
  letter-spacing: 0.3px;
}
.drawer__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--rr-bg2);
  cursor: pointer;
}
.drawer__row:hover { background: var(--rr-bg2); }
.drawer__row--on { background: color-mix(in oklab, var(--rr-accent) 12%, transparent); }
.drawer__row--off { cursor: not-allowed; opacity: 0.55; }
.drawer__name { font-family: var(--rr-font-mono); font-size: var(--sw-fs-sm); color: var(--rr-heading); flex: 1; min-width: 200px; }
.drawer__why { flex-basis: 100%; padding-left: 26px; font-family: var(--rr-font-mono); font-size: var(--sw-fs-sm); color: var(--rr-dim); }
.drawer__listEmpty { padding: 20px; text-align: center; font-family: var(--rr-font-mono); font-size: var(--sw-fs-base); color: var(--rr-dim); }
.drawer__tabs {
  display: flex;
  gap: 8px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--rr-border);
}
.drawer__tab {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-medium);
  color: var(--rr-ink2);
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
  padding: 7px 18px;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.drawer__tab:hover { color: var(--rr-heading); border-color: var(--rr-ink2); }
.drawer__tab--on {
  color: var(--rr-heading);
  background: color-mix(in oklab, var(--rr-accent) 22%, transparent);
  border-color: var(--rr-accent);
  font-weight: var(--sw-fw-semibold);
}

.drawer__foreignTab {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.drawer__foreignLede {
  margin: 0;
  max-width: 620px;
  font-family: var(--rr-font-ui);
  font-size: var(--sw-fs-sm);
  line-height: 1.5;
  color: var(--rr-dim);
}
.drawer__foreignRow {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  max-width: 620px;
}
.drawer__ff { display: flex; flex-direction: column; gap: 4px; }
.drawer__ff--full { width: 100%; max-width: 620px; }
.drawer__ff--full .ins__input { width: 100%; }
.drawer__ff--block { min-width: 0; }
.drawer__ff--block .ins__input, .drawer__ff--block .ins__select { width: 100%; }
.drawer__ffLabel {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.drawer__foreignActions { display: flex; align-items: center; gap: 12px; }
.drawer__foreignErr {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-err);
}
.drawer__staged { display: flex; flex-direction: column; gap: 6px; }
.drawer__stagedHead {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-bold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.drawer__stagedList { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.drawer__stagedRow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-sm);
}
.drawer__stagedName {
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  color: var(--rr-heading);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drawer__stagedRemove { flex: 0 0 auto; }

.drawer__foot {
  padding: 12px 18px;
  border-top: 1px solid var(--rr-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.drawer__foot-btns { display: flex; gap: 8px; }
</style>
