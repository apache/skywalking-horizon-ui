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
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from './logger.js';

const SID = 'SECRET-SESSION-ID-abcdef0123456789';

async function write(events: Parameters<AuditLogger['record']>[0][]): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');
  const log = new AuditLogger(file, true);
  await log.open();
  for (const e of events) log.record(e);
  await log.close();
  return readFileSync(file, 'utf8');
}

const base = { actor: 'admin', action: 'auth.login', outcome: 'success' } as const;

describe('the audit trail records no replayable session credential', () => {
  // The session id IS the cookie. An audit file reaches a SIEM, a ticket and
  // an incident channel — all wider audiences than the session store.
  it('never writes the raw session id', async () => {
    const text = await write([{ ...base, sessionId: SID }]);
    expect(text).not.toContain(SID);
    expect(JSON.parse(text.trim()).sessionId).not.toBe(SID);
  });

  // Without this the field would be worthless: following one operator's run
  // of actions is the reason it is recorded at all.
  it('gives the same session the same value throughout the process', async () => {
    const lines = (await write([
      { ...base, sessionId: SID },
      { ...base, action: 'rule.addOrUpdate', sessionId: SID },
    ]))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { sessionId: string });
    expect(lines[0].sessionId).toBe(lines[1].sessionId);
    expect(lines[0].sessionId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives different sessions different values', async () => {
    const lines = (await write([
      { ...base, sessionId: SID },
      { ...base, sessionId: `${SID}-other` },
    ]))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { sessionId: string });
    expect(lines[0].sessionId).not.toBe(lines[1].sessionId);
  });

  it('leaves an event without a session alone', async () => {
    const line = JSON.parse((await write([{ ...base, actor: null }])).trim()) as Record<string, unknown>;
    expect('sessionId' in line).toBe(false);
  });

  // `details` is caller-shaped and passes through untouched — the live-debug
  // routes put an OAP debug-session id there, which is a different thing from
  // the auth session and must not be mangled.
  it('does not rewrite unrelated ids carried in details', async () => {
    const line = JSON.parse(
      (await write([{ ...base, sessionId: SID, details: { sessionId: 'oap-debug-42' } }])).trim(),
    ) as { details: { sessionId: string }; sessionId: string };
    expect(line.details.sessionId).toBe('oap-debug-42');
    expect(line.sessionId).not.toBe(SID);
  });
});
