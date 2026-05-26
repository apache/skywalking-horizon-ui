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
import type { TemplateKind, TemplateStatus } from './configs';

export interface TemplateSyncRow {
  name: string;
  kind: TemplateKind;
  key: string;
  /** Set on per-locale translation overlay rows (`<name>.i18n.<locale>`).
   *  Unset on source rows. Pages that only care about source rows must
   *  filter `locale === undefined`. */
  locale?: string;
  status: TemplateStatus;
  effective: 'remote' | 'bundled' | null;
  remote: { id: string; configuration: string; disabled: boolean } | null;
  bundled: { configuration: string } | null;
}

export interface TemplateSyncStatus {
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
  overlay(name: string, locale: string): Promise<{ disk: unknown; oap: unknown }> {
    return this.bff.request<{ disk: unknown; oap: unknown }>(
      'GET',
      `/api/admin/templates/${encodeURIComponent(name)}/i18n/${encodeURIComponent(locale)}`,
    );
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

  /** For every envelope name with >1 enabled OAP row, disable all but
   *  the lowest-UUID winner. Returns the fresh status + the list of
   *  disabled UUIDs + any failures. */
  resolveConflicts(): Promise<TemplateSyncStatus & { disabled: string[]; failed: Array<{ name: string; id: string; error: string }> }> {
    return this.bff.request('POST', '/api/admin/templates/resolve-conflicts');
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

  /** Save a template to the LOCAL bundled file (not OAP). The template
   *  immediately renders locally and shows as `diverged` until pushed to
   *  OAP via {@link syncAll}. This is the edit-locally→preview→publish
   *  path; `save()` (direct-to-OAP) is retained for callers that want it. */
  saveLocal(name: string, content: unknown): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>('POST', '/api/admin/templates/save-local', {
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

  /** Operator wants the bundled JSON to overwrite whatever OAP has for
   *  this name. Used for "adopt my code defaults" from the diff view. */
  pushBundled(name: string): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>(
      'POST',
      `/api/admin/templates/${encodeURIComponent(name)}/push-bundled`,
    );
  }

  /** Discard local edits: overwrite the bundled file with the REMOTE
   *  (live) version for every diverged template. The "use live, override
   *  local" reconciliation. Optionally scoped by `kind`. */
  revertLocal(kind?: TemplateKind): Promise<TemplateSyncStatus> {
    return this.bff.request<TemplateSyncStatus>(
      'POST',
      '/api/admin/templates/revert-local',
      kind ? { kind } : {},
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
