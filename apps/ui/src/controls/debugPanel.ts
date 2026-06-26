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
 * Visibility toggle for the bottom-of-page event panel. Defaults to
 * OFF everywhere — even on local dev hosts — so operators (and
 * developers reproducing operator issues) see the same baseline. Flip
 * it on via Admin → "Debug events" in the sidebar when needed.
 *
 * The choice is sticky per browser via localStorage so the operator
 * doesn't have to re-enable it on every reload.
 */

import { ref, watch } from 'vue';

const STORAGE_KEY = 'horizon:debugPanel:v1';

function detectInitial(): boolean {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  }
  return false;
}

const enabled = ref<boolean>(detectInitial());

watch(enabled, (on) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* private mode / quota — degrade silently */
  }
});

export function useDebugPanel(): {
  enabled: typeof enabled;
  toggle: () => void;
} {
  return {
    enabled,
    toggle: () => {
      enabled.value = !enabled.value;
    },
  };
}
