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

export default defineConfig({
  plugins: [vue(), vueJsx()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
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
});
