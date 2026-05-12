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
  Placeholder body for per-layer tabs that haven't been built yet
  (Topology / Traces / Logs / Dashboards / Instances / Endpoints /
  Profiling / Events). Reads `?service=` from the URL so when an
  operator picks a service in the top selector zone, the placeholder
  reflects the scope they'd see once the phase ships.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useSelectedService } from '@/composables/useSelectedService';

defineProps<{ title: string; phase: string; note?: string }>();

const { selectedId } = useSelectedService();
const scoped = computed(() => selectedId.value !== null);
</script>

<template>
  <div class="sw-card layer-ph">
    <div class="kicker">Coming in {{ phase }}</div>
    <h2>{{ title }}</h2>
    <p v-if="note" class="note">{{ note }}</p>
    <p v-if="scoped" class="scope">
      When this view ships, the selected service
      <code>{{ selectedId }}</code>
      will scope the query automatically.
    </p>
    <p v-else class="scope muted">
      Pick a service from the selector above to scope this view in advance.
    </p>
  </div>
</template>

<style scoped>
.layer-ph {
  padding: 20px 24px;
  margin-top: 4px;
}
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 8px;
}
.layer-ph h2 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: var(--sw-fg-0);
  letter-spacing: -0.02em;
}
.note {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--sw-fg-2);
  line-height: 1.5;
}
.scope {
  margin: 0;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  border-top: 1px dashed var(--sw-line);
  padding-top: 10px;
}
.scope.muted {
  color: var(--sw-fg-3);
}
.scope code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--sw-fg-1);
}
</style>
