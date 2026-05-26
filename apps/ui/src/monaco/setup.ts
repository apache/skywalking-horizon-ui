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
import type { Catalog } from '@skywalking-horizon-ui/api-client';
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

  registerCompletions();
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
