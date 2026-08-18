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
 * The `ui://` resource — Horizon's card renderers as one HTML document a host
 * can mount in a sandboxed iframe (MCP Apps, SEP-1865).
 *
 * The URI carries the bundle's content hash, and three things fall out of that
 * rather than needing to be answered:
 *
 *  - a new build is a new URI, so cache-busting is free;
 *  - an unchanged build keeps its URI, so a host fetches it once and reuses it
 *    across every conversation it holds;
 *  - a conversation replayed later renders with the renderer it was CAPTURED
 *    against, not whatever shipped since — which is the right behaviour for a
 *    system whose cards are frozen snapshots, not a compromise.
 *
 * It declares no CSP exceptions because it needs none: every card is a captured
 * replay, so the page makes zero network requests and runs under the host's
 * deny-all default.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logger.js';

/** `text/html;profile=mcp-app` is what marks an HTML resource as an MCP App
 *  rather than a document to display as text. */
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Same two-layout problem the skills loader has, and the same shape of answer:
 *   - dev (tsx): `<HERE>` is `src/ai/mcp`, so `<HERE>/app` is the build output.
 *   - packaged: esbuild inlines this file into `dist/server.js`, so `<HERE>` is
 *     `dist/`; `scripts/package.mjs` copies the bundle to `dist/mcp-app`.
 */
const CANDIDATES = [join(HERE, 'app'), join(HERE, 'mcp-app'), join(process.cwd(), 'mcp-app')];

interface Bundle {
  uri: string;
  html: string;
}

/**
 * Read once at first use, not at import: the bundle is ~2.7 MB, and a
 * deployment that never has an MCP client with a renderer should not hold it
 * resident. Absent is a normal state — `pnpm build:mcp-app` produces it, and a
 * source checkout that has not run it simply serves no resource.
 */
let cached: Bundle | null | undefined;

export function mcpAppBundle(): Bundle | null {
  if (cached !== undefined) return cached;
  for (const dir of CANDIDATES) {
    try {
      const html = readFileSync(join(dir, 'app.html'), 'utf8');
      const hash = readFileSync(join(dir, 'hash.txt'), 'utf8').trim();
      cached = { uri: `ui://horizon/app/${hash}`, html };
      logger.info({ uri: cached.uri, bytes: html.length }, 'ui:// bundle loaded');
      return cached;
    } catch {
      /* try the next layout */
    }
  }
  cached = null;
  logger.warn(
    'no ui:// bundle found (run `pnpm build:mcp-app`) — MCP clients that render cards get text only',
  );
  return cached;
}
