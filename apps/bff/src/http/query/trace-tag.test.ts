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
 * Log tag autocomplete: an OAP with the `TagType` enum is asked once per log
 * source; an older one, which rejects a document naming the enum, gets the
 * untyped request.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { _resetCapabilitiesCache } from '../../logic/oap/capabilities.js';
import { _resetTimezoneCache } from '../../util/window.js';
import { registerTraceTagRoutes } from './trace-tag.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ROOT_FIELDS = [
  'queryLogTagAutocompleteKeys',
  'queryLogTagAutocompleteValues',
  'queryTraceTagAutocompleteKeys',
  'queryTraceTagAutocompleteValues',
] as const;

interface Sent {
  field: (typeof ROOT_FIELDS)[number];
  query: string;
  variables: Record<string, unknown>;
  /** The `type` the document actually binds — a variable it never uses is
   *  ignored by OAP, and so here. */
  type?: string;
}

/** An OAP whose schema has the `TagType` enum values `tagTypes`, or no such
 *  enum when null — then, as OAP 11.1.0 does, it refuses a document naming the
 *  enum or the `type` argument with a 400 validation error. `byType` answers
 *  the typed log queries; `untyped` the rest. `hold` keeps every tag query
 *  open until its signal aborts. */
function fakeOap(opts: {
  tagTypes: string[] | null;
  byType?: Record<string, string[]>;
  untyped?: string[];
  failType?: string;
  hold?: boolean;
}) {
  const sent: Sent[] = [];
  const aborted: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const { query = '', variables = {} } = JSON.parse(String(init?.body ?? '{}')) as Partial<Sent>;
    if (query.includes('getTimeInfo')) return json({ data: { time: { timezone: '+0000', currentTimestamp: Date.now() } } });
    if (query.includes('__type(name: "TagType")')) {
      return json({ data: { __type: opts.tagTypes ? { enumValues: opts.tagTypes.map((name) => ({ name })) } : null } });
    }
    if (query.includes('__type(name: "Query")')) return json({ data: { __type: { fields: [] } } });
    if (query.includes('__type')) return json({ data: { __type: null } });
    const field = ROOT_FIELDS.find((f) => query.includes(`${f}(`));
    if (!field) return json({ errors: [{ message: 'Validation error (FieldUndefined)' }] }, 400);
    const bound = /\$type: TagType!?/.test(query) && /\btype: \$type\b/.test(query);
    const typed = bound && typeof variables.type === 'string' ? variables.type : undefined;
    // Every attempt is recorded, the ones OAP rejects too.
    sent.push({ field, query, variables, type: typed });
    const namesType = query.includes('TagType') || /\btype:/.test(query);
    if (namesType && (opts.tagTypes === null || field.startsWith('queryTrace'))) {
      return json({ errors: [{ message: "Validation error (UnknownType) : Unknown type 'TagType'" }] }, 400);
    }
    const binds = (arg: string, type: string) =>
      new RegExp(`\\b${arg}: \\$${arg}\\b`).test(query) && query.includes(`$${arg}: ${type}!`);
    if (!binds('duration', 'Duration') || (field.endsWith('Values') && !binds('tagKey', 'String'))) {
      return json({ errors: [{ message: 'Validation error (MissingFieldArgument)' }] }, 400);
    }
    if (opts.hold) {
      await new Promise<void>((resolve) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          aborted.push(`${field}:${typed ?? ''}`);
          resolve();
        }, { once: true });
      });
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    }
    if (typed && opts.failType === typed) return new Response('storage timed out', { status: 503 });
    const list = typed ? (opts.byType?.[typed] ?? []) : (opts.untyped ?? []);
    // GraphQL answers under the alias the document gives the field.
    const alias = new RegExp(`(\\w+):\\s*${field}\\(`).exec(query)?.[1] ?? field;
    return json({ data: { [alias]: list } });
  };
  return { fetch, sent, aborted };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(oap: ReturnType<typeof fakeOap>): Promise<string> {
  const cfg = configSchema.parse({});
  const config: ConfigSource = { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  app = Fastify();
  await app.register(cookie);
  registerTraceTagRoutes(app, { config, sessions, fetch: oap.fetch });
  await app.ready();
  return `horizon_sid=${sessions.create('admin', ['admin']).sid}`;
}

/** Over a real socket, for the cancellation tests: `app.inject` never opens
 *  one, and its response reports closed after every reply, so a cancellation
 *  the route never made would still be observed there. */
async function serve(oap: ReturnType<typeof fakeOap>): Promise<{ url: string; cookie: string }> {
  const cookieHeader = await start(oap);
  await app!.listen({ port: 0, host: '127.0.0.1' });
  const addr = app!.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, cookie: cookieHeader };
}

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
}

async function get(url: string, oap: ReturnType<typeof fakeOap>) {
  const cookieHeader = await start(oap);
  const res = await app!.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
  await app!.close();
  app = null;
  return { status: res.statusCode, body: res.json() };
}

