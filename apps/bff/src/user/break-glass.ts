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
 * Break-glass login. Honored ONLY when:
 *   - the active backend is LDAP, AND
 *   - LDAP is currently unreachable (a probe failed), AND
 *   - `auth.breakGlass` is populated in the config.
 *
 * Caller is responsible for the LDAP-unreachable precondition; this
 * module just verifies the password and shapes the verified user.
 */

import argon2 from 'argon2';
import type { BreakGlassConfig } from '../config/schema.js';
import type { VerifiedUser } from './local.js';

const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$dummysaltdummysalt$dummyhashdummyhashdummyhashdummyhash';

export async function verifyBreakGlass(
  cfg: BreakGlassConfig,
  username: string,
  password: string,
): Promise<VerifiedUser | null> {
  // Username mismatch still incurs the argon2 cost to blunt timing leaks.
  const target = username === cfg.username ? cfg.passwordHash : DUMMY_HASH;
  let ok = false;
  try {
    ok = await argon2.verify(target, password);
  } catch {
    ok = false;
  }
  if (!ok || username !== cfg.username) return null;
  return { username: cfg.username, roles: cfg.roles };
}
