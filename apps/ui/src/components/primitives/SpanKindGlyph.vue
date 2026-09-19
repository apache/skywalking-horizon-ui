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
  The glyph for a span's direction: into a service, out of it, or neither.

  It takes a FAMILY, not a span — `entry`, `exit`, `local`, `producer`,
  `consumer` — so it knows nothing about which trace protocol named it, and the
  native and TraceQL waterfalls can draw the same shapes without sharing a span
  model. Colour comes from the caller through `currentColor`.
-->
<script setup lang="ts">
withDefaults(
  defineProps<{
    family: 'entry' | 'exit' | 'local' | 'producer' | 'consumer' | 'other';
    /** Accessible name — the caller knows what vocabulary to say it in. */
    label?: string;
  }>(),
  { label: '' },
);
</script>

<template>
  <svg class="kind-glyph" viewBox="0 0 14 14" :aria-label="label" :title="label">
    <template v-if="family === 'entry'">
      <path d="M1 7 L9 7 M6 4 L9 7 L6 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="11.5" y1="3" x2="11.5" y2="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </template>
    <template v-else-if="family === 'exit'">
      <line x1="2.5" y1="3" x2="2.5" y2="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M5 7 L13 7 M10 4 L13 7 L10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </template>
    <template v-else-if="family === 'local'">
      <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.6" />
      <circle cx="7" cy="7" r="1.4" fill="currentColor" />
    </template>
    <template v-else-if="family === 'producer'">
      <path d="M2 4 L11 4 L11 9 L7 9 L4 11.5 L4 9 L2 9 Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      <path d="M9 7 L12.5 7 M11 5.5 L12.5 7 L11 8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </template>
    <template v-else-if="family === 'consumer'">
      <path d="M12 4 L3 4 L3 9 L7 9 L10 11.5 L10 9 L12 9 Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      <path d="M5 7 L1.5 7 M3 5.5 L1.5 7 L3 8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </template>
    <template v-else>
      <rect x="2.5" y="2.5" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" />
      <circle cx="7" cy="7" r="1.6" fill="currentColor" />
    </template>
  </svg>
</template>

<style scoped>
.kind-glyph {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
