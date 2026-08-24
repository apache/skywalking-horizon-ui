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

import { stdin } from 'node:process';
import { createInterface } from 'node:readline';
import argon2 from 'argon2';

/**
 * One line from stdin, whether it was typed or piped.
 *
 * Reading to end-of-stream instead left the interactive form hanging on ENTER
 * — a terminal sends no EOF — so the documented `pnpm --filter bff cli:hash`
 * never returned. readline ends on the newline, and still flushes a partial
 * final line, so `printf 'pw' | cli:hash` with no trailing newline works too.
 */
function readPassword(): Promise<string> {
  const rl = createInterface({ input: stdin });
  return new Promise((resolve) => {
    // Resolve BEFORE close(): close() emits 'close' synchronously, so the
    // end-of-stream fallback below would otherwise settle it with '' first and
    // every invocation would print usage.
    rl.on('line', (line) => {
      resolve(line);
      rl.close();
    });
    rl.on('close', () => resolve(''));
  });
}

/** The login route refuses anything longer, so a hash of it could never be
 *  signed in with. Refusing here turns a silent lockout into a message. */
const MAX_PASSWORD_CHARS = 64;

async function main(): Promise<void> {
  const arg = process.argv[2];
  const password = arg ?? (await readPassword());
  if (!password) {
    process.stderr.write('usage: hash <password> | echo <password> | hash\n');
    process.exit(1);
  }
  if (password.length > MAX_PASSWORD_CHARS) {
    process.stderr.write(
      `password is ${password.length} characters; sign-in accepts at most ${MAX_PASSWORD_CHARS}\n`,
    );
    process.exit(1);
  }
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  process.stdout.write(hash + '\n');
}

main().catch((err) => {
  process.stderr.write(`hash failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
