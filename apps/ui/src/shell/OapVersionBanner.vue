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
 * A feature this OAP does not serve because it is older than the version that added it. The page still mounts
 * below, and its calls fail until OAP is upgraded.
 */
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';

const { t } = useI18n({ useScope: 'global' });

defineProps<{
  /** The feature, as the page names it. */
  featureLabel: string;
  /** The first SkyWalking release that serves it. */
  minVersion: string;
  /** What OAP answered, for the operator to check. */
  detail?: string;
}>();
</script>

<template>
  <div class="warn" role="alert">
    <span class="icon"><Icon name="alert" :size="14" /></span>
    <div class="body">
      <h3>{{ t('Needs Apache SkyWalking {version} or higher', { version: minVersion }) }}</h3>
      <p>
        <strong>{{ featureLabel }}</strong>
        {{ t('is served by OAP {version} and later; this OAP does not serve it. Upgrade OAP to use it.', { version: minVersion }) }}
      </p>
      <p v-if="detail" class="hint">{{ detail }}</p>
    </div>
  </div>
</template>

<style scoped>
.warn {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  background: var(--sw-warn-soft);
  border: 1px solid var(--sw-warn);
  border-radius: 8px;
  color: var(--sw-fg-1);
}

.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: var(--sw-warn);
  flex-shrink: 0;
}

.body {
  flex: 1;
  min-width: 0;
}

.body h3 {
  margin: 0 0 6px;
  font-size: var(--sw-fs-base);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-warn);
}

.body p {
  margin: 0 0 4px;
  font-size: var(--sw-fs-sm);
  line-height: 1.55;
}

.body p.hint {
  color: var(--sw-fg-2);
}

.body strong {
  color: var(--sw-fg-0);
}
</style>
