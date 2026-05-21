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

/**
 * Global, per-session choice for how to render templates that diverge
 * between the local bundled copy and the OAP-stored (remote) copy:
 *
 *   - `remote` — render OAP's stored template (the live version everyone
 *     sees). Default.
 *   - `local`  — render the local bundled copy, so an operator can
 *     preview unpublished edits before pushing them with "Sync all".
 *
 * The choice is one global setting (applies to every diverged template)
 * and is **per login session**: it is cleared on login so the operator
 * is re-prompted each time. Backed by sessionStorage so it survives a
 * page reload within the same session but resets on re-login.
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';

export type TemplateRenderMode = 'local' | 'remote';

const SS_KEY = 'horizon:templateRenderMode';

function readStored(): TemplateRenderMode | null {
  if (typeof sessionStorage === 'undefined') return null;
  const v = sessionStorage.getItem(SS_KEY);
  return v === 'local' || v === 'remote' ? v : null;
}

export const useTemplatePreference = defineStore('template-preference', () => {
  /** `null` until the operator chooses (or is auto-defaulted). */
  const mode = ref<TemplateRenderMode | null>(readStored());

  function set(m: TemplateRenderMode): void {
    mode.value = m;
    try {
      sessionStorage.setItem(SS_KEY, m);
    } catch {
      /* sessionStorage unavailable — in-memory still works */
    }
  }

  /** Clear the choice so the next landing re-prompts. Called on login. */
  function reset(): void {
    mode.value = null;
    try {
      sessionStorage.removeItem(SS_KEY);
    } catch {
      /* noop */
    }
  }

  return { mode, set, reset };
});
