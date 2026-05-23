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
  Per-session reminder for EDITORS who have unpublished local template
  drafts in THIS browser. Live pages always render remote; a draft is only
  previewed via the editor's "Preview live" entrance (?mode=preview). This
  prompt just nudges the operator to the relevant edit page so they can
  publish or discard. No "use local vs remote" choice — remote is always
  the live source. Shown once per session (dismissible), only to users who
  can edit the kind of draft they hold.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Modal from '@/features/operate/_shared/Modal.vue';
import { useLayers } from '@/shell/useLayers';
import { useConfigBundle } from '@/controls/configBundle';
import { useLocalTemplateEdits } from '@/controls/localTemplateEdits';
import { usePreviewMode } from '@/controls/previewMode';
import { useAuthStore } from '@/state/auth';

const router = useRouter();
const previewMode = usePreviewMode();
const { layers } = useLayers();
const { bundle } = useConfigBundle();
const auth = useAuthStore();
const { edits } = useLocalTemplateEdits();

// Both checks are `:write` for symmetry — the prompt nudges operators
// who can act on the draft (publish or discard). `dashboard:read` would
// resolve to the same roles in the default policy today, but a role with
// read-only dashboard access shouldn't be nagged about edits it can't push.
const canEditLayers = computed<boolean>(() => auth.hasVerb('dashboard:write'));
const canEditOverviews = computed<boolean>(() => auth.hasVerb('overview:write'));

interface DraftItem {
  kind: 'layer' | 'overview';
  key: string;
  label: string;
}
/** Unpublished local drafts in this browser, restricted to kinds the
 *  user can edit, named from the menu perspective. */
const draftItems = computed<DraftItem[]>(() => {
  const overviews = bundle.value?.overviews ?? [];
  const out: DraftItem[] = [];
  for (const name of Object.keys(edits.value)) {
    const [, kind, ...rest] = name.split('.');
    const key = rest.join('.');
    if (kind === 'layer') {
      if (!canEditLayers.value) continue;
      const L = layers.value.find((l) => l.key.toUpperCase() === key.toUpperCase());
      out.push({ kind, key, label: L?.name ? `Layer · ${L.name}` : `Layer · ${key}` });
    } else if (kind === 'overview') {
      if (!canEditOverviews.value) continue;
      const ov = overviews.find((o) => o.id === key);
      out.push({ kind, key, label: ov?.title ? `Overview · ${ov.title}` : `Overview · ${key}` });
    }
  }
  return out;
});

const hasLayerDrafts = computed(() => draftItems.value.some((d) => d.kind === 'layer'));
const hasOverviewDrafts = computed(() => draftItems.value.some((d) => d.kind === 'overview'));

// Dismissed once per browser session so it doesn't nag on every route.
const SESSION_KEY = 'horizon:localDraftPrompt:dismissed';
const dismissed = ref<boolean>(
  typeof sessionStorage !== 'undefined' && sessionStorage.getItem(SESSION_KEY) === '1',
);
// Not while previewing — a preview tab shows the dedicated preview banner
// instead of the editor's unpublished-edits reminder.
const open = computed(() => !previewMode.value && !dismissed.value && draftItems.value.length > 0);

function dismiss(): void {
  dismissed.value = true;
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* private mode — in-memory dismissal still holds for this session */
  }
}
function goLayers(): void {
  const first = draftItems.value.find((d) => d.kind === 'layer');
  dismiss();
  void router.push({ path: '/admin/layer-dashboards', query: first ? { layer: first.key } : {} });
}
function goOverviews(): void {
  dismiss();
  void router.push({ path: '/admin/overview-templates' });
}
</script>

<template>
  <Modal :open="open" :dismissable="false" title="You have unpublished local edits">
    <div class="tcp">
      <p class="tcp__lede">
        <b>{{ draftItems.length }}</b> dashboard{{ draftItems.length === 1 ? '' : 's' }} ha{{ draftItems.length === 1 ? 's' : 've' }}
        edits saved only in <b>this browser</b> — they are not live for anyone. Live pages render the
        remote (OAP) version; preview your drafts from the editor’s <b>Preview live</b> button, then
        <b>Push local → OAP</b> to publish.
      </p>
      <ul class="tcp__list">
        <li v-for="(d, i) in draftItems" :key="i">{{ d.label }}</li>
      </ul>
    </div>
    <template #footer>
      <button class="sw-btn" type="button" @click="dismiss">Dismiss</button>
      <button v-if="hasOverviewDrafts" class="sw-btn" type="button" @click="goOverviews">
        Overview templates →
      </button>
      <button v-if="hasLayerDrafts" class="sw-btn is-primary" type="button" @click="goLayers">
        Layer dashboards →
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.tcp { padding: 4px 2px; }
.tcp__lede { margin: 0 0 10px; font-size: 12.5px; color: var(--sw-fg-1); line-height: 1.55; }
.tcp__list {
  margin: 0;
  padding: 8px 10px 8px 24px;
  max-height: 30vh;
  overflow: auto;
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  background: var(--sw-bg-2);
  font-size: 11.5px;
  color: var(--sw-fg-1);
  line-height: 1.6;
}
</style>
