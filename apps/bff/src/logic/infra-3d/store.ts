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
 * File-backed live store for the 3D Infrastructure Map config. Mirrors
 * `AlarmsStore` and `SetupStore`:
 *   - first `load()` reads the file once, caches it, and falls back to
 *     the bundled defaults on missing or unparseable file
 *   - `save()` writes via `.tmp` + rename so a concurrent reader never
 *     observes a half-written file
 *
 * Bundled-vs-saved policy: a missing store file means "no admin override
 * has been recorded" → return bundled defaults verbatim. A saved file
 * fully replaces the bundled config; partial overrides at the field level
 * are NOT supported (the Monaco YAML editor sends a complete document).
 * Keeps the merge surface zero — the admin sees exactly what's on disk.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '../../logger.js';
import { loadBundledInfra3dConfig } from './bundled.js';
import { validateInfra3dConfig } from './validate.js';
import type { Infra3dConfig } from './types.js';

export class Infra3dStore {
  private readonly absPath: string;
  private cache: Infra3dConfig | null = null;
  private writing: Promise<void> | null = null;

  constructor(filePath: string) {
    this.absPath = resolve(filePath);
  }

  async load(): Promise<Infra3dConfig> {
    if (this.cache) return this.cache;
    if (!existsSync(this.absPath)) {
      this.cache = cloneConfig(loadBundledInfra3dConfig());
      return this.cache;
    }
    try {
      const raw = await readFile(this.absPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const validated = validateInfra3dConfig(parsed);
      if (!validated.ok) {
        logger.warn(
          { path: this.absPath, issues: validated.issues },
          'infra-3d store validation failed; using bundled defaults',
        );
        this.cache = cloneConfig(loadBundledInfra3dConfig());
        return this.cache;
      }
      this.cache = validated.value;
      return this.cache;
    } catch (err) {
      logger.warn({ err, path: this.absPath }, 'infra-3d store unreadable; using bundled defaults');
      this.cache = cloneConfig(loadBundledInfra3dConfig());
      return this.cache;
    }
  }

  async save(next: Infra3dConfig): Promise<void> {
    // Validate again at the store edge — defence in depth. The HTTP
    // route validates the inbound body too, but callers reaching the
    // store directly (CLI, tests) shouldn't be able to persist garbage.
    const validated = validateInfra3dConfig(next);
    if (!validated.ok) {
      throw new Error(`infra-3d config rejected: ${validated.issues.join('; ')}`);
    }
    while (this.writing) await this.writing;
    const snapshot = cloneConfig(validated.value);
    const tmp = `${this.absPath}.tmp`;
    const work = (async () => {
      await mkdir(dirname(this.absPath), { recursive: true });
      await writeFile(tmp, JSON.stringify({ generatedAt: Date.now(), ...snapshot }, null, 2), 'utf8');
      await rename(tmp, this.absPath);
      this.cache = snapshot;
    })();
    this.writing = work;
    try {
      await work;
    } finally {
      this.writing = null;
    }
  }

  /** Force the next `load()` to re-read from disk. Used by the admin
   *  "reset to bundled defaults" path and by tests. */
  invalidate(): void {
    this.cache = null;
  }
}

function cloneConfig(cfg: Infra3dConfig): Infra3dConfig {
  // Structured clone keeps the cache and the returned reference
  // distinct so a route that mutates the response (legal — they own
  // their copy) can't corrupt the cached object.
  return JSON.parse(JSON.stringify(cfg)) as Infra3dConfig;
}
