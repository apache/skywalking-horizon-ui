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
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const submitting = ref(false);

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const ok = await auth.login(username.value, password.value);
    if (ok) {
      const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
      await router.push(redirect);
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="submit">
      <div class="brand">
        <span class="brand-logo" v-html="logoSw" />
        <div class="brand-sub">Horizon UI</div>
      </div>

      <label class="field">
        <span>Username</span>
        <input
          v-model="username"
          type="text"
          name="username"
          autocomplete="username"
          autofocus
          required
        />
      </label>

      <label class="field">
        <span>Password</span>
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          required
        />
      </label>

      <div v-if="auth.loginError" class="error">{{ auth.loginError }}</div>

      <button class="sw-btn is-primary submit" type="submit" :disabled="submitting">
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>

      <div class="foot">
        Local + LDAP auth. OIDC and SSO are out of scope for v1.
      </div>
    </form>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background:
    radial-gradient(1200px 600px at 20% 10%, rgba(249, 115, 22, 0.06), transparent 60%),
    radial-gradient(900px 500px at 100% 90%, rgba(168, 85, 247, 0.06), transparent 60%),
    var(--sw-bg-0);
}
.login-card {
  width: 440px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 12px;
  padding: 36px 36px 26px;
  box-shadow: 0 32px 80px -28px rgba(0, 0, 0, 0.7);
}
.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-bottom: 28px;
}
.brand-logo {
  display: inline-flex;
  color: var(--sw-fg-0);
}
.brand-logo :deep(svg) {
  height: 44px;
  width: auto;
  display: block;
}
.brand-sub {
  font-size: 12px;
  color: var(--sw-fg-2);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 500;
}
.field {
  display: block;
  margin-bottom: 14px;
}
.field span {
  display: block;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-2);
  margin-bottom: 7px;
}
.field input {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 7px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 14px;
  outline: none;
  transition: border-color 0.1s;
}
.field input:focus {
  border-color: var(--sw-accent-line);
}
.error {
  margin: 8px 0 12px;
  padding: 8px 10px;
  background: var(--sw-err-soft);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  font-size: 12px;
}
.submit {
  width: 100%;
  height: 40px;
  margin-top: 10px;
  font-size: 14px;
  font-weight: 600;
}
.submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.foot {
  margin-top: 18px;
  font-size: 11px;
  color: var(--sw-fg-3);
  text-align: center;
  line-height: 1.5;
}
</style>
