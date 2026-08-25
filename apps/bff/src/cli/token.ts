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
 * Mint an API token: `cli:token <username> [--label L] [--days N]`.
 *
 * PRINTS the entry rather than writing it — the tokens file is typically a
 * mounted Secret this process cannot write, which is also why this credential
 * is provisioned by an operator rather than self-served by a user.
 *
 * The format is deliberately plain — a random secret and its SHA-256 — so it
 * can be produced by Vault, SOPS, sealed-secrets or four lines of shell. This
 * command exists only to avoid one specific mistake: `echo` appends a newline,
 * so `echo "$secret" | shasum` yields a valid-looking hash that never matches.
 */

import { randomBytes } from 'node:crypto';
import { hashTokenSecret } from '../user/tokens.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const username = process.argv[2];
  if (!username || username.startsWith('--')) {
    process.stderr.write('usage: cli:token <username> [--label "ci / nightly"] [--days 90] [--roles viewer,maintainer]\n');
    process.exit(1);
  }
  const id = randomBytes(3).toString('hex');
  // base64url minus `_`, so the id/secret split stays unambiguous by eye.
  const secret = randomBytes(24).toString('base64url').replace(/_/g, '-');
  const label = arg('label');
  const roles = arg('roles')?.split(',').map((r) => r.trim()).filter(Boolean);
  const rawDays = arg('days');
  const days = rawDays === undefined ? undefined : Number(rawDays);
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    // Silently minting a never-expiring token because someone typed "90d" is
    // the wrong way to be wrong about a credential's lifetime.
    process.stderr.write(`--days must be a positive number of days (got "${rawDays}")\n`);
    process.exit(1);
  }
  const entry: Record<string, string> = { id, username, hash: hashTokenSecret(secret) };
  if (label) entry.label = label;
  if (roles?.length) (entry as Record<string, unknown>).roles = roles;
  entry.created = new Date().toISOString().slice(0, 10);
  if (days !== undefined) {
    // Full timestamp, not a date: truncating to UTC midnight turns
    // `--days 1` minted this evening into a few hours.
    entry.expires = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  process.stdout.write(`\n  token — shown once, copy it now:\n\n    hzn_${id}_${secret}\n\n`);
  process.stdout.write(`  add this entry to auth.tokensFile:\n\n    ${JSON.stringify(entry)}\n\n`);
  process.stdout.write(
    roles?.length
      ? `  --roles is a CAP: this token holds the intersection of [${roles.join(', ')}] and\n` +
        `  whatever "${username}" currently holds. It can narrow their access, never widen it.\n\n`
      : `  roles are NOT stored here — they resolve from the user "${username}" on every\n` +
        `  request, so this token can never exceed their access, and removing the user\n` +
        `  revokes it. Pass --roles to cap it further.\n\n`,
  );
}

main();