describe('log tag autocomplete', () => {
  beforeEach(() => {
    _resetCapabilitiesCache();
    _resetTimezoneCache();
  });

  it.each([
    ['', 'LOG', ['level', 'http.status_code']],
    ['&type=native', 'LOG', ['level', 'http.status_code']],
    ['&type=otlp', 'OTLP_LOG', ['level', 'severity']],
  ])('asks for the keys of the log type%s only', async (param, tagType, keys) => {
    const oap = fakeOap({
      tagTypes: ['LOG', 'OTLP_LOG'],
      byType: { LOG: ['level', 'http.status_code'], OTLP_LOG: ['level', 'severity'] },
    });
    const { status, body } = await get(`/api/log-tags/keys?windowMinutes=30${param}`, oap);
    expect(status).toBe(200);
    expect(body).toMatchObject({ keys });
    expect(body.error).toBeUndefined();
    expect(oap.sent.map((s) => [s.field, s.type])).toEqual([['queryLogTagAutocompleteKeys', tagType]]);
  });

  it('asks for a key’s values of the log type only', async () => {
    const oap = fakeOap({
      tagTypes: ['LOG', 'OTLP_LOG'],
      byType: { LOG: ['INFO', 'ERROR'], OTLP_LOG: ['WARN'] },
    });
    const { body } = await get('/api/log-tags/values?key=level&windowMinutes=30&type=otlp', oap);
    expect(body).toMatchObject({ key: 'level', values: ['WARN'] });
    expect(oap.sent.map((s) => [s.field, s.variables.tagKey, s.type])).toEqual([
      ['queryLogTagAutocompleteValues', 'level', 'OTLP_LOG'],
    ]);
  });

  it('sends the untyped request to an OAP without the TagType enum, whatever the log type', async () => {
    const oap = fakeOap({ tagTypes: null, untyped: ['level', 'http.status_code'] });
    const keys = await get('/api/log-tags/keys?windowMinutes=30&type=otlp', oap);
    expect(keys.body).toMatchObject({ keys: ['level', 'http.status_code'] });
    expect(keys.body.error).toBeUndefined();
    const values = await get('/api/log-tags/values?key=level&windowMinutes=30&type=otlp', oap);
    expect(values.body).toMatchObject({ values: ['level', 'http.status_code'] });
    expect(values.body.error).toBeUndefined();
    // Not even a first try with the enum: `sent` holds rejected attempts too.
    expect(oap.sent.map((s) => s.field)).toEqual(['queryLogTagAutocompleteKeys', 'queryLogTagAutocompleteValues']);
    for (const s of oap.sent) {
      expect(s.query).not.toContain('TagType');
      expect(s.variables).not.toHaveProperty('type');
    }
  });

  it('reports a failed read as an error, not an empty list', async () => {
    const oap = fakeOap({ tagTypes: ['LOG', 'OTLP_LOG'], failType: 'OTLP_LOG' });
    const { status, body } = await get('/api/log-tags/keys?windowMinutes=30&type=otlp', oap);
    expect(status).toBe(200);
    expect(body.keys).toEqual([]);
    expect(body.error).toBeTruthy();
  });

  it('leaves trace tag autocomplete untyped', async () => {
    const oap = fakeOap({ tagTypes: ['LOG', 'OTLP_LOG'], untyped: ['http.method'] });
    const keys = await get('/api/trace-tags/keys?windowMinutes=30', oap);
    expect(keys.body).toMatchObject({ keys: ['http.method'] });
    const values = await get('/api/trace-tags/values?key=http.method&windowMinutes=30', oap);
    expect(values.body).toMatchObject({ key: 'http.method', values: ['http.method'] });
    expect(oap.sent.map((s) => s.field)).toEqual(['queryTraceTagAutocompleteKeys', 'queryTraceTagAutocompleteValues']);
    for (const s of oap.sent) expect(s.variables).not.toHaveProperty('type');
  });

  it.each([
    ['/api/log-tags/keys?windowMinutes=30&type=otlp', ['queryLogTagAutocompleteKeys:OTLP_LOG']],
    ['/api/log-tags/values?key=level&windowMinutes=30', ['queryLogTagAutocompleteValues:LOG']],
    ['/api/trace-tags/values?key=http.method&windowMinutes=30', ['queryTraceTagAutocompleteValues:']],
  ])('stops the OAP reads of %s when the caller hangs up', async (path, expected) => {
    const oap = fakeOap({ tagTypes: ['LOG', 'OTLP_LOG'], hold: true });
    const { url, cookie } = await serve(oap);
    const ac = new AbortController();
    const req = fetch(`${url}${path}`, { headers: { cookie }, signal: ac.signal }).catch(() => undefined);
    await waitFor(() => oap.sent.length >= expected.length);
    expect(oap.sent).toHaveLength(expected.length);
    ac.abort();
    await req;
    await waitFor(() => oap.aborted.length >= expected.length);
    expect(oap.aborted.sort()).toEqual(expected);
  });
});
