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
 * The OAuth consent screen — where an operator lends an external agent some of
 * their own access.
 *
 * It sits outside the AppShell for the same reason the login page does: this is
 * not somewhere to navigate, it is a decision with two exits, and a sidebar
 * offering a third would let someone wander off mid-grant leaving the client
 * waiting on a callback that never comes.
 *
 * The route requires auth, so the router guard sends an anonymous visitor to
 * Horizon's own login page and back — which is the whole reason the client
 * never sees a password, and why LDAP works here without this screen knowing
 * LDAP exists.
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import loginBgUrl from '@/assets/login-bg.jpg?url';
import { bff, type ConsentRequest } from '@/api/client';

const { t } = useI18n({ useScope: 'global' });
const route = useRoute();

const request = computed(() => (typeof route.query.request === 'string' ? route.query.request : ''));
const details = ref<ConsentRequest | null>(null);
const failure = ref('');
const deciding = ref(false);
const declined = ref(false);

onMounted(async () => {
  if (!request.value) {
    failure.value = t('This page was opened without an authorization request.');
    return;
  }
  try {
    details.value = await bff.oauth.consentRequest(request.value);
  } catch {
    failure.value = t('This authorization request has expired or is not valid. Start again from your client.');
  }
});

/**
 * Where the callback lands, shown so the operator can see it is their own
 * machine — a loopback address is the tell that the agent runs locally.
 *
 * A private-scheme redirect (`myapp://cb`, the other RFC 8252 form) has NO
 * host, so showing `.host` printed an empty box on the one line whose whole
 * job is telling you where your access is being sent. Those fall back to the
 * scheme, which is the meaningful part: it names the app the OS will hand it to.
 */
const redirectHost = computed(() => {
  const raw = details.value?.redirectUri ?? '';
  try {
    const u = new URL(raw);
    if (u.host) return u.host;
    return `${u.protocol.replace(/:$/, '')}:// (an app on this device)`;
  } catch {
    return raw;
  }
});

const readOnly = computed(() => !details.value?.scopes.includes('horizon:full'));

async function decide(approve: boolean): Promise<void> {
  if (deciding.value) return;
  deciding.value = true;
  try {
    const { redirectTo } = await bff.oauth.decide(request.value, approve);
    // A declined request with a REMOTE redirect deliberately comes back with
    // nowhere to go — the flow ends here rather than sending the operator to an
    // address a stranger registered. See the api scope for why.
    if (!redirectTo) {
      declined.value = true;
      deciding.value = false;
      return;
    }
    // Leave the SPA entirely — the next stop is the client's own callback.
    window.location.replace(redirectTo);
  } catch {
    failure.value = t('Could not complete the authorization. Start again from your client.');
    deciding.value = false;
  }
}
</script>

