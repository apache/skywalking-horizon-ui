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
 * MCP over HTTP.
 *   POST /api/mcp — one JSON-RPC exchange, stateless.
 *   GET / DELETE   — 405. Both belong to the session-bearing variant of the
 *                    transport, which this endpoint deliberately does not run
 *                    (see `server.ts` on why stateless).
 *
 * The route is thin on purpose: authenticate, refuse if MCP is off, then hand
 * the raw request to the SDK transport. Everything protocol-shaped lives in the
 * SDK; everything Horizon-shaped lives in `server.ts` and `tools.ts`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike, UITemplateClient } from '@skywalking-horizon-ui/api-client';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { getServerOffsetMinutes } from '../../util/window.js';
import { SECURITY_HEADERS, API_CACHE_CONTROL } from '../../util/security-headers.js';
import { createMcpServer, surfaceFor } from './server.js';

export interface McpRouteDeps extends AuthDeps {
  fetch?: FetchLike;
  uiTemplateClient?: () => UITemplateClient;
  version: string;
}

/** JSON-RPC's own "you can't do that" shape — an MCP client parses this, where
 *  a bare Fastify error body would surface as a transport failure. */
function rpcError(reply: FastifyReply, status: number, code: number, message: string): FastifyReply {
  return reply.code(status).send({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Origin, per the Streamable HTTP transport's security requirements.
 *
 * The attack this closes is DNS rebinding: a page the operator is merely
 * VISITING resolves a name it controls to 127.0.0.1 and posts JSON-RPC at a
 * local Horizon, riding the operator's cookie. The browser attaches an Origin
 * it cannot forge, which is why checking it works where checking the Host
 * header does not.
 *
 * A native client sends NO Origin at all — Codex, a CLI, curl — and that stays
 * allowed, because the header is a browser guarantee and its absence proves the
 * caller is not a page. Present but wrong is the only refusal: same-origin with
 * this deployment, or a loopback origin (the dev UI on another port, and the
 * `ui://` bundle's own host), and nothing else.
 */
export function originAllowed(origin: string | undefined, publicUrl: string): boolean {
  if (!origin) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (publicUrl) {
    try {
      if (u.origin === new URL(publicUrl).origin) return true;
    } catch {
      /* a malformed publicUrl must not widen the check */
    }
  }
  // URL keeps an IPv6 literal in its brackets — `[::1]`, not `::1` — so the
  // bare comparison silently never matched loopback over IPv6.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const auth = requireAuth(deps);

  // GET (the server→client notification stream) and DELETE (session teardown)
  // exist only in the session-bearing transport. Answer them with the same
  // fixed error for every caller — a client that opens one is misconfigured,
  // and it should read that, not an auth failure.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    rpcError(reply, 405, -32000, 'Method not allowed: this MCP endpoint is stateless (POST only).');
  app.get('/api/mcp', notAllowed);
  app.delete('/api/mcp', notAllowed);

  /** Ordered BEFORE auth: a rebound page carries the operator's real cookie, so
   *  the refusal cannot depend on the credential failing. */
  const originGuard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!originAllowed(req.headers.origin, deps.config.current.server.publicUrl)) {
      await rpcError(reply, 403, -32000, 'Forbidden: Origin not allowed for this MCP endpoint.');
    }
  };

  app.post('/api/mcp', { preHandler: [originGuard, auth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.config.current.mcp.enabled) {
      return rpcError(reply, 503, -32000, 'MCP is disabled on this Horizon server.');
    }
    // A BEARER TOKEN, and not a browser cookie. Not a preference — a cookie
    // cannot be served correctly here: the response is written by the transport
    // rather than by Fastify (see below), so the sliding-session cookie the auth
    // layer queues is never sent, and the session would expire in the browser at
    // its original deadline while the server believed it alive. Refusing is
    // honest; half-working session renewal is not. Every real MCP client holds a
    // token anyway — that is what the OAuth flow exists to give it.
    if (req.authKind === 'session') {
      return rpcError(
        reply,
        401,
        -32000,
        'MCP requires a bearer token, not a browser session. Use an API token, or sign in through the OAuth flow.',
      );
    }

    const body = req.body as { method?: string; params?: { capabilities?: unknown } } | undefined;
    // Stateless means every request builds its own server, so the presentation
    // section has to be chosen from THIS request. Only `initialize` carries the
    // client's capabilities and only its response carries `instructions`, so
    // that is the one exchange where the choice can be made — and the only one
    // where it matters.
    const surface = surfaceFor(body?.method === 'initialize' ? body.params?.capabilities : undefined);

    // DISCOVERY MUST NOT WAIT ON OAP. The server's UTC offset is read from OAP,
    // and only a tool that stamps a time ever uses it — but awaiting it here
    // put an OAP round-trip in front of `initialize` and `tools/list`, which
    // read no data at all. On a cold cache against a slow or unreachable OAP
    // that is a full `oap.timeoutMs` before a client can even list the tools,
    // so a backend problem presented as an MCP client that would not connect.
    const needsTime = body?.method === 'tools/call';
    const server = createMcpServer(
      {
        config: deps.config,
        fetch: deps.fetch,
        uiTemplateClient: deps.uiTemplateClient,
        subject: req.session ?? { roles: [] },
        offsetMinutes: needsTime ? await getServerOffsetMinutes(deps.config, deps.fetch) : 0,
      },
      surface,
      deps.version,
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    // Hijacking bypasses the global onSend hook, so the headers it would have
    // added are set here. `setHeader` is not enough on its own for the cache
    // policy: the transport calls writeHead(status, headers) and those OVERRIDE
    // same-named values set earlier. It names Cache-Control itself, so
    // Horizon's `no-store` lost to the SDK's `no-cache` — measured — while the
    // other four headers survived because the SDK never names them, which is
    // what hid it. The override below corrects it inside the call.
    //
    // No cookie is carried over, and none needs to be: a browser session is
    // refused above precisely because @fastify/cookie writes no header when
    // `setCookie` is called — it collects cookies and serializes them in an
    // onSend hook, which hijacking skips — so a sliding session could not be
    // renewed from here however the headers were rewritten.
    reply.raw.setHeader('Cache-Control', API_CACHE_CONTROL);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.raw.setHeader(k, v);

    // The correction has to happen INSIDE the call, on the header record the
    // transport passes as an argument. Doing it afterwards cannot work: by then
    // the head is on the wire and `setHeader` is a silent no-op. (The transport
    // is a shim over a Web-standard one, so it builds a whole `Response` and
    // has @hono/node-server write it as `writeHead(status, record)` — Fastify's
    // reply is never consulted, which is what bypasses the onSend hook.)
    const rawWriteHead = reply.raw.writeHead.bind(reply.raw);
    reply.raw.writeHead = ((status: number, ...rest: unknown[]) => {
      const at = rest.findIndex((a) => a !== null && typeof a === 'object');
      const record: Record<string, unknown> = at >= 0 ? { ...(rest[at] as object) } : {};
      // Delete by any spelling before setting: header names are compared
      // case-insensitively by HTTP but not by an object literal, so leaving the
      // transport's `cache-control` in place would emit the field twice.
      for (const k of Object.keys(record)) {
        if (k.toLowerCase() === 'cache-control' || k.toLowerCase() === 'set-cookie') delete record[k];
      }
      record['Cache-Control'] = API_CACHE_CONTROL;
      const args = at >= 0 ? rest.map((a, i) => (i === at ? record : a)) : [...rest, record];
      return rawWriteHead(status, ...(args as []));
    }) as typeof reply.raw.writeHead;

    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }),
        );
      } else {
        reply.raw.end();
      }
    }
  });
}
