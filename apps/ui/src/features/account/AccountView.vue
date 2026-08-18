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
 * The signed-in operator's own account.
 *
 * Read-only, and deliberately says nothing about passwords. Horizon has no
 * password-mutation capability anywhere, and for an SSO or token session there
 * is no Horizon password to speak of at all — a section headed "Password"
 * implies one can be seen or changed here, and neither is true. Where the
 * credential lives follows from "Signed in with".
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/state/auth';

const { t } = useI18n({ useScope: 'global' });
const auth = useAuthStore();
const router = useRouter();

const user = computed(() => auth.user);
const shownName = computed(() => user.value?.displayName || user.value?.username || '');
const initials = computed(() => shownName.value.slice(0, 2).toUpperCase() || '?');

/** The provider's own label when SSO named one, so the page reads "Google"
 *  rather than a config id. */
const providerLabel = computed(() => user.value?.providerName || user.value?.provider || '');

/** The widest possible account carries the NARROWEST-looking verb list: a
 *  single `*`. Anything that counts or lists it verbatim says "one", which is
 *  the opposite of what it grants. */
const isWildcard = computed(() => (user.value?.verbs ?? []).includes('*'));

const methodLabel = computed(() => {
  switch (user.value?.authSource) {
    case 'ldap': return t('Directory (LDAP)');
    case 'sso': return providerLabel.value
      ? t('Single sign-on via {provider}', { provider: providerLabel.value })
      : t('Single sign-on');
    case 'break-glass': return t('Break-glass account');
    case 'api-token': return t('API token');
    case 'oauth-token': return t('Agent token');
    case 'local': return t('Local account');
    default: return t('Unknown');
  }
});


function signOut(): void {
  void auth.logout().then(() => router.push('/login'));
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="crumbs">
        <span class="crumb-cur">{{ t('Account') }}</span>
      </div>
      <div class="head-actions">
        <button class="sw-btn" type="button" @click="signOut">{{ t('Sign out') }}</button>
      </div>
    </header>

    <div v-if="!user" class="loading">{{ t('Not signed in.') }}</div>
    <template v-else>
      <div class="head-card">
        <div class="head-left">
          <div class="status-glyph">{{ initials }}</div>
          <div>
            <div class="status-title">{{ shownName }}</div>
            <div class="status-sub">{{ methodLabel }}</div>
          </div>
        </div>
      </div>

      <section class="sw-card">
        <header class="card-head"><h3>{{ t('Identity') }}</h3></header>
        <table class="kv">
          <tbody>
            <tr v-if="user.displayName">
              <td class="k">{{ t('Display name') }}</td>
              <td class="v">{{ user.displayName }}</td>
            </tr>
            <tr>
              <td class="k">{{ t('Username') }}</td>
              <td class="v"><code>{{ user.username }}</code></td>
            </tr>
            <tr>
              <td class="k">{{ t('Signed in with') }}</td>
              <td class="v">{{ methodLabel }}</td>
            </tr>
            <tr v-if="user.authSource === 'sso' && providerLabel">
              <td class="k">{{ t('Identity provider') }}</td>
              <td class="v">{{ providerLabel }}</td>
            </tr>
          </tbody>
        </table>
        <div class="card-foot muted small">
          {{ t('Your username is your identity here, and your roles are resolved from it rather than stored against you. A token you hold re-reads them on every request, so removing you from the directory or configuration ends it at once. This browser session keeps the roles it was given until you sign in again.') }}
        </div>
      </section>


      <section class="sw-card">
        <header class="card-head">
          <h3>{{ t('Roles and verbs') }}</h3>
          <span class="muted small">{{ t('Granted by your operator, not editable here') }}</span>
        </header>
        <table class="kv">
          <tbody>
            <tr>
              <td class="k">{{ t('Roles') }}</td>
              <td class="v">
                <span v-for="r in user.roles" :key="r" class="pill">{{ r }}</span>
                <span v-if="!user.roles.length" class="muted">{{ t('None') }}</span>
              </td>
            </tr>
            <tr>
              <td class="k">{{ t('Granted verbs') }}</td>
              <td class="v">
                <template v-if="isWildcard">
                  <span class="pill">{{ t('All verbs') }}</span>
                  <div class="muted small wild">
                    {{ t('This role holds the wildcard verb, so every verb is granted — including any a future version adds.') }}
                  </div>
                </template>
                <template v-else>
                  <span v-for="v in user.verbs" :key="v" class="pill mono">{{ v }}</span>
                  <span v-if="!user.verbs.length" class="muted">{{ t('None') }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page { padding: 18px 22px 32px; color: var(--sw-fg-0); }
.page-head { display: flex; align-items: center; margin-bottom: 16px; }
.crumbs { font-size: var(--sw-fs-base); color: var(--sw-fg-2); }
.crumb-cur { color: var(--sw-fg-0); font-weight: var(--sw-fw-semibold); }
.head-actions { margin-left: auto; display: flex; gap: 8px; }
.loading { padding: 20px; text-align: center; color: var(--sw-fg-2); }

.head-card {
  display: flex;
  align-items: center;
  padding: 14px 18px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  margin-bottom: 14px;
  gap: 16px;
}
.head-left { display: flex; align-items: center; gap: 12px; }
.status-glyph {
  width: 40px; height: 40px;
  border-radius: 8px;
  display: grid; place-items: center;
  background: var(--sw-bg-3);
  color: var(--sw-fg-1);
  font-weight: var(--sw-fw-bold); font-size: var(--sw-fs-base);
}
.status-title { font-size: 16px; font-weight: var(--sw-fw-bold); color: var(--sw-fg-0); }
.status-sub { font-size: var(--sw-fs-sm); color: var(--sw-fg-2); margin-top: 2px; }


.sw-card {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 14px;
}
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
}
.card-head h3 { margin: 0; font-size: var(--sw-fs-base); font-weight: var(--sw-fw-semibold); color: var(--sw-fg-0); }
.card-foot {
  padding: 10px 14px;
  border-top: 1px solid var(--sw-line);
  line-height: 1.5;
}
.muted { color: var(--sw-fg-3); font-size: var(--sw-fs-sm); }
.muted.small { font-size: var(--sw-fs-xs); }
.mono { font-family: var(--sw-mono); }

table.kv { width: 100%; border-collapse: collapse; }
.kv .k {
  width: 32%;
  padding: 8px 14px;
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-sm);
  vertical-align: top;
  border-bottom: 1px solid var(--sw-line);
}
.kv .v {
  padding: 8px 14px;
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-base);
  border-bottom: 1px solid var(--sw-line);
}
.kv tr:last-child .k, .kv tr:last-child .v { border-bottom: none; }
.kv code { font-family: var(--sw-mono); font-size: var(--sw-fs-sm); color: var(--sw-fg-0); }

.wild { margin-top: 6px; line-height: 1.5; }
.pill {
  display: inline-block;
  padding: 2px 8px;
  margin: 2px 6px 2px 0;
  border-radius: 999px;
  background: var(--sw-bg-3);
  border: 1px solid var(--sw-line);
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-1);
}
</style>
