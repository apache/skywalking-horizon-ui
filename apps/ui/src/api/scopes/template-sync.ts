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
 * `bff.templateSync` — admin-page surface for the OAP UI-template
 * overlay. The simpler badge-only view used by per-page banners lives
 * inside the bundle (`bff.configs.bundle().syncStatus`); this scope
 * gives the admin pages full-fat rows (bundled + remote configuration
 * strings) for inline diff + adopt/push actions.
 */

import type { BffClient } from '../client';
import type { TemplateKind, TemplateProblem, TemplateStatus } from './configs';

export interface TemplateSyncRow {
  name: string;
  kind: TemplateKind;
  key: string;
  /** Set on per-locale translation overlay rows (`<name>.i18n.<locale>`).
   *  Unset on source rows. Pages that only care about source rows must
   *  filter `locale === undefined`. */
  locale?: string;
  status: TemplateStatus;
  /** What the BFF renders from. `null` means nothing renders this row: it is
   *  disabled, or not readable as the template it is stored as (the BFF also
   *  reports that one on the bundle's `unreadable` list, which is where the
   *  admin banner names it — these rows are the editor's content sources and
   *  carry their `remote` either way, so it can diff and push over it). */
  effective: 'remote' | 'bundled' | null;
  /** Why the stored content cannot be served. Set with status `invalid`, and
   *  on a disabled row whose content would fail too — turning that row back on
   *  must start from the shipped default, never from its own content. */
  problems?: TemplateProblem[];
  remote: { id: string; configuration: string; disabled: boolean } | null;
  bundled: { configuration: string } | null;
}

export interface TemplateSyncStatus {
  /** `live` = OAP ui_template store; `readonly` = local bundle, read-only. */
  mode: 'live' | 'readonly';
  unreachable: boolean;
  lastSuccessfulSyncAt: number | null;
  generatedAt: number;
  rows: TemplateSyncRow[];
}

export class TemplateSyncApi {
  constructor(private readonly bff: BffClient) {}

  /** Full merged status for ALL template kinds. Admin pages filter to
   *  the kind they own. `force` bypasses the BFF's 30s sync cache and
   *  re-reads OAP before responding — admin views default to forced so
   *  operator edits round-trip without seeing stale state. */
  syncStatus(force = false): Promise<TemplateSyncStatus> {
    const qs = force ? '?force=true' : '';
    return this.bff.request<TemplateSyncStatus>('GET', `/api/admin/templates/sync-status${qs}`);
  }

  /** Force the BFF to invalidate its 30s cache + refetch from OAP. */
  resync(): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>('POST', '/api/admin/templates/resync');
  }

  /** Translation overlays for a template + locale.
   *   - `disk`: sibling `*.i18n.<lang>.json` shipped with the BFF.
   *   - `oap`:  per-locale overlay row on OAP at
   *             `<name>.i18n.<locale>`, written by previous operator
   *             pushes. `null` when no operator has pushed yet.
   *   Both are `null` for English or unknown templates. */
  overlay(
    name: string,
    locale: string,
  ): Promise<{ disk: unknown; oap: unknown; oapProblems?: TemplateProblem[] }> {
    return this.bff.request<{ disk: unknown; oap: unknown; oapProblems?: TemplateProblem[] }>(
      'GET',
      `/api/admin/templates/${encodeURIComponent(name)}/i18n/${encodeURIComponent(locale)}`,
    );
  }

  /** The checks a save would run, without saving. An overlay name
   *  (`<name>.i18n.<locale>`) is checked against its source template. */
  validate(name: string, content: unknown): Promise<{ problems: TemplateProblem[] }> {
    return this.bff.request<{ problems: TemplateProblem[] }>('POST', '/api/admin/templates/validate', {
      name,
      content,
    });
  }

  /** Push the operator's translation overlay for ONE locale to OAP as a
   *  sibling row (`<name>.i18n.<locale>`). Leaves the source row alone.
   *  Same propagation-confirm + 504 chain as `save()`. */
  saveTranslation(name: string, locale: string, content: unknown): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>(
      'POST',
      '/api/admin/templates/save-translation',
      { name, locale, content },
    );
  }

  /** Soft-delete the per-locale overlay row so this locale falls back
   *  to the disk catalog. OAP has no hard delete; the row is disabled. */
  deleteTranslation(name: string, locale: string): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>(
      'POST',
      '/api/admin/templates/delete-translation',
      { name, locale },
    );
  }


  /** Save a template's content to OAP. The BFF wraps it in the canonical
   *  envelope. 409 when OAP is unreachable — the page banner should have
   *  prevented the call, but server-side guard catches operator scripts. */
  save(name: string, content: unknown): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>('POST', '/api/admin/templates/save', {
      name,
      content,
    });
  }

  /** "Delete" a template — OAP has no hard DELETE, so this soft-disables
   *  the remote UI-template. The BFF refuses (409 `bundled_not_deletable`)
   *  when the template ships a bundled default; only remote-only templates
   *  are genuinely removable. Returns the fresh sync status. */
  disable(name: string): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>('POST', '/api/admin/templates/disable', {
      name,
    });
  }

  /** Turn a disabled record back on with the content it holds — valid or
   *  not. Returns the fresh sync status. */
  enable(name: string): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>('POST', '/api/admin/templates/enable', {
      name,
    });
  }

  /** Operator wants the bundled JSON to overwrite whatever OAP has for
   *  this name. Used for "adopt my code defaults" from the diff view. */
  pushBundled(name: string): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>(
      'POST',
      `/api/admin/templates/${encodeURIComponent(name)}/push-bundled`,
    );
  }

  /** Push the bundled copy of every template that differs from OAP
   *  (`diverged`) or is absent on OAP (`bundled-fallback`), in one batch.
   *  Scoped to `kind` so each admin page syncs only its own family. The
   *  BFF re-derives the diff set, so this is a no-op for already-synced
   *  templates. Returns the fresh status plus what was pushed. */
  syncAll(kind?: TemplateKind): Promise<TemplateSyncAllResult> {
    return this.bff.request<TemplateSyncAllResult>(
      'POST',
      '/api/admin/templates/sync-all',
      kind ? { kind } : {},
    );
  }
}

export interface TemplateSyncAllResult extends TemplateSyncStatus {
  /** Template names successfully pushed to OAP. */
  synced: string[];
  /** Templates that failed to push, with the error message. */
  failed: Array<{ name: string; error: string }>;
}
