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

// Singleton surface state (open + one-shot first-run hint) for the launcher + drawer,
// shared like useTracePopout/useEventsPopout. `available` gates on auth AND the server's
// `ready` flag (feature enabled + a usable provider); `starters` are server-supplied
// (bundled defaults or the operator's `ai.starters`).
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useAuthStore } from '@/state/auth';
import { bff, type AiConfigResponse } from '@/api/client';

const HINT_SEEN_KEY = 'sw.ai.hintSeen';

function readHintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

// Module-level singleton state (survives route changes, shared across callers).
const openState = ref(false);
const hintSeen = ref<boolean>(readHintSeen());
const aiConfig = ref<AiConfigResponse | null>(null);
let configLoading = false;

/** Load `/api/ai/config` once per session (idempotent). Soft-fails to
 *  not-ready so a probe error just hides the launcher rather than throwing. */
async function ensureConfig(): Promise<void> {
  if (aiConfig.value || configLoading) return;
  configLoading = true;
  try {
    aiConfig.value = await bff.ai.config();
  } catch {
    // Leave aiConfig null (launcher stays hidden) so a later probe — the auth
    // watch, or the next mount — can retry after a transient / pre-auth failure.
  } finally {
    configLoading = false;
  }
}

export interface AiChatController {
  /** Whether the slide-over panel is open. */
  open: Ref<boolean>;
  /** Whether the launcher + panel are shown — any authenticated user. */
  available: ComputedRef<boolean>;
  /** Whether the assistant can actually chat (feature enabled + a usable
   *  provider). When false, the panel is read-only with a setup notice. */
  ready: ComputedRef<boolean>;
  /** Whether the operator has enabled the AI feature at all (`ai.enabled`). */
  enabled: ComputedRef<boolean>;
  /** Whether to play the first-run attention nudge on the launcher. */
  showHint: ComputedRef<boolean>;
  /** Server-supplied starter prompts (empty until config loads). */
  starters: ComputedRef<string[]>;
  /** Fetch the AI config once (call from the launcher on mount / auth change). */
  ensureConfig: () => Promise<void>;
  openPanel: () => void;
  closePanel: () => void;
  toggle: () => void;
  /** Mark the first-run hint as seen (persisted). */
  dismissHint: () => void;
}

export function useAiChat(): AiChatController {
  const auth = useAuthStore();
  // The launcher + panel show for ANY authenticated user — to surface the
  // AI-powered APM to everyone. `ai:read` is default for all roles; a user
  // without it (custom RBAC) still sees the launcher and just gets the chat
  // request rejected on send. `ready` (feature enabled + a usable provider)
  // gates whether the panel can chat vs. show a read-only "ask your admin"
  // setup notice.
  const available = computed<boolean>(() => auth.isAuthenticated);
  const ready = computed<boolean>(() => aiConfig.value?.ready ?? false);
  const enabled = computed<boolean>(() => aiConfig.value?.enabled ?? false);
  // Only nudge with the first-run hint when the assistant actually works —
  // don't draw attention to a read-only, not-yet-configured panel.
  const showHint = computed<boolean>(() => ready.value && !hintSeen.value);
  const starters = computed<string[]>(() => aiConfig.value?.starters ?? []);

  function dismissHint(): void {
    if (hintSeen.value) return;
    hintSeen.value = true;
    try {
      localStorage.setItem(HINT_SEEN_KEY, '1');
    } catch {
      /* private-mode / storage-disabled: the nudge just replays next load */
    }
  }

  function openPanel(): void {
    openState.value = true;
    dismissHint();
  }
  function closePanel(): void {
    openState.value = false;
  }
  function toggle(): void {
    if (openState.value) closePanel();
    else openPanel();
  }

  return { open: openState, available, ready, enabled, showHint, starters, ensureConfig, openPanel, closePanel, toggle, dismissHint };
}
