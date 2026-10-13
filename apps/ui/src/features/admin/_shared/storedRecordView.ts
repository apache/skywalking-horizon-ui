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
 * The text a problems dialog shows, and the problems placed on it.
 *
 * The BFF reports a problem against a template's `content`, or against the
 * record around it (`record`); the dialog places it on whatever text it shows.
 * These helpers make the two agree for a stored record and for an imported
 * file.
 */

import type { TemplateProblem as WireProblem } from '@/api/scopes/configs';
import type { TemplateProblem } from './templateProblems';

export interface ProblemsView {
  text: string;
  problems: TemplateProblem[];
}

/**
 * A stored record as the dialog shows it. Horizon writes a record on one line,
 * so a record that parses is shown pretty-printed; one that does not is shown
 * exactly as stored, where a syntax error's offset points.
 */
export function storedRecordView(configuration: string, problems: readonly WireProblem[]): ProblemsView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration);
  } catch {
    return { text: configuration, problems: problems.map(({ path, message, offset }) => ({ path, message, offset })) };
  }
  return {
    text: JSON.stringify(parsed, null, 2),
    problems: problems.map(({ path, message, record }) => ({
      path: record ? path : ['content', ...path],
      message,
    })),
  };
}

/**
 * An imported file as the dialog shows it — verbatim, since it is the
 * operator's own file. `envelope` says whether the file wraps the template in
 * an export envelope, which moves content problems under `content`.
 */
export function importedFileView(text: string, problems: readonly WireProblem[], envelope: boolean): ProblemsView {
  return {
    text,
    problems: problems.map(({ path, message, record, offset }) => ({
      path: record || !envelope ? path : ['content', ...path],
      message,
      offset,
    })),
  };
}
