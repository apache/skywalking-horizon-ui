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
import type { HorizonConfig } from '../config/schema.js';

// Pre-computed dummy hash used to keep the timing path identical when a
// username does not exist. This blunts username-enumeration attacks.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$dummysaltdummysalt$dummyhashdummyhashdummyhashdummyhash';

export interface VerifiedUser {
  username: string;
  roles: string[];
  /** What to SHOW instead of `username`. Never an identity: roles and every
   *  permission check use `username` alone, because a display name is supplied
   *  by a directory or a provider and is not unique. */
  displayName?: string;
}

export async function verifyLocalCredentials(
  cfg: HorizonConfig,
  username: string,
  password: string,
): Promise<VerifiedUser | null> {
  const user = cfg.auth.local.users.find((u) => u.username === username);
  const hash = user?.passwordHash ?? DUMMY_HASH;
  let ok = false;
  try {
    ok = await argon2.verify(hash, password);
  } catch {
    ok = false;
  }
  if (!user || !ok) return null;
  return { username: user.username, roles: user.roles };
}
