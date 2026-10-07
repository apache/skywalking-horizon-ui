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
  "Inline | Pop out" switch for the log streams: what a click on a row
  does. It edits the shared per-browser choice every LogStreamPanel reads,
  so a host only has to place it in the header above its stream.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useLogOpenMode } from './useLogOpenMode';

const { t } = useI18n({ useScope: 'global' });
const mode = useLogOpenMode();
</script>

<template>
  <div class="lo-seg" role="group" :aria-label="t('Open a clicked log')">
    <button
      type="button"
      :class="{ on: mode === 'inline' }"
      :aria-pressed="mode === 'inline'"
      :title="t('Expand a clicked log in place')"
      @click="mode = 'inline'"
    >{{ t('Inline') }}</button>
    <button
      type="button"
      :class="{ on: mode === 'popout' }"
      :aria-pressed="mode === 'popout'"
      :title="t('Open a clicked log in a popout')"
      @click="mode = 'popout'"
    >{{ t('Pop out') }}</button>
  </div>
</template>

<style scoped>
.lo-seg {
  display: inline-flex;
  flex: 0 0 auto;
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  overflow: hidden;
}
.lo-seg button {
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  border: none;
  height: 22px;
  padding: 0 10px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.lo-seg button + button { border-left: 1px solid var(--sw-line-2); }
.lo-seg button:hover:not(.on) { color: var(--sw-fg-0); }
.lo-seg button.on { background: var(--sw-accent); color: #fff; }
</style>
