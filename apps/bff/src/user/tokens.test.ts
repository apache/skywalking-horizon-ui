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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigSource } from '../config/loader.js';
import type { HorizonConfig } from '../config/schema.js';
import { TokenStore, hashTokenSecret, parseToken } from './tokens.js';

let dir: string;
const SECRET = 'sBcQ2xR8vT1yU4wA7zE0nM3kL6jH9gF2';

function configWith(overrides: {
  tokensFile?: string;
  users?: Array<{ username: string; roles: string[] }>;
  rbacEnabled?: boolean;
}): ConfigSource {
  const cfg = {
    rbac: { enabled: overrides.rbacEnabled ?? true },
    auth: {
      backend: 'local' as const,
      local: { users: (overrides.users ?? [{ username: 'sre', roles: ['viewer'] }]).map((u) => ({ ...u, passwordHash: 'x' })) },
      tokensFile: overrides.tokensFile ?? '',
    },
  } as unknown as HorizonConfig;
  return { current: cfg, path: '', current_: () => cfg, onChange: () => () => {}, close: async () => {} };
}

function writeTokens(entries: unknown[]): string {
  const p = join(dir, 'tokens.json');
  writeFileSync(p, JSON.stringify(entries));
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'horizon-tokens-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseToken', () => {
  it('splits on the first separator so an underscore in the secret survives', () => {
    expect(parseToken('hzn_ab12cd_secret_with_underscores')).toEqual({
      id: 'ab12cd',
      secret: 'secret_with_underscores',
    });
  });

  it('rejects anything that is not a well-formed token', () => {
    expect(parseToken('nope')).toBeNull();
    expect(parseToken('hzn_')).toBeNull();
    expect(parseToken('hzn_onlyid')).toBeNull();
    expect(parseToken('hzn__nosecretid')).toBeNull();
    expect(parseToken('hzn_id_')).toBeNull();
  });
});

