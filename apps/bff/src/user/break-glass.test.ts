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

import argon2 from 'argon2';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BreakGlassConfig } from '../config/schema.js';
import { verifyBreakGlass } from './break-glass.js';

const PW = 'correct-horse-battery-staple';
let cfg: BreakGlassConfig;

beforeAll(async () => {
  cfg = {
    username: 'emergency',
    passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
    roles: ['admin'],
  };
});

describe('verifyBreakGlass', () => {
  it('accepts the configured username + password', async () => {
    const v = await verifyBreakGlass(cfg, 'emergency', PW);
    expect(v).toEqual({ username: 'emergency', roles: ['admin'] });
  });

  it('rejects a wrong password', async () => {
    expect(await verifyBreakGlass(cfg, 'emergency', 'nope')).toBeNull();
  });

  it('rejects a different username even with the right password', async () => {
    expect(await verifyBreakGlass(cfg, 'admin', PW)).toBeNull();
  });

  it('returns null for a malformed hash without throwing', async () => {
    const broken: BreakGlassConfig = { ...cfg, passwordHash: 'not-a-hash' };
    expect(await verifyBreakGlass(broken, 'emergency', PW)).toBeNull();
  });
});
