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
  "Sync all to OAP" for one template family. Pushes the bundled copy of
  every template that differs from OAP (diverged) or is missing on OAP
  (bundled-fallback) — already-synced templates are left untouched. The
  push always goes through a manual confirm listing exactly what will be
  written, since it mutates OAP's shared template store.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import Modal from '@/features/operate/_shared/Modal.vue';
import { useTemplateSync } from '@/features/admin/_shared/useTemplateSync';
import { refreshConfigBundle, setTemplateRenderMode } from '@/controls/configBundle';
import { useTemplatePreference } from '@/controls/templatePreference';
import { bffClient } from '@/api/client';
import type { TemplateKind } from '@/api/scopes/configs';

const props = defineProps<{ kind: TemplateKind }>();

const sync = useTemplateSync({ kind: props.kind });
const pref = useTemplatePreference();

// Effective render source for diverged templates (null defaults to remote).
const renderMode = computed<'local' | 'remote'>(() => (pref.mode === 'local' ? 'local' : 'remote'));
function setMode(m: 'local' | 'remote'): void {
  if (renderMode.value !== m) void setTemplateRenderMode(m);
}

/** Templates whose bundled copy differs from OAP (push targets). */
const diffNames = computed<string[]>(() => {
  const s = sync.status.value;
  if (!s) return [];
  return s.badges
    .filter(
      (b) => b.kind === props.kind && (b.status === 'diverged' || b.status === 'bundled-fallback'),
    )
    .map((b) => b.name)
    .sort();
});

const open = ref(false);
const busy = ref(false);
const result = ref<{ synced: number; failed: { name: string; error: string }[] } | null>(null);

const disabled = computed(() => sync.readOnly.value || diffNames.value.length === 0);
const buttonTitle = computed(() => {
  if (sync.readOnly.value) return 'OAP unreachable — page is read-only';
  if (diffNames.value.length === 0) return 'Everything already matches OAP — nothing to push';
  return `Push ${diffNames.value.length} changed template(s) to OAP`;
});

function openConfirm(): void {
  if (disabled.value) return;
  result.value = null;
  open.value = true;
}

async function confirmSync(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await bffClient.templateSync.syncAll(props.kind);
    await refreshConfigBundle();
    result.value = { synced: res.synced.length, failed: res.failed };
    if (res.failed.length === 0) {
      // Clean success — close shortly so the operator sees the count.
      setTimeout(() => {
        open.value = false;
        result.value = null;
      }, 1400);
    }
  } catch (err) {
    result.value = { synced: 0, failed: [{ name: '—', error: err instanceof Error ? err.message : String(err) }] };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <span class="sab__display" title="Which version this session renders for templates that differ from OAP.">
    <span class="sab__display-label">Showing</span>
    <button class="sab__seg" :class="{ on: renderMode === 'local' }" type="button" @click="setMode('local')">Local</button>
    <button class="sab__seg" :class="{ on: renderMode === 'remote' }" type="button" @click="setMode('remote')">Remote</button>
  </span>
  <button
    class="sw-btn"
    type="button"
    :disabled="disabled"
    :title="buttonTitle"
    @click="openConfirm"
  >
    Sync all to OAP<span v-if="diffNames.length" class="sab__count">{{ diffNames.length }}</span>
  </button>

  <Modal :open="open" title="Sync all to OAP" @close="open = false">
    <div v-if="!result" class="sab__body">
      <p class="sab__lede">
        Push the bundled copy of these <b>{{ diffNames.length }}</b> template(s) to OAP,
        overwriting what OAP currently stores. Already-synced templates are not touched.
        This affects every operator using this OAP.
      </p>
      <ul class="sab__list">
        <li v-for="n in diffNames" :key="n" class="mono">{{ n }}</li>
      </ul>
    </div>
    <div v-else class="sab__body">
      <p class="sab__lede">
        Pushed <b>{{ result.synced }}</b> template(s).
        <span v-if="result.failed.length" class="sab__err">{{ result.failed.length }} failed.</span>
      </p>
      <ul v-if="result.failed.length" class="sab__list">
        <li v-for="f in result.failed" :key="f.name" class="mono sab__err">{{ f.name }}: {{ f.error }}</li>
      </ul>
    </div>

    <template #footer>
      <button class="sw-btn ghost" type="button" @click="open = false">{{ result ? 'Close' : 'Cancel' }}</button>
      <button
        v-if="!result"
        class="sw-btn primary"
        type="button"
        :disabled="busy || diffNames.length === 0"
        @click="confirmSync"
      >
        {{ busy ? 'Pushing…' : `Push ${diffNames.length} to OAP` }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sab__count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--sw-accent);
  color: #1a1a1a;
  font-size: 10px;
  font-weight: 700;
}
.sab__display {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 8px;
  font-size: 11px;
}
.sab__display-label { color: var(--sw-fg-3); margin-right: 2px; }
.sab__seg {
  padding: 2px 8px;
  border: 1px solid var(--sw-line);
  background: transparent;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.sab__seg:first-of-type { border-radius: 5px 0 0 5px; }
.sab__seg:last-of-type { border-radius: 0 5px 5px 0; border-left: none; }
.sab__seg.on { background: var(--sw-accent); color: #1a1a1a; border-color: var(--sw-accent); font-weight: 600; }
.sab__body { padding: 4px 2px; }
.sab__lede { margin: 0 0 10px; font-size: 12px; color: var(--sw-fg-2); line-height: 1.5; }
.sab__list {
  margin: 0;
  padding: 8px 10px;
  list-style: none;
  max-height: 40vh;
  overflow: auto;
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  background: var(--sw-bg-2);
}
.sab__list li { font-size: 11.5px; padding: 2px 0; color: var(--sw-fg-1); }
.sab__err { color: var(--sw-err); }
</style>
