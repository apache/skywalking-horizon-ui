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
 * An imported file is checked before anything is staged: it must be JSON, a
 * template of the page's kind, and pass the checks a save runs on the server.
 * A refused file comes back as itself with its problems, for the problems
 * dialog — the import stops there, so a file that could never be published is
 * not discovered at the end of an editing session.
 */

import { ref } from 'vue';
import { bff } from '@/api/client';
import type { TemplateKind } from '@/api/scopes/configs';
import { jsonSyntaxError } from '@/utils/jsonLocate';
import { validateImport } from './templatePortability';
import { importedFileView, type ProblemsView } from './storedRecordView';

export type CheckedImport =
  | { ok: true; key: string; content: unknown }
  | { ok: false; view: ProblemsView };

function isEnvelope(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { kind?: unknown }).kind === 'string' &&
      'content' in parsed
    );
  } catch {
    return false;
  }
}

/** Why `text` is not JSON at all, as the problems dialog shows it — or null. */
export function syntaxRefusal(text: string): ProblemsView | null {
  const syntax = jsonSyntaxError(text);
  return syntax ? { text, problems: [{ path: [], message: syntax.message, offset: syntax.offset }] } : null;
}

/** Ask the server whether `content`, stored as `name`, would publish. */
export async function serverRefusal(name: string, text: string, content: unknown): Promise<ProblemsView | null> {
  const { problems } = await bff.templateSync.validate(name, content);
  return problems.length > 0 ? importedFileView(text, problems, isEnvelope(text)) : null;
}

/** The full check for a source template of `kind`. */
export async function checkImportedFile(kind: TemplateKind, text: string): Promise<CheckedImport> {
  const syntax = syntaxRefusal(text);
  if (syntax) return { ok: false, view: syntax };
  const res = validateImport(kind, text);
  if (!res.ok) return { ok: false, view: { text, problems: [{ path: [], message: res.error }] } };
  const refused = await serverRefusal(`horizon.${kind}.${res.key}`, text, res.content);
  return refused ? { ok: false, view: refused } : res;
}

/** The refused file a page shows, until the dialog is closed. */
export function useRefusedImport() {
  const refused = ref<ProblemsView | null>(null);
  return {
    refused,
    close: (): void => {
      refused.value = null;
    },
  };
}
