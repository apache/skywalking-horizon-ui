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
 * Render-side entry points for translation overlays. The merge itself
 * lives in `@skywalking-horizon-ui/api-client` (`template-i18n.ts`) so
 * the admin editor's preview and this render path can never disagree
 * about what a locale shows — read that module for the merge semantics
 * (id-addressed widgets, source-shape preservation, drift-safety, leaf
 * fallback to English).
 */

import { mergeLocalizedNode } from '@skywalking-horizon-ui/api-client';

export { mergeLocalizedNode } from '@skywalking-horizon-ui/api-client';

/**
 * Generic localize: returns the source unchanged for English or when no
 * overlay exists; otherwise returns a deep-merged copy.
 *
 * The returned object is structurally a fresh tree — callers can mutate
 * it without bleeding back into the cached source. The English path is
 * a reference-equality return; callers should treat it as read-only
 * (every caller in the codebase does today).
 */
export function localize<T>(source: T, overlay: unknown, locale: string): T {
  if (locale === 'en' || overlay === null || overlay === undefined) return source;
  return mergeLocalizedNode(source, overlay) as T;
}

/**
 * Localize a layer / overview template against its **OAP** translation
 * overlay row (`horizon.<kind>.<key>.i18n.<locale>`), most-specific-wins
 * per leaf: the OAP overlay value, else the English source.
 *
 * Runtime is REMOTE-only. The disk `*.i18n.<lang>.json` files are
 * seed/reset defaults — boot-seed pushes each as a sibling OAP overlay
 * row — NOT a render-time fill. So a key the OAP overlay doesn't carry
 * falls through to **English**, never to the disk-shipped translation;
 * the bundled overlay reaches the UI only by being synced to OAP, exactly
 * like bundled templates. (Operators who want the full shipped
 * translation reset-to-bundled, which re-seeds the OAP row.)
 *
 * Defensive: any embedded `i18n` block on the source content is stripped
 * before the merge — the split layout never writes embedded i18n.
 */
export function localizeContent<T>(content: T, oapOverlay: unknown, locale: string): T {
  let source: T = content;
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as unknown as Record<string, unknown>;
    if ('i18n' in record) {
      const { i18n: _ignored, ...rest } = record;
      void _ignored;
      source = rest as unknown as T;
    }
  }
  if (locale === 'en' || oapOverlay === null || oapOverlay === undefined) return source;
  return mergeLocalizedNode(source, oapOverlay) as T;
}
