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
 * Resolve the live **OAP translation overlay** content for one
 * (kind, key, locale) — the operator-pushed per-locale row.
 *
 * Runtime translation is REMOTE-only: `localizeContent(content,
 * oapOverlay, locale)` applies this OAP overlay over the English source,
 * and nothing else — the disk `*.i18n.<lang>.json` files are seed / reset
 * / diff sources, never a render-time fill (same remote-first rule as
 * bundled templates). This helper gives the direct render routes the same
 * OAP overlay the config bundle uses. Reads the shared 30s sync cache, so
 * it's cheap on the hot path; soft-fails to `null` (→ English) on English
 * / no-client / OAP-unreachable / parse error.
 */

import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { Locale } from '../../i18n/index.js';
import { getSyncStatus, type TemplateRow } from './sync.js';
import { iterateBundledTemplates } from './aggregator.js';
import { parseEnvelope, type TemplateKind } from './names.js';
import { logger } from '../../logger.js';

/** Sync variant — for callers that already hold the sync rows (e.g. the
 *  menu's `layerSyncSnapshot`), so they don't re-hit `getSyncStatus`.
 *  Mirrors `findOverlayRow`: the live per-locale overlay row, not
 *  disabled. */
export function oapOverlayContentFromRows(
  rows: TemplateRow[],
  kind: TemplateKind,
  key: string,
  locale: Locale,
): unknown {
  if (locale === 'en') return null;
  for (const r of rows) {
    if (r.locale === locale && r.kind === kind && r.key === key && !!r.remote && !r.remote.disabled) {
      const env = parseEnvelope(r.remote.configuration);
      return env?.content ?? null;
    }
  }
  return null;
}

export async function oapOverlayContentFor(
  uiTemplateClient: (() => UITemplateClient) | undefined,
  kind: TemplateKind,
  key: string,
  locale: Locale,
): Promise<unknown> {
  if (locale === 'en' || !uiTemplateClient) return null;
  try {
    const sync = await getSyncStatus({
      client: uiTemplateClient(),
      bundled: () => iterateBundledTemplates(),
      logger,
    });
    if (sync.unreachable) return null;
    return oapOverlayContentFromRows(sync.rows, kind, key, locale);
  } catch {
    return null;
  }
}
