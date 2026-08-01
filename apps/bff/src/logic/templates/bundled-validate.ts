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
 * Build-time validator for the templates bundled in this repo. Runs the
 * structural schemas (`bundled-schema.ts`) over every layer + overview file,
 * then the cross-reference checks a schema cannot express — the ones that name
 * something elsewhere in the same file. A layer's share those with the admin
 * publish boundary (`layerCrossRefIssues`); on top of them, bundled-only:
 *
 *   - a column with no `mqe` must resolve through the built-in metric
 *     catalog for its layer, or its cell can only ever be an em-dash.
 *   - a widget field the loader tolerates and drops is a defect in shipped
 *     config, however harmless it is in an operator's own dashboard.
 *   - an overview `rankBy.kpi` must index into that widget's `kpis`, and
 *     every referenced layer must have a bundled template.
 *   - a bundled overview's `id` must equal its filename stem: translation
 *     overlays are stored per FILENAME but looked up per dashboard ID, so a
 *     mismatch silently renders that dashboard English-only in every locale.
 *
 * Findings are returned rather than thrown so one run reports every file.
 * `bundled-validate-cli.ts` turns them into a non-zero exit for CI; the
 * sibling test asserts the shipped bundle is clean.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodError } from 'zod';
import { isOverlayFilename } from '../../i18n/store.js';
import { widgetSchema } from '../dashboard/schema.js';
import { expressionForServiceMetric } from '../../util/mqe-catalog.js';
import { layerCrossRefIssues, layerTemplateSchema, overviewTemplateSchema } from './bundled-schema.js';

