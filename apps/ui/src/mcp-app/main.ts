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
 * Entry point for the `ui://` bundle — a second, standalone build of the same
 * card renderers the chat panel uses.
 *
 * It supplies inside the sandbox everything those components normally get from
 * the app shell: Pinia, vue-query, i18n, the design tokens. The one thing it
 * does NOT supply is network access, and that is the design working rather than
 * a limitation — every card is a captured replay, so the composables run with
 * `enabled: false` and render from `replayData` without a fetch.
 */

import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createRouter, createMemoryHistory } from 'vue-router';

import McpApp from './McpApp.vue';
import { i18n } from '@/i18n';

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@skywalking-horizon-ui/design-tokens/tokens.css';
import '@skywalking-horizon-ui/design-tokens/themes.css';
import '@/assets/styles/global.css';

// A host frames this document on its own background, so the bundle paints its
// own — a transparent body would borrow whatever is behind it and render dark
// text on dark chrome in half the hosts.
document.documentElement.dataset.theme = 'dark';

/**
 * Queries are OFF by default here, and that is the load-bearing line.
 *
 * The views render from `replayData` and gate their own queries on `replay`,
 * but a few composables they pull in do not know about replay at all —
 * `useLayers` fetches the menu on mount and again every 60 s. In the panel that
 * is free (the shell already cached it); in a sandbox with no network it is a
 * failed request, and it breaks the property this whole design rests on: a
 * captured card renders from what was captured, with zero fetches, so the host
 * needs to grant no CSP exception at all.
 *
 * Disabling at the client is what makes that structural rather than a promise
 * every future composable has to keep.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      enabled: false,
      retry: false,
      refetchInterval: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      staleTime: Infinity,
    },
  },
});

/**
 * A router with nowhere to go. Several embedded views call `useRoute()` for
 * their own query params; without an installed router that returns undefined
 * and setup dies with a TypeError, leaving a blank card and no clue. Memory
 * history because there is no URL bar in a sandboxed frame to keep in sync.
 */
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:catchAll(.*)*', component: { render: () => h('div') } }],
});

createApp(McpApp)
  .use(createPinia())
  .use(VueQueryPlugin, { queryClient })
  .use(router)
  .use(i18n)
  .mount('#app');
