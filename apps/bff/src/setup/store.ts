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

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { LayerConfig } from '@skywalking-horizon-ui/api-client';
import { logger } from '../logger.js';

/**
 * File-backed store for per-layer setup overrides.
 *
 * Holds only what the operator has changed away from defaults. Defaults
 * live in horizon's frontend (and a soon-to-come BFF defaults table) so
 * the stored JSON stays sparse and human-readable.
 *
 * Future swap-point: replace this implementation with one that writes
 * to OAP via `addTemplate` mutations under the `horizon-` prefix, once
 * horizon's runtime template format is ready and operators have
 * `core.enableUpdateUITemplate: true` flipped on. The interface below
 * is what callers code against.
 */
export class SetupStore {
  private readonly absPath: string;
  private cache: Record<string, LayerConfig> | null = null;
  private writing: Promise<void> | null = null;

  constructor(filePath: string) {
    this.absPath = resolve(filePath);
  }

  async load(): Promise<Record<string, LayerConfig>> {
    if (this.cache) return this.cache;
    if (!existsSync(this.absPath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const raw = await readFile(this.absPath, 'utf8');
      const parsed = JSON.parse(raw) as { layers?: Record<string, LayerConfig> } | Record<string, LayerConfig>;
      // Tolerate both `{layers: {...}}` and the bare map for forward-compat.
      const layers = (parsed as { layers?: Record<string, LayerConfig> }).layers ?? (parsed as Record<string, LayerConfig>);
      this.cache = layers && typeof layers === 'object' ? layers : {};
      return this.cache;
    } catch (err) {
      logger.warn({ err, path: this.absPath }, 'setup store unreadable; starting empty');
      this.cache = {};
      return this.cache;
    }
  }

  async save(layers: Record<string, LayerConfig>): Promise<void> {
    // Serialize writes — multiple concurrent POSTs from the UI shouldn't
    // race against each other.
    while (this.writing) await this.writing;
    const tmp = `${this.absPath}.tmp`;
    const next: Record<string, LayerConfig> = JSON.parse(JSON.stringify(layers));
    const work = (async () => {
      await mkdir(dirname(this.absPath), { recursive: true });
      await writeFile(
        tmp,
        JSON.stringify({ generatedAt: Date.now(), layers: next }, null, 2),
        'utf8',
      );
      await rename(tmp, this.absPath);
      this.cache = next;
    })();
    this.writing = work.finally(() => {
      this.writing = null;
    });
    await this.writing;
  }

  /** Force reload from disk — useful when an admin edits the JSON externally. */
  invalidate(): void {
    this.cache = null;
  }
}