export interface TemplateFinding {
  /** `layers/kafka.json` — relative to the bundled-templates root. */
  file: string;
  /** Dotted path within the file, `''` for a whole-file finding. */
  path: string;
  message: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ROOT = join(__dirname, '..', '..', 'bundled_templates');

interface SourceFile {
  /** `kafka` for `kafka.json`. */
  stem: string;
  /** `layers/kafka.json`. */
  label: string;
  content: unknown;
}

/** Read every non-overlay `*.json` in `<root>/<dir>`, reporting parse
 *  errors as findings instead of throwing. */
function readSources(root: string, dir: string, findings: TemplateFinding[]): SourceFile[] {
  const out: SourceFile[] = [];
  const abs = join(root, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch (err) {
    findings.push({
      file: dir,
      path: '',
      message: `cannot read bundled-template directory: ${err instanceof Error ? err.message : err}`,
    });
    return out;
  }
  for (const file of entries.sort()) {
    if (!file.endsWith('.json') || isOverlayFilename(file)) continue;
    const label = `${dir}/${file}`;
    try {
      out.push({
        stem: basename(file, '.json'),
        label,
        content: JSON.parse(readFileSync(join(abs, file), 'utf-8')),
      });
    } catch (err) {
      findings.push({
        file: label,
        path: '',
        message: `parse error: ${err instanceof Error ? err.message : err}`,
      });
    }
  }
  return out;
}

function pushZodIssues(err: ZodError, file: string, findings: TemplateFinding[]): void {
  for (const issue of err.issues) {
    findings.push({ file, path: issue.path.join('.'), message: issue.message });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Widget-level checks the shared `widgetSchema` cannot report, because it
 * is deliberately TOLERANT at runtime: it strips unknown keys and maps a
 * malformed `visibleWhen` / `traceDrill` to `undefined` rather than failing
 * an operator's stored dashboard. Both are defects in a bundled file, so we
 * diff the raw widget against the parsed one — no second schema to keep in
 * sync.
 */
function checkWidgetFidelity(
  raw: unknown,
  parsed: unknown,
  file: string,
  path: string,
  findings: TemplateFinding[],
): void {
  if (!isRecord(raw) || !isRecord(parsed)) return;
  for (const key of Object.keys(raw)) {
    // A key the parse kept is fine. One that came back `undefined` was
    // either stripped (unknown field) or `.catch()`-ed (malformed gate) —
    // JSON cannot express `undefined`, so the raw side always had a value.
    if (parsed[key] !== undefined) continue;
    findings.push({
      file,
      path: `${path}.${key}`,
      message:
        key in parsed
          ? `malformed \`${key}\` — tolerated at load and dropped, so its effect is silently lost`
          : `unknown widget field "${key}" — dropped at load, so it has no effect`,
    });
  }
  const rawTabs = raw.tabs;
  const parsedTabs = parsed.tabs;
  if (!Array.isArray(rawTabs) || !Array.isArray(parsedTabs)) return;
  rawTabs.forEach((tab, ti) => {
    const pTab = parsedTabs[ti];
    if (!isRecord(tab) || !isRecord(pTab)) return;
    const rawKids = tab.widgets;
    const pKids = pTab.widgets;
    if (!Array.isArray(rawKids) || !Array.isArray(pKids)) return;
    rawKids.forEach((kid, ki) => {
      checkWidgetFidelity(kid, pKids[ki], file, `${path}.tabs.${ti}.widgets.${ki}`, findings);
    });
  });
}

function validateLayer(src: SourceFile, findings: TemplateFinding[]): void {
  const parsed = layerTemplateSchema.safeParse(src.content);
  if (!parsed.success) {
    pushZodIssues(parsed.error, src.label, findings);
    return;
  }
  const tpl = parsed.data;
  const raw = src.content as Record<string, unknown>;

  // The loader keys templates by filename and throws on a mismatch — catch
  // it here, where the message names the file instead of aborting boot.
  if (tpl.key.toLowerCase() !== src.stem.toLowerCase()) {
    findings.push({
      file: src.label,
      path: 'key',
      message: `"${tpl.key}" does not match the filename stem "${src.stem}"`,
    });
  }

  // `layer-header` is the canonical key; `metrics` is the legacy alias the
  // loader still honours. Report against whichever the file actually uses.
  const headerKey = tpl['layer-header'] ? 'layer-header' : 'metrics';
  const header = tpl['layer-header'] ?? tpl.metrics;
  (header?.columns ?? []).forEach((c, i) => {
    // No explicit MQE ⇒ the landing route falls back to the built-in
    // catalog; an unmapped key there yields a permanently empty column.
    // Bundled-only: "Add column" seeds a metric key of its own invention and
    // leaves `mqe` for the operator to fill in, so at the push bar this fires
    // on every freshly added column.
    if (!c.mqe && !expressionForServiceMetric(c.metric, tpl.key)) {
      findings.push({
        file: src.label,
        path: `${headerKey}.columns.${i}`,
        message: `column "${c.metric}" has no \`mqe\` and no metric-catalog mapping for layer ${tpl.key}`,
      });
    }
  });

  const rawDashboards = isRecord(raw.dashboards) ? raw.dashboards : {};
  for (const [scope, rawWidgets] of Object.entries(rawDashboards)) {
    if (!Array.isArray(rawWidgets)) continue;
    rawWidgets.forEach((w, i) => {
      const p = widgetSchema.safeParse(w);
      if (p.success) {
        checkWidgetFidelity(w, p.data, src.label, `dashboards.${scope}.${i}`, findings);
      }
    });
  }

  for (const issue of layerCrossRefIssues(tpl, { complete: true })) {
    findings.push({ file: src.label, path: issue.path, message: issue.message });
  }
}

function validateOverview(
  src: SourceFile,
  layerKeys: ReadonlySet<string>,
  findings: TemplateFinding[],
): void {
  const parsed = overviewTemplateSchema.safeParse(src.content);
  if (!parsed.success) {
    pushZodIssues(parsed.error, src.label, findings);
    return;
  }
  const dash = parsed.data;
  // Overlays are stored under the FILENAME stem but read back by dashboard
  // id, so a mismatch drops every translation for this dashboard.
  if (dash.id !== src.stem) {
    findings.push({
      file: src.label,
      path: 'id',
      message: `"${dash.id}" does not match the filename stem "${src.stem}" — translation overlays would never resolve`,
    });
  }
  (dash.layers ?? []).forEach((l, i) => {
    if (!layerKeys.has(l.toUpperCase())) {
      findings.push({ file: src.label, path: `layers.${i}`, message: `no bundled layer template for "${l}"` });
    }
  });
  const seen = new Set<string>();
  dash.widgets.forEach((w, i) => {
    if (seen.has(w.id)) {
      findings.push({ file: src.label, path: `widgets.${i}.id`, message: `duplicate widget id "${w.id}"` });
    }
    seen.add(w.id);
    if (w.layer && !layerKeys.has(w.layer.toUpperCase())) {
      findings.push({
        file: src.label,
        path: `widgets.${i}.layer`,
        message: `no bundled layer template for "${w.layer}"`,
      });
    }
    if (w.rankBy?.kpi !== undefined && w.rankBy.kpi >= (w.kpis?.length ?? 0)) {
      findings.push({
        file: src.label,
        path: `widgets.${i}.rankBy.kpi`,
        message: `index ${w.rankBy.kpi} is out of range for ${w.kpis?.length ?? 0} kpi(s)`,
      });
    }
  });
}

/** Validate every bundled layer + overview template. Returns one finding
 *  per defect; an empty array means the bundle is clean. */
export function validateBundledTemplates(root: string = BUNDLED_ROOT): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  const layers = readSources(root, 'layers', findings);
  const overviews = readSources(root, 'overviews', findings);
  const layerKeys = new Set(
    layers
      .map((l) => (isRecord(l.content) && typeof l.content.key === 'string' ? l.content.key.toUpperCase() : null))
      .filter((k): k is string => k !== null),
  );
  for (const src of layers) validateLayer(src, findings);
  for (const src of overviews) validateOverview(src, layerKeys, findings);
  return findings;
}
