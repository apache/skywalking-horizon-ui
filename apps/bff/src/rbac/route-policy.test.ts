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

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isTemplateWriteRoute, denyTemplateWriteWhenReadOnly } from './route-policy.js';
import { setTemplateReadOnly } from '../logic/templates/sync.js';

describe('isTemplateWriteRoute — which routes the readonly backstop covers', () => {
  it('matches non-GET config-template write routes', () => {
    expect(isTemplateWriteRoute('POST', '/api/admin/templates/save')).toBe(true);
    expect(isTemplateWriteRoute('POST', '/api/admin/templates/save-translation')).toBe(true);
    expect(isTemplateWriteRoute('POST', '/api/admin/templates/sync-all')).toBe(true);
    expect(isTemplateWriteRoute('POST', '/api/admin/overview-templates')).toBe(true);
    expect(isTemplateWriteRoute('DELETE', '/api/admin/overview-templates/x')).toBe(true);
  });
  it('does NOT match reads, nor non-config writes (runtime-rule / live-debug stay editable)', () => {
    expect(isTemplateWriteRoute('GET', '/api/admin/templates/sync-status')).toBe(false);
    expect(isTemplateWriteRoute('HEAD', '/api/admin/templates/sync-status')).toBe(false);
    expect(isTemplateWriteRoute('POST', '/api/rule')).toBe(false); // runtime rule
    expect(isTemplateWriteRoute('POST', '/api/debug/session')).toBe(false); // live-debug
  });
});

describe('denyTemplateWriteWhenReadOnly — the BFF backstop', () => {
  afterEach(() => setTemplateReadOnly(false));

  const fakeReply = (): { reply: FastifyReply; code: ReturnType<typeof vi.fn> } => {
    const send = vi.fn();
    const code = vi.fn(() => ({ send }));
    return { reply: { code } as unknown as FastifyReply, code };
  };

  it('rejects with 409 in readonly mode', async () => {
    setTemplateReadOnly(true);
    const { reply, code } = fakeReply();
    await denyTemplateWriteWhenReadOnly({} as FastifyRequest, reply);
    expect(code).toHaveBeenCalledWith(409);
  });

  it('is a no-op in live mode (lets the write proceed)', async () => {
    setTemplateReadOnly(false);
    const { reply, code } = fakeReply();
    await denyTemplateWriteWhenReadOnly({} as FastifyRequest, reply);
    expect(code).not.toHaveBeenCalled();
  });
});
