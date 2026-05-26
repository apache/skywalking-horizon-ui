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
import { useI18n } from 'vue-i18n';
import { CATALOGS, type Catalog } from '@skywalking-horizon-ui/api-client';
import { useAuthStore } from '@/state/auth';
import { bff } from '@/api/client';
import Btn from '@/components/primitives/Btn.vue';
import Pill from '@/components/primitives/Pill.vue';
import AdminFeatureWarning from '@/shell/AdminFeatureWarning.vue';

const { t } = useI18n();
const auth = useAuthStore();

function dumpAll(): void {
  bff.dsl.triggerDump();
}
function dumpCatalog(c: Catalog): void {
  bff.dsl.triggerDump(c);
}
</script>

<template>
  <div class="dump">
    <AdminFeatureWarning module="receiver-runtime-rule" :feature-label="t('Runtime-rule dump')" />
    <header class="dump__header">
      <h1 class="dump__h1">{{ t('Dump & restore') }}</h1>
      <Pill tone="dim">{{ t('tar.gz') }}</Pill>
    </header>

    <section class="dump__section">
      <header class="dump__sectionhead">{{ t('dump') }}</header>
      <i18n-t keypath="Stream a {tar} snapshot of the runtime-rule rows currently in OAP. ACTIVE rows go under {active}, INACTIVE under {inactive}, and a top-level {manifest} records sha256 + status + updateTime per row." tag="p" class="dump__hint">
        <template #tar><code>tar.gz</code></template>
        <template #active><code>&lt;catalog&gt;/&lt;name&gt;.yaml</code></template>
        <template #inactive><code>inactive/&lt;catalog&gt;/&lt;name&gt;.yaml</code></template>
        <template #manifest><code>manifest.yaml</code></template>
      </i18n-t>

      <div class="dump__actions">
        <Btn
          kind="primary"
          :disabled="!auth.hasVerb('rule:read')"
          :data-testid="'dump-all'"
          @click="dumpAll"
        >
          {{ t('dump all catalogs') }}
        </Btn>
        <Btn
          v-for="c in CATALOGS"
          :key="c"
          :disabled="!auth.hasVerb('rule:read')"
          :data-testid="`dump-${c}`"
          @click="dumpCatalog(c)"
        >
          {{ t('dump · {catalog}', { catalog: c }) }}
        </Btn>
      </div>
    </section>

    <section class="dump__section dump__section--disabled">
      <header class="dump__sectionhead">
        {{ t('restore') }}
        <Pill tone="dim">{{ t('later release') }}</Pill>
      </header>
      <i18n-t keypath="OAP doesn't expose a restore endpoint yet. Operators recover from a dump by looping {endpoint} over each YAML file in the archive. A restore upload affordance will land here when the upstream API ships — see Studio's deferred-features memory." tag="p" class="dump__hint">
        <template #endpoint><code>POST /runtime/rule/addOrUpdate</code></template>
      </i18n-t>
    </section>
  </div>
</template>

<style scoped>
.dump {
  padding: 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 900px;
}

.dump__header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dump__h1 {
  margin: 0;
  font-family: var(--rr-font-ui);
  font-weight: var(--sw-fw-semibold);
  font-size: var(--sw-fs-lg);
  color: var(--sw-accent);
  letter-spacing: var(--sw-ls-tight);
}

.dump__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--rr-bg2);
  border: 1px solid var(--rr-border);
  border-radius: var(--rr-radius-md);
  padding: 16px 18px;
}

.dump__section--disabled {
  opacity: 0.7;
}

.dump__sectionhead {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-sm);
  font-weight: var(--sw-fw-bold);
  letter-spacing: var(--sw-ls-caps);
  text-transform: uppercase;
  color: var(--sw-fg-3);
}

.dump__hint {
  margin: 0;
  font-size: var(--sw-fs-md);
  line-height: var(--sw-lh-normal);
  color: var(--rr-ink2);
}

.dump__hint code {
  font-family: var(--rr-font-mono);
  color: var(--rr-info);
  font-size: var(--sw-fs-base);
}

.dump__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
