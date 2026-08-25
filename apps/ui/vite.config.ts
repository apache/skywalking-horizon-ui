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
import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import { templateCompilerOptions } from '@tresjs/core';

// Dev port for Vite itself. Default 9091; 9090 is commonly claimed by
// ClashX / proxy tools, and 8080 is reserved for the legacy booster-ui
// that operators may run side-by-side during migration. Override with
// UI_DEV_PORT when a developer needs a second parallel env.
const UI_DEV_PORT = Number(process.env.UI_DEV_PORT ?? 9091);

// Where the BFF listens during dev. The /api proxy below targets this.
// MUST match the `server.port` resolved by the BFF's HORIZON_CONFIG yaml
// (the yaml resolves the same env var via ${BFF_PORT:8081}), otherwise
// the proxy points at the wrong process. Prod is unaffected — there the
// BFF serves the built UI directly on its single configured port.
const BFF_PORT = Number(process.env.BFF_PORT ?? 8081);

// Deploy sub-path, baked into the bundle at BUILD time — it becomes
// `import.meta.env.BASE_URL`, which the router history, every API call and
// every asset URL resolve against. `HORIZON_UI_BASE=/horizon/ pnpm package`
// therefore produces an artifact for a gateway that serves Horizon at
// `/horizon/` and strips that prefix before forwarding to the BFF (the BFF
// itself always answers at the root). Build-only on purpose: the dev proxy
// below keys on a literal `/api`, so a prefixed dev server would send its
// API calls somewhere the proxy doesn't match.
const UI_BASE = ((): string => {
  const raw = process.env.HORIZON_UI_BASE?.trim();
  if (!raw) return '/';
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
})();

export default defineConfig(({ command }) => ({
  base: command === 'build' ? UI_BASE : '/',
  plugins: [
    // TresJS's template-compiler options tell Vue that any `<Tres*>` tag
    // (TresMesh, TresPerspectiveCamera, …) is a custom element handled
    // by the TresJS renderer, not a Vue component. Without this Vue
    // logs a `Failed to resolve component: TresPerspectiveCamera`
    // warning per Tres element on the 3D Infra Map route.
    vue({ ...templateCompilerOptions }),
    vueJsx(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Vitest reads this file, so the setup lives here rather than in a
  // `vitest.config.ts` — a separate config would replace this one and the
  // `@` alias with it.
  test: {
    // ABSOLUTE: `test:unit` passes `--root src/`, so a relative path would
    // resolve to `src/vitest.setup.ts` and fail to load.
    setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
  },
  server: {
    port: UI_DEV_PORT,
    strictPort: true,
    proxy: {
      // proxy to the BFF (`apps/bff`) during dev
      '/api': {
        target: `http://127.0.0.1:${BFF_PORT}`,
        changeOrigin: true,
      },
    },
  },
}));
