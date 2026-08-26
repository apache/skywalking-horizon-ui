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
 * When the boot warns that records travel unencrypted.
 *
 * `allowCleartext` is a PERMISSION, not a mode. Set alongside TLS it permits
 * something that then does not happen, so warning there tells an operator
 * their encrypted connection is unencrypted. That is worse than staying quiet:
 * the next time the line appears about a connection that really is in the
 * clear, they have already learned it means nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const warn = vi.fn();
vi.mock('../../logger.js', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createAuditService } = await import('./index.js');
const { auditSchema } = await import('../../config/audit.js');

function boot(audit: unknown): void {
  const parsed = auditSchema.parse(audit);
  // Construction is all that is exercised; nothing connects here.
  createAuditService({ audit: parsed } as Parameters<typeof createAuditService>[0]);
}

const cleartextWarnings = (): string[] =>
  warn.mock.calls.map((c) => String(c[1] ?? '')).filter((m) => m.includes('unencrypted'));

beforeEach(() => warn.mockClear());

describe('the cleartext warning', () => {
  it('fires for a BanyanDB reached without TLS', () => {
    boot({
      enabled: true,
      provider: 'banyandb',
      banyandb: { address: 'banyandb.internal:17912', allowCleartext: true },
    });

    expect(cleartextWarnings()).toHaveLength(1);
  });

  it('stays quiet when TLS is on, however the permission is set', () => {
    boot({
      enabled: true,
      provider: 'banyandb',
      // Both together: an operator who turned the permission on and later
      // added TLS. The connection is encrypted, so there is nothing to warn
      // about — the permission is simply unused.
      banyandb: { address: 'banyandb.internal:17912', tls: true, allowCleartext: true },
    });

    expect(cleartextWarnings()).toEqual([]);
  });

  it('fires for a Postgres url that does not verify its peer', () => {
    boot({
      enabled: true,
      provider: 'postgres',
      postgres: { url: 'postgres://horizon@audit-db:5432/horizon', allowCleartext: true },
    });

    expect(cleartextWarnings()).toHaveLength(1);
  });

  it('stays quiet for a Postgres url that asks for verify-full', () => {
    boot({
      enabled: true,
      provider: 'postgres',
      postgres: {
        url: 'postgres://horizon@audit-db:5432/horizon?sslmode=verify-full',
        allowCleartext: true,
      },
    });

    expect(cleartextWarnings()).toEqual([]);
  });
});
