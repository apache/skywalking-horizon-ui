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
 * HTTP-surface acceptance for the source-map routes — the literal "the BFF
 * api accepts a js + .map analysis" check: upload a real esbuild-emitted
 * map over multipart, then resolve a stack against it and get original
 * positions back. Also pins the RBAC gate (read vs write verb).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { transform } from 'esbuild';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { SourceMapStore } from '../../logic/browser-errors/store.js';
import { registerSourceMapRoutes } from './source-maps.js';

const SOURCE = [
  'function greet(name) {',
  '  const greeting = "HELLO_MARKER";',
  '  return greeting + name;',
  '}',
  'globalThis.__greet = greet;',
].join('\n');

let MAP_JSON: string;
let MARKER_COL0: number;

beforeAll(async () => {
  const out = await transform(SOURCE, {
    loader: 'js',
    sourcemap: true,
    minify: true,
    sourcesContent: true,
    sourcefile: 'greet.js',
  });
  MAP_JSON = out.map;
  MARKER_COL0 = out.code.indexOf('HELLO_MARKER');
});

function fakeConfig(): ConfigSource {
  const cfg = configSchema.parse({});
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

async function buildApp(
  store: SourceMapStore,
  fileSizeLimit = 64 * 1024 * 1024,
): Promise<{ app: FastifyInstance; sessions: SessionStore }> {
  const config = fakeConfig();
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  await app.register(fastifyMultipart, { limits: { fileSize: fileSizeLimit, files: 1 } });
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerSourceMapRoutes(app, { config, sessions, store });
  await app.ready();
  return { app, sessions };
}

function multipartBody(filename: string, content: string): { payload: string; contentType: string } {
  const boundary = '----horizontest';
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: application/json',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('source-map routes — RBAC + upload', () => {
  it('401 without a session', async () => {
    const { app } = await buildApp(new SourceMapStore(() => ({ enabled: true, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 30, maxFileCount: 100 })));
    const { payload, contentType } = multipartBody('app.js.map', MAP_JSON);
    const res = await app.inject({
      method: 'POST',
      url: '/api/browser-errors/source-maps',
      headers: { 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('403 for a reader without source-map:write (viewer)', async () => {
    const { app, sessions } = await buildApp(new SourceMapStore(() => ({ enabled: true, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 30, maxFileCount: 100 })));
    const sid = sessions.create('v', ['viewer']).sid;
    const { payload, contentType } = multipartBody('app.js.map', MAP_JSON);
    const res = await app.inject({
      method: 'POST',
      url: '/api/browser-errors/source-maps',
      headers: { 'content-type': contentType, cookie: `horizon_sid=${sid}` },
      payload,
    });
    expect(res.statusCode).toBe(403);
    // ...but a viewer can still list (read verb).
    const list = await app.inject({ method: 'GET', url: '/api/browser-errors/source-maps', headers: { cookie: `horizon_sid=${sid}` } });
    expect(list.statusCode).toBe(200);
    await app.close();
  });

  it('413 when the upload exceeds the multipart fileSize limit', async () => {
    const { app, sessions } = await buildApp(new SourceMapStore(() => ({ enabled: true, maxFileBytes: 16, maxTotalBytes: 1 << 30, maxFileCount: 100 })), 16);
    const sid = sessions.create('op', ['operator']).sid;
    const { payload, contentType } = multipartBody('app.js.map', MAP_JSON);
    const res = await app.inject({
      method: 'POST',
      url: '/api/browser-errors/source-maps',
      headers: { 'content-type': contentType, cookie: `horizon_sid=${sid}` },
      payload,
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });
});

describe('source-map routes — upload then resolve (js + .map)', () => {
  it('operator uploads a real map and resolves a stack to original source', async () => {
    const store = new SourceMapStore(() => ({ enabled: true, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 30, maxFileCount: 100 }));
    const { app, sessions } = await buildApp(store);
    const sid = sessions.create('op', ['operator']).sid;

    const { payload, contentType } = multipartBody('app.js.map', MAP_JSON);
    const up = await app.inject({
      method: 'POST',
      url: '/api/browser-errors/source-maps',
      headers: { 'content-type': contentType, cookie: `horizon_sid=${sid}` },
      payload,
    });
    expect(up.statusCode).toBe(200);
    const upBody = up.json() as { ok: boolean; map: { id: string; label: string; origin: string } };
    expect(upBody.ok).toBe(true);
    expect(upBody.map.origin).toBe('upload');
    const mapId = upBody.map.id;

    const stack = `Error: boom\n    at greet (app.js:1:${MARKER_COL0 + 1})`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/browser-errors/resolve',
      headers: { 'content-type': 'application/json', cookie: `horizon_sid=${sid}` },
      payload: JSON.stringify({ stack, sourceMapId: mapId }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; sourceMapLabel: string; frames: Array<{ original: { source: string; line: number } | null }> };
    expect(body.ok).toBe(true);
    expect(body.sourceMapLabel).toBe('app.js.map');
    expect(body.frames[0]?.original?.line).toBe(2);
    expect(body.frames[0]?.original?.source).toBe('greet.js');
    await app.close();
  });

  it('resolve against an unknown map id returns a typed error, not a throw', async () => {
    const store = new SourceMapStore(() => ({ enabled: true, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 30, maxFileCount: 100 }));
    const { app, sessions } = await buildApp(store);
    const sid = sessions.create('op', ['operator']).sid;
    const res = await app.inject({
      method: 'POST',
      url: '/api/browser-errors/resolve',
      headers: { 'content-type': 'application/json', cookie: `horizon_sid=${sid}` },
      payload: JSON.stringify({ stack: 'Error\n    at x (a.js:1:1)', sourceMapId: 'nope' }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { error: string }).error).toBe('unknown_map');
    await app.close();
  });
});
