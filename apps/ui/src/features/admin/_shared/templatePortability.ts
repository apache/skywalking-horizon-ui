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
 * Client-side import / export for dashboard templates (overview / layer /
 * 3D-map), shared by the three admin pages.
 *
 *   - EXPORT downloads the *in-use* version (what end users render: the
 *     OAP-live copy, else the bundled default) wrapped in the canonical OAP
 *     envelope `{ name, kind, version, content }`, so the file is
 *     self-describing and round-trips back through import.
 *   - IMPORT reads a file, validates it for the target page's `kind`, and
 *     returns the BARE inner content to stage as a browser-local draft.
 *     `localEdits` and `bff.templateSync.save` both take bare content (the
 *     BFF re-wraps the envelope on save), so import must unwrap.
 *
 * The envelope shape mirrors the BFF's `logic/templates/names.ts`; it is
 * duplicated inline because UI code can't import server modules. Import
 * tolerates either an envelope or a hand-authored bare-content file, and
 * derives the target key from the envelope name's tail (handled by the
 * caller via the returned `key`) or the content's own `id` / `key`.
 */

import type { TemplateKind } from '@/api/scopes/configs';

/** Canonical OAP template envelope. `version` is the wrapper's schema
 *  version, not the inner content's. */
interface TemplateEnvelope {
  name: string;
  kind: TemplateKind;
  version: number;
  content: unknown;
}

const ENVELOPE_VERSION = 1;

/** Wrap a template's content for export. `name` is the canonical
 *  `horizon.<kind>.<key>` the OAP row is keyed by. */
export function buildExportEnvelope(
  kind: TemplateKind,
  name: string,
  content: unknown,
): TemplateEnvelope {
  return { name, kind, version: ENVELOPE_VERSION, content };
}

/** Trigger a browser download of `obj` as pretty-printed JSON. */
export function downloadJson(filename: string, obj: unknown): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click is committed — Safari aborts the download if the
  // object URL is freed synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Open the OS file picker for a single JSON file and resolve its text.
 *  Resolves `null` when the operator cancels or picks nothing — a cancelled
 *  picker fires no `change` on most browsers, so callers must treat `null`
 *  as "no file" rather than awaiting forever. */
export function pickJsonFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then(resolve).catch(() => resolve(null));
    });
    document.body.appendChild(input);
    input.click();
  });
}

export type ImportResult =
  | { ok: true; key: string; content: unknown }
  | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Human label per kind — used in cross-kind rejection messages. */
const KIND_LABEL: Record<TemplateKind, string> = {
  overview: 'overview dashboard',
  layer: 'layer dashboard',
  alert: 'alert page',
  theme: 'theme',
  'time-defaults': 'time defaults',
  'infra-3d': '3D-map config',
};

/** Structural sniff + target-key derivation per kind. This is a guard
 *  against importing the wrong file into the wrong page, NOT full schema
 *  validation — the deep checks (e.g. the 3D-map zod schema) run
 *  server-side when the operator pushes the draft to OAP. */
function validateContent(
  kind: TemplateKind,
  content: unknown,
): { ok: true; key: string } | { ok: false; error: string } {
  if (!isObject(content)) {
    return { ok: false, error: 'The template content is not a JSON object.' };
  }
  if (kind === 'overview') {
    if (typeof content.id !== 'string' || !content.id) {
      return { ok: false, error: 'Not an overview dashboard — missing a string "id".' };
    }
    if (!Array.isArray(content.widgets)) {
      return { ok: false, error: 'Not an overview dashboard — missing a "widgets" array.' };
    }
    return { ok: true, key: content.id };
  }
  if (kind === 'layer') {
    if (typeof content.key !== 'string' || !content.key) {
      return { ok: false, error: 'Not a layer dashboard — missing a string "key".' };
    }
    return { ok: true, key: content.key.toUpperCase() };
  }
  if (kind === 'infra-3d') {
    if (!Array.isArray(content.levels) || !isObject(content.layers) || !isObject(content.filter)) {
      return { ok: false, error: 'Not a 3D-map config — missing "levels" / "layers" / "filter".' };
    }
    return { ok: true, key: 'config' };
  }
  return { ok: false, error: `Import is not supported for ${KIND_LABEL[kind]} templates.` };
}

