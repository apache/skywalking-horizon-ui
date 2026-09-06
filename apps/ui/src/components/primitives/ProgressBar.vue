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
  A thin progress bar on the accent colour. `value` is the fraction done
  (0–1); with no value the bar is indeterminate and a highlight travels along
  it, which tells the reader the wait is alive when nothing can be counted.
-->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  value?: number | null;
  label?: string;
}>();

const fraction = computed<number | null>(() =>
  typeof props.value === 'number' && Number.isFinite(props.value) ? Math.min(1, Math.max(0, props.value)) : null,
);
</script>

<template>
  <div
    class="sw-progress"
    :class="{ indeterminate: fraction === null }"
    role="progressbar"
    :aria-label="label"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="fraction === null ? undefined : Math.round(fraction * 100)"
  >
    <i :style="fraction === null ? undefined : { width: `${fraction * 100}%` }" />
  </div>
</template>

<style scoped>
.sw-progress { position: relative; height: 6px; overflow: hidden; border-radius: 3px; background: color-mix(in srgb, var(--sw-fg-0) 10%, transparent); }
.sw-progress > i { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; background: var(--sw-accent); transition: width 0.25s ease-out; }
.sw-progress.indeterminate > i { width: 28%; background: linear-gradient(90deg, transparent, var(--sw-accent), transparent); animation: sw-progress-slide 1.4s linear infinite; }
@keyframes sw-progress-slide { from { left: -28%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) {
  .sw-progress.indeterminate > i { animation: none; left: 36%; }
}
</style>
