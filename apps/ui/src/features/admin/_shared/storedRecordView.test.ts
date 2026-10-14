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

import { describe, expect, it } from 'vitest';
import { locateJsonPath } from '@/utils/jsonLocate';
import { importedFileView, storedRecordView } from './storedRecordView';

const STORED = JSON.stringify({ content: { key: 'GENERAL', alias: 'General' }, kind: 'layer', name: 'horizon.layer.GENERAL', version: 1 });

describe('storedRecordView', () => {
  it('pretty-prints a record that parses, and places content problems under `content`', () => {
    const view = storedRecordView(STORED, [{ path: ['components'], message: 'Required' }]);
    expect(view.text).toBe(JSON.stringify(JSON.parse(STORED), null, 2));
    expect(view.problems).toEqual([{ path: ['content', 'components'], message: 'Required' }]);
    // A missing key lands on the object that lacks it, which is in the text.
    expect(locateJsonPath(view.text, view.problems[0]!.path)).not.toBeNull();
  });

  it('places a record problem at the record itself', () => {
    const view = storedRecordView(STORED, [{ path: ['kind'], record: true, message: 'must be "overview"' }]);
    expect(view.problems).toEqual([{ path: ['kind'], message: 'must be "overview"' }]);
  });

  it('shows a record that does not parse exactly as stored, where its offset points', () => {
    const broken = STORED.slice(0, -4);
    const view = storedRecordView(broken, [{ path: [], record: true, message: 'not valid JSON', offset: broken.length }]);
    expect(view.text).toBe(broken);
    expect(view.problems).toEqual([{ path: [], message: 'not valid JSON', offset: broken.length }]);
  });
});

describe('importedFileView', () => {
  it('keeps the file verbatim and moves content problems under `content` for an export envelope', () => {
    const file = '{\n  "name": "horizon.layer.GENERAL",\n  "kind": "layer",\n  "version": 1,\n  "content": { "key": "GENERAL" }\n}';
    const view = importedFileView(file, [{ path: ['components'], message: 'Required' }], true);
    expect(view.text).toBe(file);
    expect(view.problems[0]!.path).toEqual(['content', 'components']);
  });

  it('leaves the paths of a bare-content file as they are', () => {
    const view = importedFileView('{"key":"GENERAL"}', [{ path: ['components'], message: 'Required' }], false);
    expect(view.problems[0]!.path).toEqual(['components']);
  });
});
