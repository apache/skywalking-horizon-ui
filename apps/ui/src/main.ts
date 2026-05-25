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
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

import App from './App.vue';
import router from './shell/router/index';
import { bffClient } from './api/client';
import { useAuthStore } from './state/auth';
import { useThemeStore } from './state/theme';
import { i18n } from './i18n';

import '@skywalking-horizon-ui/design-tokens/tokens.css';
// The theme-variant overrides — `[data-theme="<id>"]` selectors that swap
// `--sw-*` palette tokens. The Pinia themeStore writes the active id to
// `<html data-theme>` on mount and on every user / org change. Loading
// this AFTER tokens.css preserves the cascade order (variant overrides
// the default).
import '@skywalking-horizon-ui/design-tokens/themes.css';
import './assets/styles/global.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);
app.use(VueQueryPlugin, { queryClient });
// i18n is registered AFTER Pinia so locale-aware stores can read the
// initial locale (resolved from localStorage / navigator) at construction
// time, but BEFORE the router and any feature views render — every
// `t(...)` call in the tree resolves through this instance.
app.use(i18n);

// Instantiate the theme store eagerly so its `watch(immediate:true)`
// fires once at bootstrap. That writes `<html data-theme="…">` and
// `data-appearance="…"` BEFORE any view (including the pre-auth
// LoginView) renders, so the operator's localStorage theme override
// applies to every page — not just the post-login surfaces inside
// AppShell. Pinia stores are lazy by default; without this line the
// login page falls through to the `:root` Horizon palette regardless
// of what the operator picked. The org-default tier (OAP-stored
// `horizon.theme.active`) is still loaded later from AppShell once
// auth is through; pre-auth, only the user-override + bundled tiers
// resolve.
useThemeStore();

// Mid-session 401 → clear auth state and bounce to login while preserving the
// current path so the user can be returned after re-auth.
bffClient.setOn401(() => {
  const auth = useAuthStore();
  auth.$patch({ user: null });
  const redirect = router.currentRoute.value.fullPath;
  if (router.currentRoute.value.name !== 'login') {
    void router.push({ name: 'login', query: { redirect } });
  }
});

app.mount('#app');
