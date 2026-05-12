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

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '../logger.js';

export interface AuditEvent {
  ts: string; // ISO-8601
  actor: string;
  action: string; // e.g. "rule.addOrUpdate", "auth.login", "role.update"
  target?: string;
  outcome: 'success' | 'failure';
  details?: Record<string, unknown>;
}

export class AuditLogger {
  private stream: WriteStream | null = null;
  private readonly absPath: string;

  constructor(filePath: string) {
    this.absPath = resolve(filePath);
  }

  async open(): Promise<void> {
    await mkdir(dirname(this.absPath), { recursive: true });
    this.stream = createWriteStream(this.absPath, { flags: 'a' });
    this.stream.on('error', (err) => logger.error({ err }, 'audit stream error'));
  }

  record(evt: Omit<AuditEvent, 'ts'>): void {
    const line: AuditEvent = { ts: new Date().toISOString(), ...evt };
    if (!this.stream) {
      logger.warn({ evt: line }, 'audit logged before open()');
      return;
    }
    this.stream.write(JSON.stringify(line) + '\n');
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolveDone) => this.stream!.end(() => resolveDone()));
    this.stream = null;
  }
}
