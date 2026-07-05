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
<!-- Sub-page figure block. Surfaces a feature view (the layer service list) the
     assistant chose, and opens the REAL view (with the resolved route) in a new
     tab. Graph/triage views embed inline via their own blocks; this is the
     remaining link-out card. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';
import type { SubPageSpec } from './types';

const props = defineProps<{ n: number; spec: SubPageSpec }>();
const router = useRouter();
const { t } = useI18n({ useScope: 'global' });

const ROUTE_SUFFIX: Record<SubPageSpec['kind'], string> = {
  'service-list': 'service',
};

const href = computed(
  () => router.resolve({ path: `/layer/${props.spec.layer.toLowerCase()}/${ROUTE_SUFFIX[props.spec.kind]}` }).href,
);

function open(): void {
  window.open(href.value, '_blank', 'noopener');
}
</script>

<template>
  <div class="csp">
    <div class="csp__cap">{{ t('Figure {n}', { n }) }} · {{ spec.title }}</div>
    <button type="button" class="csp__open" :title="t('Open in a new tab')" @click="open">
      <Icon name="external" :size="13" />
      <span>{{ t('Open in a new tab') }}</span>
    </button>
  </div>
</template>

<style scoped>
.csp {
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.csp__cap {
  font-size: var(--sw-fs-sm);
  color: var(--sw-fg-1);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.csp__open {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--sw-line-2);
  border-radius: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: var(--sw-fs-sm);
  cursor: pointer;
}
.csp__open:hover {
  border-color: var(--sw-accent);
  color: var(--sw-fg-0);
}
</style>
