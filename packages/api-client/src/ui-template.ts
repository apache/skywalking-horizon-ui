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
 * OAP admin's `/ui-management/templates*` REST surface.
 *
 * OAP stores each dashboard / page-setup blob keyed by a server-allocated
 * UUID; the *meaning* of the blob is opaque to OAP. Horizon names its
 * templates with a reserved prefix (`horizon.overview.*`, `horizon.layer.*`,
 * `horizon.alert.*`) inside the `configuration` JSON so multiple UIs can
 * share an OAP without colliding. Identity for sync purposes is that
 * inner `name` field — not the OAP UUID, which is a storage detail.
 *
 * No DELETE endpoint exists upstream; soft-deletion is `POST .../{id}/disable`.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface UITemplateClientOptions {
  adminUrl: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** One row as returned by OAP. `configuration` is an opaque JSON string —
 *  callers must `JSON.parse` it to read the inner `name`. */
export interface UITemplateRow {
  id: string;
  configuration: string;
  disabled: boolean;
}

/** Reply to add/update/disable mutations. `id` is the OAP UUID. */
export interface TemplateChangeStatus {
  id: string;
  status: boolean;
  message: string;
}

export class UITemplateApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body?: string;
  constructor(status: number, url: string, body?: string) {
    super(`UITemplate ${status} ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    this.name = 'UITemplateApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class UITemplateClient {
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: UITemplateClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = options.adminUrl.replace(/\/$/, '');
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /** `GET /ui-management/templates?includingDisabled=true`. We always pass
   *  the flag so the sync orchestrator can see disabled rows and surface
   *  them in the admin UI. */
  async list(): Promise<UITemplateRow[]> {
    return this.json<UITemplateRow[]>('/ui-management/templates?includingDisabled=true', {
      method: 'GET',
    });
  }

  /** `POST /ui-management/templates`.
   *
   *  `id` is the envelope name (`horizon.<kind>.<key>` for source rows,
   *  `horizon.<kind>.<key>.i18n.<locale>` for translation overlay
   *  rows). Upstream skywalking#13884 made `id` REQUIRED — OAP no
   *  longer auto-generates one. Old OAP releases ignored the field, so
   *  the same payload is forward- and backward-compatible: against
   *  legacy OAP the create still works (server assigns a UUID and
   *  echoes it back in `ack.id`); against current OAP the row lands at
   *  the requested id, which we already treat as the row's wire
   *  handle in `ack.id`. */
  async create(id: string, configuration: string): Promise<TemplateChangeStatus> {
    return this.json<TemplateChangeStatus>('/ui-management/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, configuration }),
    });
  }

  /** `PUT /ui-management/templates` — replaces by id. */
  async update(id: string, configuration: string): Promise<TemplateChangeStatus> {
    return this.json<TemplateChangeStatus>('/ui-management/templates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, configuration }),
    });
  }

  /** `POST /ui-management/templates/{id}/disable` — soft-delete. */
  async disable(id: string): Promise<TemplateChangeStatus> {
    return this.json<TemplateChangeStatus>(
      `/ui-management/templates/${encodeURIComponent(id)}/disable`,
      { method: 'POST' },
    );
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.base}${path}`;
    const headers = { Accept: 'application/json', ...this.defaultHeaders, ...init.headers };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let finalInit: RequestInit = { ...init, headers };
    if (this.timeoutMs > 0) {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      finalInit = { ...finalInit, signal: ctrl.signal };
    }
    try {
      const res = await this.fetchImpl(url, finalInit);
      if (!res.ok) {
        const body = await res.text();
        throw new UITemplateApiError(res.status, url, body);
      }
      return (await res.json()) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
