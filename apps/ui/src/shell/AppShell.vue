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
import { onMounted } from 'vue';
import { RouterView } from 'vue-router';
import AppSidebar from './AppSidebar.vue';
import AppTopbar from './AppTopbar.vue';
import GlobalConnectivityBanner from './GlobalConnectivityBanner.vue';
import TracePopout from '@/layer/traces/TracePopout.vue';
import ZipkinTracePopout from '@/layer/traces/ZipkinTracePopout.vue';
import { ensureConfigBundle } from '@/controls/configBundle';

// Kick the config preload once the shell mounts (i.e. after the auth
// guard has let the user through). All layer dashboard configs +
// overview list arrive in one round-trip and land in localStorage so
// subsequent navigations read configs synchronously — no per-page
// spinner for what's effectively static template content.
onMounted(() => {
  void ensureConfigBundle();
});
</script>

<template>
  <div class="sw">
    <AppSidebar />
    <AppTopbar />
    <main class="sw-main">
      <!-- Sticky strip under the topbar; only renders when the graphql
           (`:12800`) poll reports unreachable. Admin-port (`:17128`)
           failures render per-page via AdminFeatureWarning, not here. -->
      <GlobalConnectivityBanner />
      <RouterView />
    </main>
    <!-- Global trace-id popout: any page can call useTracePopout().openTrace(id)
         and this modal renders the waterfall + span detail. -->
    <TracePopout />
    <!-- Zipkin trace popout — separate URL key (`?openZipkinTraceId=`)
         so the native + Zipkin popouts can be open in parallel without
         collision (e.g. an operator drilling into a Zipkin trace from
         a Logs row → trace link on a mesh layer). -->
    <ZipkinTracePopout />
  </div>
</template>