<template>
  <div class="stage" :style="{ backgroundImage: `url(${loginBgUrl})` }">
    <div class="dim" />
    <div class="wash" />

    <header class="top">
      <span class="brand">
        <!-- eslint-disable-next-line vue/no-v-html -- build-time `?raw` import of a bundled SVG constant; no runtime input reaches it, and scripts/check-security.mjs scans the ?raw set for active content -->
        <span class="brand-logo" v-html="logoSw" />
        <span class="brand-sep" aria-hidden="true" />
        <span class="brand-name">{{ t('Horizon') }}</span>
      </span>
    </header>

    <main class="center">
      <section class="card">
        <div v-if="failure" class="failure" role="alert">
          <b>{{ t('Authorization could not continue') }}</b>
          <p>{{ failure }}</p>
        </div>

        <div v-else-if="declined" class="failure" role="status">
          <b>{{ t('Nothing was shared') }}</b>
          <p>
            {{ t('You declined, and no access was given out. This page deliberately does not send you on to the application — you can close it.') }}
          </p>
        </div>

        <template v-else-if="details">
          <h1>{{ t('Connect an agent to Horizon') }}</h1>
          <p class="lede">
            <!-- The client's own registered name is untrusted text from an
                 unauthenticated registration call, so it renders as data
                 ({{ }}), never as markup, and is visibly quoted as a claim. -->
            <template v-if="details.clientName">
              {{ t('An application calling itself') }}
              <b class="client">{{ details.clientName }}</b>
              {{ t('is asking to read this Horizon as you.') }}
            </template>
            <template v-else>
              {{ t('An application is asking to read this Horizon as you.') }}
            </template>
          </p>

          <dl class="facts">
            <div v-if="details.clientUrl">
              <dt>{{ t('Verified identity') }}</dt>
              <dd><code>{{ details.clientUrl }}</code></dd>
            </div>
            <div>
              <dt>{{ t('Signed in as') }}</dt>
              <dd>
                <b>{{ details.username }}</b>
                <span v-if="details.roles.length" class="roles">{{ details.roles.join(', ') }}</span>
              </dd>
            </div>
            <div>
              <dt>{{ t('Sends the result to') }}</dt>
              <dd><code>{{ redirectHost }}</code></dd>
            </div>
            <div>
              <dt>{{ t('Access') }}</dt>
              <dd>
                <span class="badge" :class="readOnly ? 'badge-read' : 'badge-full'">
                  {{ readOnly ? t('Read-only') : t('Everything you can do') }}
                </span>
              </dd>
            </div>
          </dl>

          <p v-if="!details.clientUrl" class="note caution">
            {{ t('Nothing here proves the application is what it says. Any program can register under any name, so check that the destination above is one you expect — and if you did not just start this yourself, cancel.') }}
          </p>

          <p class="note">
            {{ t('It can never see more than you can. Your permissions are checked again on every request, so this access shrinks when yours does and ends when your account is removed.') }}
          </p>

          <div class="actions">
            <button type="button" class="btn ghost" :disabled="deciding" @click="decide(false)">
              {{ t('Cancel') }}
            </button>
            <button type="button" class="btn primary" :disabled="deciding" @click="decide(true)">
              {{ deciding ? t('Connecting…') : t('Allow') }}
            </button>
          </div>
        </template>

        <p v-else class="loading">{{ t('Reading data…') }}</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.stage {
  position: fixed;
  inset: 0;
  background-size: cover;
  background-position: center;
  display: flex;
  flex-direction: column;
}
.dim,
.wash {
  position: absolute;
  inset: 0;
}
.dim {
  background: rgb(6 10 16 / 82%);
  backdrop-filter: saturate(60%);
}
.wash {
  background: linear-gradient(160deg, rgb(255 138 60 / 10%), rgb(10 16 26 / 60%));
}
.top {
  position: relative;
  display: flex;
  align-items: center;
  padding: 20px 28px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.brand-logo :deep(svg) {
  height: 22px;
  width: auto;
  fill: #fff;
}
.brand-sep {
  width: 1px;
  height: 16px;
  background: rgb(255 255 255 / 28%);
}
.brand-name {
  color: #fff;
  font-size: 14px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.center {
  position: relative;
  flex: 1;
  display: grid;
  place-items: center;
  padding: 16px;
}
.card {
  width: min(520px, 100%);
  padding: 28px 30px 24px;
  border-radius: var(--radius-lg, 12px);
  border: 1px solid rgb(255 255 255 / 12%);
  background: rgb(14 20 30 / 88%);
  backdrop-filter: blur(14px);
  color: var(--text-1, #e8edf5);
  box-shadow: 0 24px 60px rgb(0 0 0 / 45%);
}
h1 {
  margin: 0 0 10px;
  font-size: 19px;
  font-weight: 650;
}
.lede {
  margin: 0 0 20px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2, #a9b4c6);
}
.client {
  color: var(--text-1, #e8edf5);
}
.facts {
  margin: 0 0 18px;
  display: grid;
  gap: 1px;
  background: rgb(255 255 255 / 8%);
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: 8px;
  overflow: hidden;
}
.facts > div {
  display: grid;
  grid-template-columns: 150px 1fr;
  gap: 12px;
  align-items: baseline;
  padding: 10px 14px;
  background: rgb(10 16 26 / 92%);
}
dt {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-3, #7b879b);
}
dd {
  margin: 0;
  font-size: 13px;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.roles,
code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--text-2, #a9b4c6);
}
.badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.badge-read {
  background: rgb(80 170 255 / 16%);
  color: #8fc6ff;
}
.badge-full {
  background: rgb(255 150 60 / 18%);
  color: #ffb672;
}
.note {
  margin: 0 0 22px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3, #7b879b);
}
/* Only for the unverified-client warning — the same size, so it reads as a
   caution rather than shouting over the grant itself. */
.note.caution {
  margin-bottom: 12px;
  padding-left: 10px;
  border-left: 2px solid var(--warn, #d9822b);
  color: var(--text-2, #9aa7bd);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.btn {
  padding: 9px 20px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.ghost {
  background: transparent;
  border-color: rgb(255 255 255 / 18%);
  color: var(--text-2, #a9b4c6);
}
.primary {
  background: var(--accent, #ff8a3c);
  color: #10151d;
}
.failure b {
  display: block;
  margin-bottom: 8px;
  font-size: 15px;
}
.failure p,
.loading {
  margin: 0;
  font-size: 13px;
  color: var(--text-2, #a9b4c6);
}
</style>