/** Parse + validate an imported file's text for the page's `kind`. Accepts
 *  the export envelope or a bare-content file; returns the bare inner
 *  content (never the envelope) plus the derived target key. */
export function validateImport(kind: TemplateKind, text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  if (!isObject(parsed)) {
    return { ok: false, error: 'The file is not a JSON object.' };
  }

  // Envelope (has a `kind` discriminator + `content`): reject cross-kind
  // before touching the inner content, then unwrap it.
  let content: unknown = parsed;
  if (typeof parsed.kind === 'string' && 'content' in parsed) {
    if (parsed.kind !== kind) {
      const got = KIND_LABEL[parsed.kind as TemplateKind] ?? parsed.kind;
      return {
        ok: false,
        error: `This file is a ${got} template — open the matching admin page to import it.`,
      };
    }
    content = parsed.content;
  }

  const v = validateContent(kind, content);
  if (!v.ok) return v;
  return { ok: true, key: v.key, content };
}

/* ── Per-locale translation overlays ──────────────────────────────────
 * Translations live on the Translations page as their own OAP rows
 * (`horizon.<kind>.<key>.i18n.<locale>`), separate from the source
 * template. Their import/export is therefore separate too — these
 * helpers mirror the template ones for the overlay shape. Only
 * overview + layer templates carry overlays. */

/** Kinds that have translation overlays (the Translations page scope). */
type OverlayKind = 'overview' | 'layer';

/** Export envelope for a per-locale overlay. Adds `locale` and the
 *  `.i18n.<locale>` name tail (mirrors the BFF's buildOverlayEnvelope). */
export function buildOverlayExportEnvelope(
  kind: OverlayKind,
  sourceName: string,
  locale: string,
  content: unknown,
): TemplateEnvelope & { locale: string } {
  return { name: `${sourceName}.i18n.${locale}`, kind, version: ENVELOPE_VERSION, locale, content };
}

export type OverlayImportResult =
  | {
      ok: true;
      /** Present when the file is a Horizon overlay envelope — the import
       *  then targets THIS (template, locale). Absent for a bare overlay,
       *  which targets the page's current selection. */
      kind?: OverlayKind;
      sourceName?: string;
      locale?: string;
      content: Record<string, unknown>;
    }
  | { ok: false; error: string };

/** Parse + validate an imported translation file. Accepts a Horizon
 *  overlay envelope (carries kind + name + locale → targets its own
 *  template/locale) or a bare overlay object (no metadata → the caller
 *  applies it to the current selection). The discriminator that proves a
 *  file is an *overlay* and not a source template is the presence of a
 *  locale (explicit field or the `.i18n.<locale>` name tail) — a source
 *  envelope has neither, and is rejected here. */
export function parseOverlayImport(text: string): OverlayImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  if (!isObject(parsed)) {
    return { ok: false, error: 'The file is not a JSON object.' };
  }
  if (typeof parsed.kind === 'string' && 'content' in parsed) {
    const kind = parsed.kind;
    if (kind !== 'overview' && kind !== 'layer') {
      const got = KIND_LABEL[kind as TemplateKind] ?? kind;
      return { ok: false, error: `Translations apply to overview / layer templates — this file is a ${got}.` };
    }
    if (!isObject(parsed.content)) {
      return { ok: false, error: 'The translation content is not a JSON object.' };
    }
    let locale = typeof parsed.locale === 'string' ? parsed.locale : undefined;
    let sourceName: string | undefined;
    if (typeof parsed.name === 'string') {
      const m = /^(.*)\.i18n\.([A-Za-z][A-Za-z0-9-]*)$/.exec(parsed.name);
      if (m) {
        sourceName = m[1];
        locale = locale ?? m[2];
      } else {
        sourceName = parsed.name;
      }
    }
    if (!locale) {
      return {
        ok: false,
        error: 'This looks like a source template, not a translation — import it on its own template page.',
      };
    }
    return { ok: true, kind, sourceName, locale, content: parsed.content };
  }
  // Bare overlay object — no metadata; target the current selection.
  return { ok: true, content: parsed };
}
