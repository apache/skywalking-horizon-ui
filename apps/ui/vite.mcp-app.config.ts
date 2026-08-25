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
 * Builds the `ui://` bundle — the card renderers as ONE self-contained HTML
 * document an MCP host can mount in a sandboxed iframe.
 *
 * Separate from the app build because the output shape is different in the one
 * way that matters: an MCP resource is a single string of HTML, so nothing may
 * reference a second file. Everything inlines (`assetsInlineLimit: Infinity`,
 * `cssCodeSplit: false`, one chunk), and `scripts/build-mcp-app.mjs` folds the
 * remaining JS and CSS into the HTML afterwards.
 */

import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import { templateCompilerOptions } from '@tresjs/core';

export default defineConfig({
  // Relative, because the document is loaded from a `ui://` URI rather than a
  // server root — an absolute `/assets/…` would resolve against nothing.
  base: './',
  plugins: [vue({ ...templateCompilerOptions }), vueJsx()],
  resolve: {
    alias: [
      // Order matters: the i18n substitution must be tried before the general
      // `@` rule, or `@/i18n` resolves to the eight-catalog module first.
      // See src/mcp-app/i18n.ts for why this is an alias and not an edit.
      { find: /^@\/i18n$/, replacement: fileURLToPath(new URL('./src/mcp-app/i18n.ts', import.meta.url)) },
      { find: /^@\//, replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/` },
    ],
  },
  build: {
    outDir: 'dist-mcp-app',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./mcp-app.html', import.meta.url)) },
    // Fonts and images become data: URIs; there is no second request to make.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    // One chunk: a dynamic import would emit a file the sandbox cannot fetch.
    modulePreload: { polyfill: false },
  },
});
