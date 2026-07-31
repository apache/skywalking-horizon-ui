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

defineProps<{ title: string; note?: string; inset?: boolean }>();

const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <div class="ph" :class="{ inset }">
    <div class="ph-card">
      <div class="ph-kicker">404</div>
      <h1 v-if="!inset">{{ t(title) }}</h1>
      <h2 v-else>{{ t(title) }}</h2>
      <p v-if="note">{{ t(note) }}</p>
    </div>
  </div>
</template>

<style scoped>
.ph {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  padding: 32px;
}
.ph.inset {
  min-height: 200px;
  padding: 20px;
}
.ph.inset .ph-card {
  padding: 20px 24px;
}
.ph-card h2 {
  font-size: 14px;
  font-weight: 600;
  color: var(--sw-fg-0);
  margin: 0 0 6px;
}
.ph-card {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 10px;
  padding: 28px 32px;
  max-width: 520px;
  text-align: center;
}
.ph-kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 10px;
}
.ph-card h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.ph-card p {
  font-size: 12px;
  color: var(--sw-fg-2);
  margin: 0;
  line-height: 1.5;
}
</style>
