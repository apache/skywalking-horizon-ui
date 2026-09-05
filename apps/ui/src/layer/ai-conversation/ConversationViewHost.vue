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
  Hosts the shared conversation renderer (`@skywalking-horizon-ui/conversation-view`)
  inside Vue: mounts it once per document, hands it the UI's texts and locale,
  and round-trips the reader's position (talk / step / stream) so the page can
  keep it in the URL. The renderer owns everything inside the host element.
-->
<script setup lang="ts">
import '@skywalking-horizon-ui/conversation-view/style.css';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  makeFormatter,
  mountConversationView,
  type AszViewDocument,
  type ConversationView,
  type PublicState,
} from '@skywalking-horizon-ui/conversation-view';
import { currentLocale } from '@/i18n';
import { conversationStrings } from './conversationStrings';

const props = defineProps<{
  document: AszViewDocument;
  state?: PublicState;
}>();
const emit = defineEmits<{ (e: 'update:state', state: PublicState): void }>();

const { t } = useI18n({ useScope: 'global' });
const el = ref<HTMLElement | null>(null);
let view: ConversationView | null = null;

function same(a: PublicState | undefined, b: PublicState): boolean {
  return (a?.talk ?? '') === (b.talk ?? '') && (a?.step ?? '') === (b.step ?? '') && (a?.stream ?? '') === (b.stream ?? '');
}

function mountView(): void {
  if (!el.value) return;
  view?.destroy();
  view = mountConversationView(el.value, {
    document: props.document,
    strings: conversationStrings(t),
    formatter: makeFormatter(currentLocale(), t('unavailable')),
    ...(props.state ? { state: props.state } : {}),
    onStateChange: (s) => emit('update:state', s),
  });
}

onMounted(mountView);
watch(() => props.document, mountView);
watch(
  () => props.state,
  (s) => {
    if (view && s && !same(s, view.getState())) view.setState(s);
  },
  { deep: true },
);
onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="el" class="conversation-host" />
</template>

<style scoped>
.conversation-host { flex: 1; min-height: 0; }
</style>
