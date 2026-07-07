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
  New-overview-dashboard composer. A self-contained form (id / title /
  description) that emits `submit` with the typed values; the parent owns
  uniqueness validation and pushes any failure back via the `error` prop.
  Create mirrors edit — the parent writes a LOCAL browser draft, never the
  server, so this modal carries no persistence of its own.
-->
<script setup lang="ts">
import { ref, watch } from 'vue';
import Modal from '@/features/operate/_shared/Modal.vue';
import { vAutosize } from '@/utils/autosize';

const props = defineProps<{
  open: boolean;
  /** Validation error pushed back by the parent (uniqueness / shape). */
  error: string | null;
}>();

const emit = defineEmits<{
  close: [];
  submit: [payload: { id: string; title: string; description: string }];
}>();

const id = ref('');
const title = ref('');
const description = ref('');

// Reset the fields each time the composer (re)opens so a prior cancel
// doesn't leak its half-typed values into the next create.
watch(
  () => props.open,
  (open) => {
    if (open) {
      id.value = '';
      title.value = '';
      description.value = '';
    }
  },
);

function submit(): void {
  emit('submit', { id: id.value, title: title.value, description: description.value });
}
</script>

<template>
  <Modal :open="open" title="New dashboard" width="min(520px, 92vw)" @close="emit('close')">
    <div class="nod">
      <label class="nod__field">
        <span>Id (used as the name — must be unique)</span>
        <input v-model="id" type="text" class="nod__in nod__in--mono" placeholder="my-overview" @keyup.enter="submit" />
      </label>
      <label class="nod__field">
        <span>Title</span>
        <input v-model="title" type="text" class="nod__in" placeholder="My overview" @keyup.enter="submit" />
      </label>
      <label class="nod__field">
        <span>Description (optional)</span>
        <textarea v-autosize="description" v-model="description" class="nod__in nod__in--ta" rows="2" placeholder="Short, one-paragraph description shown under the dashboard title." />
      </label>
      <div v-if="error" class="nod__err">{{ error }}</div>
    </div>
    <template #footer>
      <button class="sw-btn" type="button" @click="emit('close')">Cancel</button>
      <button class="sw-btn is-primary" type="button" @click="submit">Create</button>
    </template>
  </Modal>
</template>

<style scoped>
.nod { display: flex; flex-direction: column; gap: 10px; }
.nod__field { display: flex; flex-direction: column; gap: 3px; }
.nod__field > span {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--sw-fg-3); font-weight: 600;
}
.nod__in {
  background: var(--sw-bg-1); border: 1px solid var(--sw-line);
  color: var(--sw-fg-0); font: inherit; font-size: 11.5px;
  padding: 4px 6px; border-radius: 4px;
}
.nod__in--mono { font-family: var(--sw-mono); }
.nod__in--ta {
  width: 100%; box-sizing: border-box; min-height: 56px;
  padding: 8px 10px; resize: vertical; line-height: 1.5;
  font-family: var(--sw-sans); font-size: 12px;
}
.nod__err { font-size: 11px; color: var(--sw-err); }
</style>
