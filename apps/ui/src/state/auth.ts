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
import { resetSessionState } from '@/state/sessionReset';
import { i18n } from '@/i18n';
import { canonicalLayerKey, hasPlainVerb, layerGrantCovers, parseLayerGrant, type LayerGrant } from './verbGrammar';
import { parseEntryKey } from '@/utils/layerRoute';

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
    // Before the request, not after: whatever a previous session left behind
    // (a logout that never reached the BFF, a 401 handled while the tab was
    // backgrounded) must be gone by the time `user` names the new operator,
    // or their first render is served the previous one's cached responses.
    resetSessionState();
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
    endSession();
  }

  /**
   * Tear down the local session: forget the user AND every cached response
   * read under it. Called by {@link logout} and by the BFF client's 401 hook
   * (a session the server ended mid-flight — there is no logout call left to
   * make). Both statements run in one tick so nothing can refetch in between
   * while `isAuthenticated` is still true.
   */
  function endSession(): void {
    user.value = null;
    resetSessionState();
  }

  // The BFF's `SessionAccess`, advisory here — the BFF enforces, but this gate
  // must agree with it, or it hides controls the server allows and shows ones
  // it denies. An OAuth credential's `verbCap` narrows by verb, never by layer.
  function capAllows(verb: string): boolean {
    const cap = user.value?.verbCap;
    return cap ? hasPlainVerb(cap, verb) : true;
  }

  /** The plain question: a grant written with `@` never answers it. */
  function hasVerb(verb: string): boolean {
    return capAllows(verb) && hasPlainVerb(user.value?.verbs ?? [], verb);
  }

  function layerGrantsFor(verb: string): LayerGrant[] {
    if (!capAllows(verb)) return [];
    const out: LayerGrant[] = [];
    for (const g of user.value?.verbs ?? []) {
      const parsed = g.includes('@') ? parseLayerGrant(g) : null;
      if (parsed && layerGrantCovers(parsed, verb)) out.push(parsed);
    }
    return out;
  }

  /**
   * May the session use `verb` on this layer's pages? A plain grant reaches
   * every layer except an operate one (Platform monitoring), which also needs
   * `cluster:read`; a `verb@LAYER` grant reaches exactly its layer. `layerKey`
   * may be a split layer's entry key, and then the grant must also reach that
   * group. On a whole layer, group limits are left to the BFF,
   * which drops the roster rows they exclude.
   */
  function hasVerbOnLayer(verb: string, layerKey: string, operate = false): boolean {
    if (hasVerb(verb) && (!operate || hasVerb('cluster:read'))) return true;
    const { layer, group } = parseEntryKey(layerKey);
    const key = canonicalLayerKey(layer);
    return layerGrantsFor(verb).some(
      (g) => canonicalLayerKey(g.layer) === key && (group === undefined || !g.groups || g.groups.includes(group)),
    );
  }

  /** Held plainly or on at least one layer — for a read whose layer is only
   *  known to the BFF (a trace opened by id). */
  function hasVerbOnSomeLayer(verb: string): boolean {
    return hasVerb(verb) || layerGrantsFor(verb).length > 0;
  }

  /** The layers a layer-limited verb reaches; null when it is held plainly,
   *  which reaches them all. */
  function layersFor(verb: string): string[] | null {
    if (hasVerb(verb)) return null;
    return [...new Set(layerGrantsFor(verb).map((g) => canonicalLayerKey(g.layer)))];
  }

  /** Held only through layer grants: the BFF refuses such a caller any read
   *  that names no service, so pickers must not offer "all services". */
  function layerLimited(verb: string): boolean {
    return !hasVerb(verb) && layerGrantsFor(verb).length > 0;
  }

  return {
    user,
    bootstrapping,
    loginError,
    isAuthenticated: computed(() => user.value !== null),
    bootstrap,
    login,
    logout,
    endSession,
    hasVerb,
    hasVerbOnLayer,
    hasVerbOnSomeLayer,
    layerLimited,
    layersFor,
  };
});
