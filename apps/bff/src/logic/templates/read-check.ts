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
 * Whether a STORED template can be served, decided when it is read.
 *
 * The publish boundary refuses malformed content, but the store can be written
 * without passing through it, so every read is checked again — against a
 * narrower bar than publishing. A template is refused only for what would
 * break rendering:
 *   - a wrong type or a missing required field, anywhere;
 *   - any defect in a layer's widgets or header columns, the two parts the SPA
 *     forwards verbatim to a strict request body (one bad widget fails the
 *     dashboard batch, one bad column fails the service list).
 * Unknown keys, bounds the renderer clamps and references between two parts of
 * a template are NOT refused here. A newer Horizon writes keys an older one
 * does not know, and refusing them would hide that template from every reader
 * still on the older version.
 *
 * Alarm pages and the 3D map keep the full schema their readers already held
 * them to, so what is reported here is exactly what those readers refuse.
 *
 * A refused row stays exactly as stored: it is served to nobody, reported on
 * its Dashboard setup page, and never repaired or replaced by Horizon.
 */

import type { ZodIssue, ZodType } from 'zod';
import {
  alertTemplateSchemaFor,
  layerTemplatePushSchema,
  overviewTemplatePushSchema,
  themeTemplateSchema,
  timeDefaultsTemplateSchema,
} from './bundled-schema.js';
import { infra3dConfigIssues } from '../infra-3d/validate.js';
import { overlayFindings } from '../../i18n/overlay-check.js';
import { parseName, type TemplateKind } from './names.js';

/** One reason a stored template cannot be served. */
export interface TemplateProblem {
  /** From the root of the template's `content`, or of the whole stored record
   *  when {@link record} is set. */
  path: Array<string | number>;
  message: string;
  /** The problem is with the record around the content — it is not a
   *  template envelope at all — so {@link path} starts at the record. */
  record?: true;
  /** For a record that is not valid JSON: where in the stored text it fails. */
  offset?: number;
}

const STRUCTURAL_CODES: ReadonlySet<string> = new Set([
  'invalid_type',
  'invalid_union',
  'invalid_union_discriminator',
  'invalid_literal',
]);

/** Paths the SPA forwards verbatim to a strict request body. */
function forwardedVerbatim(path: ReadonlyArray<string | number>): boolean {
  const [head, second, , fourth] = path;
  if (head === 'widgets') return true;
  if (head === 'dashboards') return path.length >= 3;
  if (head === 'dashboardExtPages') return fourth === 'widgets';
  return (head === 'layer-header' || head === 'metrics' || head === 'header') && second === 'columns';
}

function issueMessage(issue: ZodIssue): string {
  if (issue.code !== 'invalid_union') return issue.message;
  // "Invalid input" names nothing; say what each accepted form wanted instead.
  const wanted = new Set(
    issue.unionErrors.map((e) => e.issues[0]?.message).filter((m): m is string => !!m),
  );
  return wanted.size > 0 ? `matches none of the accepted forms: ${[...wanted].join('; ')}` : issue.message;
}

function toProblems(issues: readonly ZodIssue[]): TemplateProblem[] {
  return issues.map((i) => ({ path: [...i.path], message: issueMessage(i) }));
}

function parsedIssues(schema: ZodType, content: unknown): ZodIssue[] {
  const v = schema.safeParse(content);
  return v.success ? [] : v.error.issues;
}

/** The read check for a SOURCE template. Identity (name vs content) is the
 *  identity rule's job and is checked before this. */
export function templateReadProblems(kind: TemplateKind, key: string, content: unknown): TemplateProblem[] {
  switch (kind) {
    case 'layer':
      return toProblems(
        parsedIssues(layerTemplatePushSchema, content).filter(
          (i) => STRUCTURAL_CODES.has(i.code) || (i.code !== 'unrecognized_keys' && forwardedVerbatim(i.path)),
        ),
      );
    case 'overview':
      return toProblems(parsedIssues(overviewTemplatePushSchema, content).filter((i) => STRUCTURAL_CODES.has(i.code)));
    case 'alert':
      return toProblems(parsedIssues(alertTemplateSchemaFor(key), content));
    case 'infra-3d':
      return toProblems(infra3dConfigIssues(content));
    case 'theme':
      return toProblems(parsedIssues(themeTemplateSchema, content).filter((i) => i.code !== 'unrecognized_keys'));
    case 'time-defaults':
      return toProblems(
        parsedIssues(timeDefaultsTemplateSchema, content).filter((i) => i.code !== 'unrecognized_keys'),
      );
  }
}

/**
 * The read check for a translation overlay, against the source it merges into.
 * Refused only when it would rewrite a value outside the translatable allowlist
 * — a key, a widget type, a query — which the runtime merger would otherwise
 * apply. Drift (an entry whose source widget was since removed) is not refused:
 * the merger skips it.
 */
export function overlayReadProblems(sourceContent: unknown, overlay: unknown): TemplateProblem[] {
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) {
    return [{ path: [], message: 'a translation overlay must be a JSON object' }];
  }
  return overlayFindings(sourceContent, overlay)
    .filter((f) => f.rewrites)
    .map((f) => ({ path: dottedToPath(f.path), message: f.message }));
}

function dottedToPath(dotted: string): Array<string | number> {
  if (!dotted) return [];
  return dotted.split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

/**
 * Why a record's stored text is not a template envelope Horizon can read. Call
 * it only for a record `parseEnvelope` refused and whose OAP id is a Horizon
 * template name — anything else in the store belongs to some other tool.
 */
export function envelopeProblem(configuration: string): TemplateProblem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const at = /position (\d+)/.exec(message);
    return {
      path: [],
      record: true,
      message: `not valid JSON: ${message}`,
      // Text that simply ends early fails past its last character.
      offset: at ? Number(at[1]) : configuration.length,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path: [], record: true, message: 'the record is not a JSON object' };
  }
  const e = parsed as Record<string, unknown>;
  const name = typeof e.name === 'string' ? parseName(e.name) : null;
  if (!name) return { path: ['name'], record: true, message: 'the record has no Horizon template `name`' };
  if (e.kind !== name.kind) return { path: ['kind'], record: true, message: `must be "${name.kind}", as the record's name says` };
  if (typeof e.version !== 'number') return { path: ['version'], record: true, message: 'must be a number' };
  if (e.content === undefined) return { path: [], record: true, message: 'the record has no `content`' };
  if (name.locale !== undefined && e.locale !== name.locale) {
    return { path: ['locale'], record: true, message: `must be "${name.locale}", as the record's name says` };
  }
  return { path: [], record: true, message: 'the record is not a Horizon template envelope' };
}
