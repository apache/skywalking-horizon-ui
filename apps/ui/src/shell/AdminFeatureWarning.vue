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
 * Per-page warning header for admin-host routes (DSL Management,
 * Live Debugger, Dump, OAL viewer, Inspect).
 *
 * Renders when the admin host (`:17128`) is unreachable, OR when the
 * caller-named module's SWIP-13 selector is off on OAP. The page
 * body still mounts below — most of the admin-host UIs degrade
 * cleanly to an empty / read-only state when the API is missing.
 *
 * Two failure shapes:
 *   - admin host unreachable → "fix network / port / SW_ADMIN_SERVER"
 *   - admin reachable but specific module off → "set SW_<MODULE>=default"
 *
 * The component picks the right copy automatically based on
 * `useAdminFeatures()` state and the `module` prop.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAdminFeatures } from '@/shell/useAdminFeatures';
import Icon from '@/components/icons/Icon.vue';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{
  /** OAP module name this page depends on. One of:
   *  `receiver-runtime-rule` · `dsl-debugging` · `inspect`. The
   *  `admin-server` module is implicit — every page that uses this
   *  banner needs it. */
  module: 'receiver-runtime-rule' | 'dsl-debugging' | 'inspect';
  /** Short human label of the feature this page provides. Used in
   *  the warning copy ("DSL Management requires …"). */
  featureLabel: string;
}>();

const { result, adminReachable, adminError, adminUrl, moduleByName, refetch } =
  useAdminFeatures();

const mod = moduleByName(props.module);
const moduleEnabled = computed<boolean>(() => mod.value?.enabled ?? false);

/** Hide when everything is fine — admin reachable AND target module
 *  on. Loading state also hides (page renders normally; banner pops
 *  in if/when preflight returns a failure). */
const visible = computed<boolean>(() => {
  if (!result.value) return false;
  if (!adminReachable.value) return true;
  return !moduleEnabled.value;
});

const kind = computed<'host' | 'module'>(() =>
  !adminReachable.value ? 'host' : 'module',
);

const moduleEnvVar = computed<string | undefined>(() => mod.value?.envVar);
</script>

<template>
  <div v-if="visible" class="warn" role="alert">
    <span class="icon"><Icon name="alert" :size="14" /></span>

    <div class="body">
      <!-- Admin host unreachable: full-stop, network / port issue -->
      <template v-if="kind === 'host'">
        <h3>{{ t('Admin host unreachable') }}</h3>
        <p>
          <strong>{{ featureLabel }}</strong> {{ t('talks to OAP on the admin port') }}
          (<code>{{ adminUrl ?? ':17128' }}</code>). {{ t('The page below is rendered read-only and will fail any save / debug action.') }}
        </p>
        <p v-if="adminError" class="err">
          {{ t('Last error') }}: <code>{{ adminError }}</code>
        </p>
        <ul class="hints">
          <li>
            {{ t("Confirm OAP's") }} <code>admin-server</code> {{ t('module is on') }}
            (<code>SW_ADMIN_SERVER=default</code>) {{ t('and the OAP pod has been restarted.') }}
          </li>
          <li>
            {{ t('Confirm the admin port (default') }} <code>17128</code>) {{ t('is exposed on the network / k8s Service / ingress and reachable from this BFF.') }}
          </li>
          <li>
            {{ t('See') }} <RouterLink to="/operate/cluster">{{ t('Cluster status') }}</RouterLink>
            {{ t('for the full module preflight.') }}
          </li>
        </ul>
      </template>

      <!-- Admin host fine, but this feature's specific module is off -->
      <template v-else>
        <h3>{{ t('Module') }} <code>{{ module }}</code> {{ t('is off on OAP') }}</h3>
        <p>
          <strong>{{ featureLabel }}</strong> {{ t('requires the') }}
          <code>{{ module }}</code> {{ t('module. Enable it on OAP and restart:') }}
        </p>
        <pre class="env">{{ moduleEnvVar }}=default</pre>
        <p class="hint">
          {{ t('Until then this page renders read-only — every API call to') }}
          <code>{{ adminUrl }}</code> {{ t('for this feature returns 404.') }}
          {{ t('See') }} <RouterLink to="/operate/cluster">{{ t('Cluster status') }}</RouterLink>
          {{ t('for the full module preflight.') }}
        </p>
      </template>
    </div>

    <button type="button" class="recheck" @click="() => refetch()">{{ t('re-check') }}</button>
  </div>
</template>

<style scoped>
.warn {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin: 14px 20px 18px;
  padding: 14px 16px;
  background: var(--sw-warn-soft);
  border: 1px solid rgba(234, 179, 8, 0.4);
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
  background: rgba(234, 179, 8, 0.22);
  color: var(--sw-warn);
  flex-shrink: 0;
  margin-top: 1px;
}
.body {
  flex: 1;
  min-width: 0;
}
.body h3 {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--sw-warn);
  margin: 0 0 6px;
  letter-spacing: -0.01em;
}
.body p {
  font-size: 12px;
  margin: 0 0 6px;
  line-height: 1.55;
  color: var(--sw-fg-1);
}
.body p.err {
  color: var(--sw-fg-2);
  font-size: 11.5px;
}
.body p.hint {
  color: var(--sw-fg-2);
  font-size: 11.5px;
  margin-top: 6px;
}
.body code {
  font-family: var(--sw-mono);
  background: rgba(0, 0, 0, 0.25);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11.5px;
  color: var(--sw-fg-0);
}
.body strong {
  color: var(--sw-fg-0);
  font-weight: 600;
}
.body .env {
  display: inline-block;
  margin: 4px 0 8px;
  font-family: var(--sw-mono);
  font-size: 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  padding: 6px 10px;
  color: var(--sw-fg-0);
}
.hints {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--sw-fg-1);
  font-size: 11.5px;
  line-height: 1.7;
}
.hints a {
  color: var(--sw-accent);
  text-decoration: none;
}
.hints a:hover {
  text-decoration: underline;
}
.recheck {
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(234, 179, 8, 0.4);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
  padding: 5px 10px;
  border-radius: 5px;
  cursor: pointer;
  flex-shrink: 0;
}
.recheck:hover {
  background: rgba(0, 0, 0, 0.4);
}
</style>
