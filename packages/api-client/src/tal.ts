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
 * Read-only TAL listing — `GET /runtime/tal/*`.
 *
 * TAL rules load once, at boot, from two lists: `talFiles` (OTLP spans,
 * filed under a layer) and `nativeTalFiles` (SkyWalking native segments,
 * run in their listed order). The listing names each file the way the
 * node filed it, without its extension, and carries every rule with its
 * layer, input and whether a debug session can install on it.
 * `/files/{name}` returns the file's YAML as `text/plain`, and `404`s in
 * plain text when the node loaded no such file.
 */

import { RuntimeRuleApiError, parseApiErrorBody } from './types.js';
import type { FetchLike } from './runtime-rule.js';

/** The setting that loaded a TAL file. */
export type TalFileList = 'talFiles' | 'nativeTalFiles';

/** The input a TAL rule reads: OTLP spans or SkyWalking native segments. */
export type TalInputType = 'otlp' | 'sw-native';

export interface TalRuleListing {
  name: string;
  layer: string;
  inputType: TalInputType;
  /** The rule's line in its file. */
  line: number;
  /** The rule's position in the native run order; absent for an OTLP rule. */
  order?: number;
  /** Whether a debug session can install on the rule: false when the node
   *  runs without the probes, or when two rules of the file share its name. */
  debuggable: boolean;
}

export interface TalFileListing {
  /** The name a debug session and `/files/{name}` take, without extension. */
  name: string;
  list: TalFileList;
  inputType: TalInputType;
  rules: TalRuleListing[];
}

export interface TalFilesResponse {
  files: TalFileListing[];
  count: number;
}

export interface TalClientOptions {
  /** OAP admin-server URL, e.g. `http://oap:17128`. No trailing slash. */
  adminUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Typed wrapper for the two read-only TAL endpoints. */
export class TalClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: TalClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = options.adminUrl.replace(/\/$/, '');
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /** `GET /runtime/tal/files` — every loaded file with its rules. */
  async listFiles(): Promise<TalFilesResponse> {
    const url = `${this.base}/runtime/tal/files`;
    const res = await this.send(url, { method: 'GET' });
    if (!res.ok) throw await this.toError(res, url);
    return (await res.json()) as TalFilesResponse;
  }

  /** `GET /runtime/tal/files/{name}` — the file's YAML (`text/plain`).
   *  Returns `null` when the node loaded no such file. */
  async getFileContent(name: string): Promise<string | null> {
    const url = `${this.base}/runtime/tal/files/${encodeURIComponent(name)}`;
    const res = await this.send(url, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toError(res, url);
    return await res.text();
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain',
      ...this.defaultHeaders,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    const finalInit: RequestInit = { ...init, headers };
    if (this.timeoutMs > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await this.fetchImpl(url, { ...finalInit, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    }
    return this.fetchImpl(url, finalInit);
  }

  private async toError(res: Response, url: string): Promise<RuntimeRuleApiError> {
    return new RuntimeRuleApiError(res.status, parseApiErrorBody(await res.text()), url);
  }
}
