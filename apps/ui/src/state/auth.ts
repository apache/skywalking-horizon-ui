/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { BffApiError, bffClient, type MeResponse } from '@/api/client';
import { useTemplatePreference } from '@/controls/templatePreference';
import { i18n } from '@/i18n';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<MeResponse | null>(null);
  const bootstrapping = ref(true);
  const loginError = ref<string | null>(null);

  async function bootstrap(): Promise<void> {
    bootstrapping.value = true;
    try {
      user.value = await bffClient.session.me();
    } catch {
      user.value = null;
    } finally {
      bootstrapping.value = false;
    }
  }

  async function login(username: string, password: string): Promise<boolean> {
    loginError.value = null;
    try {
      user.value = await bffClient.session.login(username, password);
      // New login session → re-prompt the local-vs-remote template choice.
      useTemplatePreference().reset();
      // Clear the per-session "unpublished local edits" prompt dismissal
      // so a fresh login sees the reminder reliably. Without this, a
      // dismissal from an earlier session in the same browser tab keeps
      // the modal hidden across the logout / login boundary — operators
      // log back in to find drafts they pushed nothing about.
      try {
        sessionStorage.removeItem('horizon:localDraftPrompt:dismissed');
      } catch {
        /* private mode — module-level state still resets on AppShell re-mount */
      }
      return true;
    } catch (err) {
      // Use the i18n global directly because this store can be called
      // outside a setup context (router guards, fetch interceptors).
      const t = i18n.global.t;
      if (err instanceof BffApiError && err.status === 401) {
        loginError.value = t('Invalid username or password.');
      } else {
        loginError.value = err instanceof Error ? err.message : t('login failed');
      }
      user.value = null;
      return false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await bffClient.session.logout();
    } catch {
      // swallow — even if logout fails we clear local state
    }
    user.value = null;
  }

  function hasVerb(verb: string): boolean {
    const grants = user.value?.verbs ?? [];
    for (const g of grants) {
      if (g === '*' || g === verb) return true;
      const [ga, gact] = g.split(':', 2);
      const [ra, ract] = verb.split(':', 2);
      if (gact === '*' && ga === ra) return true;
      if (ga === '*' && gact === ract) return true;
    }
    return false;
  }

  return {
    user,
    bootstrapping,
    loginError,
    isAuthenticated: computed(() => user.value !== null),
    bootstrap,
    login,
    logout,
    hasVerb,
  };
});
