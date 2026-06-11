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
 * Source-map management for the Browser Errors tab (#6784):
 *
 *   POST   /api/browser-errors/source-maps      multipart upload  (source-map:write)
 *   GET    /api/browser-errors/source-maps      list + usage      (browser-errors:read)
 *   DELETE /api/browser-errors/source-maps/:id  drop an upload    (source-map:write)
 *   POST   /api/browser-errors/resolve          de-obfuscate      (browser-errors:read)
 *
 * Maps live in the in-memory `SourceMapStore`. Resolution is intentionally
 * a query-time, operator-driven action: the caller picks the map id, so a
 * build/version mismatch is the operator's call, not a silent guess.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// Importing the type also pulls in @fastify/multipart's FastifyRequest
// augmentation (`req.file()`), so the plugin's API is typed here.
import type { MultipartFile } from '@fastify/multipart';
import type {
  ResolveRequest,
  ResolveResponse,
  SourceMapListResponse,
  SourceMapUploadResponse,
} from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import type { SourceMapStore } from '../../logic/browser-errors/store.js';
import { resolveStack } from '../../logic/browser-errors/resolve.js';

export interface SourceMapRouteDeps {
  config: ConfigSource;
  sessions: SessionStore;
  store: SourceMapStore;
}

export function registerSourceMapRoutes(app: FastifyInstance, deps: SourceMapRouteDeps): void {
  const auth = requireAuth(deps);
  const { store } = deps;

  app.post(
    '/api/browser-errors/source-maps',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!store.enabled) {
        return reply.code(403).send({ ok: false, error: 'disabled' } satisfies SourceMapUploadResponse);
      }
      let file: MultipartFile | undefined;
      try {
        file = await req.file();
      } catch {
        // The multipart fileSize limit trips here for oversized streams.
        return reply.code(413).send({ ok: false, error: 'too_large' } satisfies SourceMapUploadResponse);
      }
      if (!file) {
        return reply.code(400).send({ ok: false, error: 'no_file' } satisfies SourceMapUploadResponse);
      }
      let buf: Buffer;
      try {
        buf = await file.toBuffer();
      } catch {
        return reply.code(413).send({ ok: false, error: 'too_large' } satisfies SourceMapUploadResponse);
      }
      if (file.file.truncated) {
        return reply.code(413).send({ ok: false, error: 'too_large' } satisfies SourceMapUploadResponse);
      }
      const result = store.addUpload(file.filename, buf);
      if (!result.ok) {
        const code = result.error === 'too_large' ? 413 : result.error === 'disabled' ? 403 : 400;
        return reply.code(code).send({ ok: false, error: result.error } satisfies SourceMapUploadResponse);
      }
      return reply.send({ ok: true, map: result.map } satisfies SourceMapUploadResponse);
    },
  );

  app.get(
    '/api/browser-errors/source-maps',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        enabled: store.enabled,
        maps: store.enabled ? store.list() : [],
        usage: store.usage(),
      } satisfies SourceMapListResponse);
    },
  );

  app.delete(
    '/api/browser-errors/source-maps/:id',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const removed = store.remove(id);
      if (!removed) {
        // Either unknown, or a durable mount (delete the file on disk to
        // remove those — they reload at boot).
        return reply.code(404).send({ ok: false, error: 'not_removable' });
      }
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/api/browser-errors/resolve',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as ResolveRequest;
      const sourceMapId = body.sourceMapId ?? '';
      if (!store.enabled) {
        return reply.send({
          ok: false,
          sourceMapId,
          sourceMapLabel: null,
          frames: [],
          error: 'disabled',
        } satisfies ResolveResponse);
      }
      if (!body.stack && (body.line === undefined || body.line === null)) {
        return reply.send({
          ok: false,
          sourceMapId,
          sourceMapLabel: null,
          frames: [],
          error: 'no_input',
        } satisfies ResolveResponse);
      }
      const map = await store.getTraceMap(sourceMapId);
      if (!map) {
        return reply.send({
          ok: false,
          sourceMapId,
          sourceMapLabel: store.labelOf(sourceMapId),
          frames: [],
          error: 'unknown_map',
        } satisfies ResolveResponse);
      }
      const frames = resolveStack(map, {
        stack: body.stack ?? null,
        line: body.line ?? null,
        col: body.col ?? null,
        errorUrl: body.errorUrl ?? null,
      });
      return reply.send({
        ok: true,
        sourceMapId,
        sourceMapLabel: store.labelOf(sourceMapId),
        frames,
      } satisfies ResolveResponse);
    },
  );
}
