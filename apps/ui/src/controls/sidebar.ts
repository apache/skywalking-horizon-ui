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
 * Collapse state for the main navigation sidebar. Shared between the
 * shell grid (AppShell drives the `.sw` column width) and the sidebar
 * itself (AppSidebar renders the expand/collapse affordance). Sticky
 * per browser via localStorage so the operator's fold choice survives
 * reloads. Defaults expanded.
 */

import { ref, watch } from 'vue';

const STORAGE_KEY = 'horizon:sidebarCollapsed:v1';

function detectInitial(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === '1';
}

const collapsed = ref<boolean>(detectInitial());

watch(collapsed, (on) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* private mode / quota — degrade silently */
  }
});

export function useSidebar(): {
  collapsed: typeof collapsed;
  toggle: () => void;
} {
  return {
    collapsed,
    toggle: () => {
      collapsed.value = !collapsed.value;
    },
  };
}
