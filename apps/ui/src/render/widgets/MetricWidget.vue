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
import { formatValue } from './ValueFormat';
import WidgetTip from '@/components/primitives/WidgetTip.vue';
defineProps<{ title: string; tip?: string; value: number | null | undefined; unit?: string }>();
</script>

<template>
  <section class="sw-card tile">
    <header>
      <h4>{{ title }}</h4>
      <WidgetTip :tip="tip" />
    </header>
    <div class="value">{{ formatValue(value, unit) }}</div>
  </section>
</template>

<style scoped>
.tile { display: flex; flex-direction: column; padding: 10px 12px; gap: 4px; min-height: 0; }
header { display: flex; align-items: center; gap: 6px; }
h4 { margin: 0; font-size: 11px; font-weight: 600; color: var(--sw-fg-1); }
.value {
  font-size: 22px; font-weight: 600; color: var(--sw-fg-0); margin-top: auto;
  font-variant-numeric: tabular-nums;
}
</style>
