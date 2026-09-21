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
 * One-time Monaco wiring: register the warm-charcoal "rr-dark" theme,
 * a worker factory, and DSL completion providers for MAL + LAL keyed
 * on the editor's catalog.
 *
 * Idempotent — `setupMonaco()` is safe to call from every editor
 * mount; the actual registration runs only once per process.
 */

import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import type { Catalog, TraceQLDatasource } from '@skywalking-horizon-ui/api-client';
import { tokens } from '@skywalking-horizon-ui/design-tokens';
// Local shim mapping the vantage rrDark slot names to horizon's nested
// token tree so the Monaco theme below stays readable. The slot semantics
// (ink2 = secondary fg, dim = tertiary fg, active = primary accent, …)
// are 1:1 with horizon's tree; only the field path changes.
const rrDark = {
  bg2: tokens.bg[2],
  bg3: tokens.bg[3],
  ink: tokens.fg[0],
  ink2: tokens.fg[2],
  dim: tokens.fg[3],
  active: tokens.accent.base,
  info: tokens.semantic.info,
  violet: tokens.semantic.purple,
  border: tokens.line[1],
  border2: tokens.line[2],
};
import {
  MAL_DOWNSAMPLINGS,
  MAL_FUNCTIONS,
  MAL_SCOPES,
  MAL_TOP_KEYS,
  type DslEntry,
} from './mal-grammar.js';
import {
  TRACEQL_LANGUAGE_ID,
  TRACEQL_MONARCH,
  TRACEQL_INTRINSICS,
  TRACEQL_SCOPES,
  TRACEQL_RESOURCE_ATTRS,
  TRACEQL_DURATION_UNITS,
  TRACEQL_STATUS_VALUES,
} from './traceql-grammar.js';
import {
  LAL_BLOCK_KEYWORDS,
  LAL_EXTRACTOR_FUNCS,
  LAL_RULE_KEYS,
  LAL_TOP_KEYS,
} from './lal-grammar.js';

let initialised = false;

export const RR_THEME_NAME = 'rr-dark';

interface MonacoGlobal {
  MonacoEnvironment?: monaco.Environment;
}

export function setupMonaco(): void {
  if (initialised) return;
  initialised = true;

  (globalThis as MonacoGlobal).MonacoEnvironment = {
    // Monaco hands every worker request a `label` matching the model's
    // language. The generic EditorWorker only knows tokenization +
    // diffs — the JSON / TS / CSS / HTML language services each ship
    // their OWN worker that handles language-specific messages like
    // `resetSchema`. Returning EditorWorker for every label was the
    // cause of "Uncaught (in promise) Error: Missing requestHandler
    // or method: resetSchema" surfacing in deployment whenever an
    // operator opened the JSON diff modal (Check diff & push) — the
    // diff still rendered, but Monaco's JSON service kept logging the
    // unanswered message. Dev never hit it because nobody opened that
    // modal in dev mode.
    getWorker(_workerId: string, label: string): Worker {
      if (label === 'json') return new JsonWorker();
      return new EditorWorker();
    },
  };

  monaco.editor.defineTheme(RR_THEME_NAME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string', foreground: rrDark.ink2.replace('#', '') },
      { token: 'number', foreground: rrDark.info.replace('#', '') },
      { token: 'comment', foreground: rrDark.dim.replace('#', ''), fontStyle: 'italic' },
      { token: 'keyword', foreground: rrDark.active.replace('#', '') },
      { token: 'type', foreground: rrDark.violet.replace('#', '') },
    ],
    colors: {
      'editor.background': rrDark.bg2,
      'editor.foreground': rrDark.ink,
      'editorLineNumber.foreground': rrDark.dim,
      'editorLineNumber.activeForeground': rrDark.ink2,
      'editor.lineHighlightBackground': rrDark.bg3,
      'editorCursor.foreground': rrDark.active,
      'editor.selectionBackground': '#3a3329',
      'editorIndentGuide.background': rrDark.border,
      'editorIndentGuide.activeBackground': rrDark.border2,
      'editor.findMatchBackground': '#5a4019',
    },
  });

  registerTraceQL();
  registerCompletions();
}

/** What the TraceQL editor knows about the store it is querying: the tag keys
 *  the backend reported, and a way to ask for one tag's values. Attached to the
 *  MODEL so one registration serves every editor instance and every datasource. */
