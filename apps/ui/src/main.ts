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
import router from './router';
import { bffClient } from './api/client';
import { useAuthStore } from './stores/auth';

import '@skywalking-horizon-ui/design-tokens/tokens.css';
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
