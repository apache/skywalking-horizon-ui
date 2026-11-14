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
  A span dialog's Related logs button. A native span's logs are found by its
  segment id and span id on any OAP; an OTLP or Zipkin span's by its hex id,
  which OAP stores and queries from 11.2.0 — before that the button stays,
  disabled, saying what it needs.

  Props:
    kind — 'native' or 'otlp' (OTLP and Zipkin spans alike).
  Emits:
    open — the button was clicked.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import { useOapInfo } from '@/shell/useOapInfo';

const { t } = useI18n({ useScope: 'global' });
const props = defineProps<{ kind: 'native' | 'otlp' }>();
const emit = defineEmits<{ (e: 'open'): void }>();

const { capabilities } = useOapInfo();
const unavailable = computed(() => props.kind === 'otlp' && !capabilities.value.logOtlpSpanId);
</script>

<template>
  <span class="sl">
    <span v-if="unavailable" class="sl-note">{{ t('Requires SkyWalking 11.2') }}</span>
    <button
      class="sw-btn small ghost sl-btn"
      type="button"
      :disabled="unavailable"
      :title="unavailable ? t('Reading the logs of an OTLP or Zipkin span requires SkyWalking 11.2 or later.') : t('Logs of this span')"
      @click="emit('open')"
    ><Icon name="log" :size="12" />{{ t('Related logs') }}</button>
  </span>
</template>

<style scoped>
.sl { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
.sl-note { font-size: 10.5px; color: var(--sw-fg-3); white-space: nowrap; }
.sl-btn { display: inline-flex; align-items: center; gap: 5px; text-transform: none; letter-spacing: 0; }
.sl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sw-btn.small { height: 24px; padding: 0 10px; font-size: 11px; }
.sw-btn.ghost { background: transparent; border: 1px solid var(--sw-line-2); color: var(--sw-fg-2); }
</style>