export interface TraceQLSchema {
  ds: TraceQLDatasource;
  tagKeys: string[];
  services: string[];
  spanNames: string[];
  valuesFor: (tag: string) => string[];
  requestValues: (tag: string) => void;
}

type TraceQLModel = monaco.editor.ITextModel & { __tqlSchema?: TraceQLSchema };

/** Register the language, its highlighting and its schema-driven completion. */
function registerTraceQL(): void {
  monaco.languages.register({ id: TRACEQL_LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(
    TRACEQL_LANGUAGE_ID,
    TRACEQL_MONARCH as unknown as monaco.languages.IMonarchLanguage,
  );
  monaco.languages.setLanguageConfiguration(TRACEQL_LANGUAGE_ID, {
    brackets: [['{', '}']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.registerCompletionItemProvider(TRACEQL_LANGUAGE_ID, {
    triggerCharacters: ['{', '.', '=', '"', ' ', '>', '<'],
    provideCompletionItems(model, position) {
      const schema = (model as TraceQLModel).__tqlSchema;
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      /**
       * The range a suggestion REPLACES.
       *
       * Monaco's word range stops at a dot and at a quote, so using it for a
       * dotted field turns `resource.ser` into `resource.resource.service.name`,
       * and using it inside a literal leaves the opening quote behind. Each
       * kind of suggestion therefore says how far back it reaches.
       */
      const rangeBack = (chars: number): monaco.IRange => ({
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: Math.max(1, position.column - chars),
        endColumn: position.column,
      });
      /** A VALUE's range, which also takes in the closing quote the editor
       *  auto-inserted when the operator typed the opening one — the suggestion
       *  carries its own quotes, and replacing only the opening one left
       *  `service.name="svc""`. */
      const valueRangeBack = (chars: number): monaco.IRange => {
        const rest = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: model.getLineMaxColumn(position.lineNumber),
        });
        const r = rangeBack(chars);
        return rest.startsWith('"') ? { ...r, endColumn: r.endColumn + 1 } : r;
      };
      // `filterText` is the inserted text, not the label, because Monaco filters
      // a suggestion against whatever the RANGE covers. A value's range takes in
      // the opening quote, so filtering `GET:/rating` against `\"` matched
      // nothing and every value list came up empty.
      const item = (
        label: string,
        insert: string,
        detail: string,
        kind: monaco.languages.CompletionItemKind,
        range: monaco.IRange,
      ): monaco.languages.CompletionItem => ({
        label,
        insertText: insert,
        filterText: insert,
        detail,
        kind,
        range,
      });

      // After `=` — offer the VALUES the backend reported for this key, which
      // is the part an operator cannot guess.
      const afterEquals = /([\w.]+)\s*=\s*("?)([^"]*)$/.exec(line);
      if (afterEquals && schema) {
        const key = afterEquals[1]!;
        // Replace the partial VALUE and its opening quote, so the inserted
        // literal does not end up quoted twice.
        const typed = afterEquals[3]!.length + afterEquals[2]!.length;
        const valueRange = valueRangeBack(typed);
        // A value the backend reported can contain a quote or a backslash;
        // it goes in as a literal, so it is escaped like any other.
        const lit = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        if (key === 'status') {
          // The values the LANGUAGE defines, both stores alike. Which of them a
          // given backend applies is its own business, and a completion list
          // narrowed by a measurement of one build goes stale on the next.
          return {
            suggestions: TRACEQL_STATUS_VALUES.map((v) =>
              item(v, lit(v), 'status', monaco.languages.CompletionItemKind.Value, valueRange),
            ),
          };
        }
        if (key.endsWith('service.name') || key === 'resource.service') {
          return { suggestions: schema.services.map((v) => item(v, lit(v), 'service', monaco.languages.CompletionItemKind.Value, valueRange)) };
        }
        if (key === 'name' || key === 'span.name') {
          return { suggestions: schema.spanNames.map((v) => item(v, lit(v), 'span name', monaco.languages.CompletionItemKind.Value, valueRange)) };
        }
        // The reserved resource attributes are not tags and have no value
        // endpoint of their own beyond the two handled above, so nothing is
        // offered rather than asking the wrong endpoint.
        if (key.startsWith('resource.')) return { suggestions: [] };
        const tag = key.replace(/^span\.|^\./, '');
        schema.requestValues(tag);
        return {
          suggestions: schema.valuesFor(tag).map((v) => item(v, lit(v), tag, monaco.languages.CompletionItemKind.Value, valueRange)),
        };
      }

      // After a duration comparison — the units this backend parses. With no
      // number yet there is nothing to qualify, and the empty list is the
      // point: it DISMISSES a list still offering fields, which Enter would
      // otherwise paste over the number being typed.
      const afterDuration = /duration\s*(?:>=|<=|[<>])\s*(\d+(?:\.\d+)?)?([a-z]*)$/.exec(line);
      if (afterDuration) {
        if (!afterDuration[1]) return { suggestions: [] };
        // Append the unit to the number rather than replacing it: the word
        // range here covers the digits.
        const unitRange = rangeBack(afterDuration[2]!.length);
        return {
          suggestions: TRACEQL_DURATION_UNITS.map((u) =>
            item(u, u, 'duration unit', monaco.languages.CompletionItemKind.Unit, unitRange),
          ),
        };
      }

      // Otherwise: the fields. Intrinsics, the reserved resource attributes,
      // and every span tag the store reported — the schema, in other words.
      // A field replaces the whole dotted identifier under the cursor, not the
      // fragment after the last dot.
      const partial = /[A-Za-z_][\w.]*$/.exec(line)?.[0] ?? '';
      const fieldRange = rangeBack(partial.length);
      const suggestions: monaco.languages.CompletionItem[] = [
        // Only the intrinsics THIS store can filter — `kind` is a column
        // where the spans were stored as OTLP and nowhere else, and OAP
        // refuses it outright on the others. The schema panel already hides
        // it; offering it here contradicted that.
        ...TRACEQL_INTRINSICS.filter((i) => !i.ds || !schema || i.ds.includes(schema.ds)).map((i) =>
          item(i.name, i.name === 'duration' ? 'duration>' : `${i.name}="`, i.detail, monaco.languages.CompletionItemKind.Keyword, fieldRange),
        ),
        ...TRACEQL_RESOURCE_ATTRS.filter((a) => !a.ds || !schema || a.ds.includes(schema.ds)).map((a) =>
          item(a.name, `${a.name}="`, a.detail, monaco.languages.CompletionItemKind.Property, fieldRange),
        ),
        ...TRACEQL_SCOPES.map((sc) => item(`${sc.name}.`, `${sc.name}.`, sc.detail, monaco.languages.CompletionItemKind.Module, fieldRange)),
        ...(schema?.tagKeys ?? []).map((k) =>
          item(`span.${k}`, `span.${k}="`, 'span tag', monaco.languages.CompletionItemKind.Field, fieldRange),
        ),
      ];
      return { suggestions };
    },
  });
}

function registerCompletions(): void {
  monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: ['.', ':', '\n', ' '],
    provideCompletionItems(model, position) {
      const catalog = (model as monaco.editor.ITextModel & { __vsCatalog?: Catalog }).__vsCatalog;
      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const entries = entriesForCatalog(catalog);
      return {
        suggestions: entries.map((e) => toSuggestion(e, range)),
      };
    },
  });
}

function entriesForCatalog(catalog: Catalog | undefined): DslEntry[] {
  if (catalog === 'lal') {
    return [...LAL_TOP_KEYS, ...LAL_RULE_KEYS, ...LAL_BLOCK_KEYWORDS, ...LAL_EXTRACTOR_FUNCS];
  }
  // MAL — both otel-rules and log-mal-rules use the same DSL.
  return [...MAL_TOP_KEYS, ...MAL_SCOPES, ...MAL_DOWNSAMPLINGS, ...MAL_FUNCTIONS];
}

function toSuggestion(entry: DslEntry, range: monaco.IRange): monaco.languages.CompletionItem {
  return {
    label: entry.label,
    kind: monaco.languages.CompletionItemKind.Snippet,
    detail: entry.detail,
    insertText: entry.insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range,
  };
}

/** Tag a model with its catalog so the global completion provider can
 *  filter MAL vs. LAL suggestions. Set this once after `monaco.editor.create`. */
export function setModelCatalog(model: monaco.editor.ITextModel, catalog: Catalog): void {
  (model as monaco.editor.ITextModel & { __vsCatalog?: Catalog }).__vsCatalog = catalog;
}
