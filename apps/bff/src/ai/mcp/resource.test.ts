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

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpAppBundle, MCP_APP_MIME } from './resource.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const built = existsSync(join(HERE, 'app', 'app.html'));

describe('the ui:// resource', () => {
  it('is optional — a checkout that has not built it serves text only', () => {
    // Both outcomes are correct; what must never happen is a throw at import,
    // which would take the whole MCP endpoint down over a missing build.
    expect(() => mcpAppBundle()).not.toThrow();
  });

  it('marks itself as an MCP app, not a document to show as text', () => {
    expect(MCP_APP_MIME).toBe('text/html;profile=mcp-app');
  });

  it.runIf(built)('versions its URI by content hash', () => {
    expect(mcpAppBundle()?.uri).toMatch(/^ui:\/\/horizon\/app\/[0-9a-f]{12}$/);
  });

  /**
   * The property the whole design rests on: a host mounts this in a sandbox
   * with an opaque origin and a deny-all CSP, so a single external reference
   * means a card that renders blank with nothing in any log to explain it.
   */
  it.runIf(built)('references no external file', () => {
    const html = readFileSync(join(HERE, 'app', 'app.html'), 'utf8');
    const skeleton = html
      .replace(/<script[\s\S]*?<\/script>/gi, '<script/>')
      .replace(/<style[\s\S]*?<\/style>/gi, '<style/>');
    expect([...skeleton.matchAll(/(?:src|href)="(?!data:)([^"]+)"/gi)].map((m) => m[1])).toEqual([]);
    // Belt and braces — a tag re-inserted INSIDE a script body is invisible to
    // the skeleton scan, which is exactly what a `$&` substitution once did.
    expect(html).not.toMatch(/(?:src|href)="\.?\/assets\//);
  });
});
