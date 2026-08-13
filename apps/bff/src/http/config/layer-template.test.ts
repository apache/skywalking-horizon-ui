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

import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { registerLayerTemplateRoutes } from './layer-template.js';
import * as loader from '../../logic/layers/loader.js';

function fakeConfig(trustedLinkDomains?: string[]): ConfigSource {
  const parsed = configSchema.parse(
    trustedLinkDomains ? { security: { trustedLinkDomains } } : {},
  );
  return { current: parsed, path: 'test' } as unknown as ConfigSource;
}

async function build(trustedLinkDomains?: string[]): Promise<{ app: FastifyInstance; sid: string }> {
  const config = fakeConfig(trustedLinkDomains);
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerLayerTemplateRoutes(app, { config, sessions });
  await app.ready();
  return { app, sid: sessions.create('op', ['admin']).sid };
}

/** The one field under test; the rest of a layer template is irrelevant here. */
function stubTemplates(documentLink?: string): void {
  vi.spyOn(loader, 'allLayerTemplates').mockReturnValue([
    { key: 'GENERAL', alias: 'General', components: {}, ...(documentLink ? { documentLink } : {}) },
  ] as unknown as ReturnType<typeof loader.allLayerTemplates>);
}

async function linkFor(documentLink: string, trusted?: string[]): Promise<string | undefined> {
  stubTemplates(documentLink);
  const { app, sid } = await build(trusted);
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/layer-templates',
    headers: { cookie: `horizon_sid=${sid}` },
  });
  await app.close();
  expect(res.statusCode).toBe(200);
  const body = res.json() as { templates: Array<{ documentLink?: string }> };
  return body.templates[0]?.documentLink;
}

afterEach(() => vi.restoreAllMocks());

// The layer page falls back to THIS list to preview a layer OAP does not list
// yet, and renders its documentLink in the same anchor the menu does. Serving
// it unchecked would leave a render path the menu's own check never sees —
// which is exactly what this route did before.
describe('GET /api/admin/layer-templates — the preview list applies the link policy', () => {
  it('serves a link on a trusted host', async () => {
    expect(await linkFor('https://skywalking.apache.org/docs/')).toBe(
      'https://skywalking.apache.org/docs/',
    );
  });

  it.each([
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['an untrusted host', 'https://evil.example/x'],
    ['a backslash escape that leaves the origin', '/\\evil.example/x'],
  ])('withholds %s', async (_label, link) => {
    expect(await linkFor(link)).toBeUndefined();
  });

  it('withholds every outbound link when the allow-list is empty', async () => {
    expect(await linkFor('https://skywalking.apache.org/docs/', [])).toBeUndefined();
  });

  it('keeps a same-origin path whatever the allow-list says', async () => {
    expect(await linkFor('/runbook/general', [])).toBe('/runbook/general');
  });
});
