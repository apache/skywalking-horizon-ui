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
<!-- Shared "captured <when>" tag for every frozen/replayed chat block (figures,
     maps, profiling, triage lists). The replay icon marks the block as a
     point-in-time snapshot replayed from history, not live data. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';

const props = defineProps<{ at?: number }>();
const { t } = useI18n({ useScope: 'global' });
const when = computed<string>(() =>
  props.at
    ? new Date(props.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '',
);
</script>

<template>
  <span class="cct" :title="t('Captured snapshot — replayed from history, not live data')">
    <span class="cct__sep">·</span>
    <Icon name="replay" :size="11" />
    <span>{{ when ? t('captured {when}', { when }) : t('captured') }}</span>
  </span>
</template>

<style scoped>
.cct {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--sw-fg-3, #6b6f7a);
}
.cct__sep {
  margin-right: 1px;
}
</style>