describe('TokenStore.resolve', () => {
  it('resolves a valid token to the user and their CURRENT roles', async () => {
    const file = writeTokens([{ id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET) }]);
    const store = new TokenStore(configWith({ tokensFile: file, users: [{ username: 'sre', roles: ['viewer', 'maintainer'] }] }));
    const id = await store.resolve(`Bearer hzn_ab12cd_${SECRET}`);
    expect(id).toEqual({ username: 'sre', roles: ['viewer', 'maintainer'], tokenId: 'ab12cd', label: undefined });
  });

  it('revokes itself when the user is gone, whatever the entry claims', async () => {
    const file = writeTokens([
      { id: 'ab12cd', username: 'ghost', hash: hashTokenSecret(SECRET), roles: ['admin'] },
    ]);
    const store = new TokenStore(configWith({ tokensFile: file, users: [{ username: 'sre', roles: ['viewer'] }] }));
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).toBeNull();
  });

  it('treats an entry roles list as a cap, never a grant', async () => {
    const file = writeTokens([
      { id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET), roles: ['viewer', 'admin'] },
    ]);
    const store = new TokenStore(
      configWith({ tokensFile: file, users: [{ username: 'sre', roles: ['viewer', 'maintainer'] }] }),
    );
    const id = await store.resolve(`Bearer hzn_ab12cd_${SECRET}`);
    // viewer survives (in both); maintainer is capped out; admin is NOT granted.
    expect(id?.roles).toEqual(['viewer']);
  });

  it('refuses a cap that intersects to nothing rather than falling back to the user', async () => {
    const file = writeTokens([
      { id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET), roles: ['operator'] },
    ]);
    const store = new TokenStore(configWith({ tokensFile: file, users: [{ username: 'sre', roles: ['viewer'] }] }));
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).toBeNull();
  });

  it('does not refuse a role-less user when RBAC is off, since the cookie path would not', async () => {
    const file = writeTokens([{ id: 'ab12cd', username: 'nobody', hash: hashTokenSecret(SECRET) }]);
    const store = new TokenStore(
      configWith({ tokensFile: file, users: [{ username: 'nobody', roles: [] }], rbacEnabled: false }),
    );
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).not.toBeNull();
  });

  /**
   * The near-miss beside the test above, and the reason existence is checked
   * apart from roles. With RBAC off a role-less user is fine — the browser
   * would admit them too — but a user who is GONE is not, and both resolve to
   * the same empty role list. `resolveVerbsForRoles` then returns `*` without
   * reading the roles at all, so this token held every verb in the product for
   * somebody the deployment had deleted, while that same person could no
   * longer log in through the browser at all.
   */
  it('refuses a token for a user who no longer exists, even with RBAC off', async () => {
    const file = writeTokens([{ id: 'ab12cd', username: 'departed', hash: hashTokenSecret(SECRET) }]);
    const store = new TokenStore(
      configWith({ tokensFile: file, users: [{ username: 'someone-else', roles: [] }], rbacEnabled: false }),
    );
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).toBeNull();
  });

  it('refuses an unparseable expiry rather than treating it as no expiry', async () => {
    // A non-date like "90d" parses to NaN; treating that as "never expires"
    // would fail open on a credential's lifetime. (An out-of-range date such
    // as 2026-11-31 is not unparseable — JS rolls it to Dec 1.)
    const file = writeTokens([
      { id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET), expires: '90d' },
    ]);
    const store = new TokenStore(configWith({ tokensFile: file }));
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).toBeNull();
  });

  it('refuses a wrong secret for a known id', async () => {
    const file = writeTokens([{ id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET) }]);
    const store = new TokenStore(configWith({ tokensFile: file }));
    expect(await store.resolve('Bearer hzn_ab12cd_wrong')).toBeNull();
  });

  it('refuses an expired token', async () => {
    const file = writeTokens([
      { id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET), expires: '2020-01-01' },
    ]);
    const store = new TokenStore(configWith({ tokensFile: file }));
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).toBeNull();
  });

  it('honours a future expiry', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const file = writeTokens([
      { id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET), expires: future },
    ]);
    const store = new TokenStore(configWith({ tokensFile: file }));
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).not.toBeNull();
  });

  it('is inert when no tokens file is configured', async () => {
    const store = new TokenStore(configWith({}));
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).toBeNull();
  });

  it('ignores non-bearer authorization headers and absent ones', async () => {
    const file = writeTokens([{ id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET) }]);
    const store = new TokenStore(configWith({ tokensFile: file }));
    expect(await store.resolve(undefined)).toBeNull();
    expect(await store.resolve('Basic abc')).toBeNull();
  });

  it('skips malformed entries without discarding the valid ones', async () => {
    const file = writeTokens([
      { id: 'bad' },
      { username: 'sre' },
      { id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET) },
    ]);
    const store = new TokenStore(configWith({ tokensFile: file }));
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).not.toBeNull();
  });

  it('refuses every token once the file is GONE, rather than serving it forever', async () => {
    const file = writeTokens([{ id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET) }]);
    const store = new TokenStore(configWith({ tokensFile: file }));
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).not.toBeNull();
    rmSync(file);
    // Past the reload TTL: a deleted file is a revocation or a lost mount, and
    // treating it as a hiccup would make the tokens unrevokable for the life
    // of the process.
    (store as unknown as { loadedAt: number }).loadedAt = 0;
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).toBeNull();
  });

  it('keeps serving the last good file when it becomes unreadable mid-rotation', async () => {
    const file = writeTokens([{ id: 'ab12cd', username: 'sre', hash: hashTokenSecret(SECRET) }]);
    const store = new TokenStore(configWith({ tokensFile: file }));
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).not.toBeNull();
    writeFileSync(file, 'not json at all');
    // Within the reload TTL nothing is re-read; the point is that a later bad
    // read must not log every holder out either.
    expect(await store.resolve(`Bearer hzn_ab12cd_${SECRET}`)).not.toBeNull();
  });
});
