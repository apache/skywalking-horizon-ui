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
 * The draft `traces` block the admin editor previews with.
 *
 * Preview must answer what PUBLISHING the draft would answer, so the two
 * compatibility fallbacks apply here exactly as they do to a stored template —
 * otherwise a block reads one way on the preview page and another once saved.
 */

import { describe, it, expect } from 'vitest';
import { resolveTraceStores } from '@skywalking-horizon-ui/api-client';
import { parsePreviewTraces } from './preview.js';

const stores = (raw: string | undefined) => {
  const cfg = parsePreviewTraces(raw);
  return cfg === null ? null : resolveTraceStores(cfg);
};

describe('preview traces block', () => {
  it('previews a block that names nothing as the native store', () => {
    expect(stores('{}')).toEqual(['native']);
    expect(stores('{"stores":{"native":{"name":"Spans"}}}')).toEqual(['native']);
  });

  it('previews the legacy enum as the store it named', () => {
    expect(stores('{"source":"zipkin"}')).toEqual(['zipkin']);
    expect(stores('{"source":"both"}')).toEqual(['native', 'zipkin']);
  });

  it('previews an explicit empty list as no stores', () => {
    expect(stores('{"sources":[]}')).toEqual([]);
  });

  it('previews the checklist, dropping names it does not know', () => {
    expect(stores('{"sources":["traceql-native","nonsense","native"]}')).toEqual(['native', 'traceql-native']);
  });

  it('reads no block at all as nothing to preview', () => {
    // null means "fall through to the saved configuration", which is a
    // different answer from "the draft says no stores".
    expect(parsePreviewTraces(undefined)).toBeNull();
    expect(parsePreviewTraces('not json')).toBeNull();
  });
});
