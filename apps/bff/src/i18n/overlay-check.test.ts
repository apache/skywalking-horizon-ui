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
 * `translation:write` means wording. The runtime merger replaces any string
 * leaf the overlay sets at a matching path, so this check is the only thing
 * standing between that permission and a rewritten query.
 */

import { describe, expect, it } from 'vitest';
import { overlayFindings } from './overlay-check.js';

const paths = (source: unknown, overlay: unknown): string[] =>
  overlayFindings(source, overlay).map((f) => f.path);

describe('what an overlay may say about its source', () => {
  it('accepts the allowlisted text fields', () => {
    const src = { alias: 'General', title: 'Overview', slots: { svc: 'Service' } };
    expect(overlayFindings(src, { alias: 'Général', title: 'Aperçu' })).toEqual([]);
    expect(overlayFindings(src, { slots: { svc: 'Service (fr)' } })).toEqual([]);
  });

  it('refuses a non-allowlisted scalar field', () => {
    expect(paths({ key: 'GENERAL', alias: 'General' }, { key: 'EVIL' })).toEqual(['key']);
    expect(paths({ type: 'line' }, { type: 'top' })).toEqual(['type']);
  });

  it('refuses a string ELEMENT of a non-allowlisted array', () => {
    // The array recurses, and its string elements used to fall through the
    // walk with no finding at all — while the merger replaced them.
    const src = { expressions: ['service_sla', 'service_cpm'] };
    expect(paths(src, { expressions: ['evil_mqe'] })).toEqual(['expressions.0']);
  });

  it('refuses a scalar buried under non-allowlisted containers', () => {
    const src = { dashboards: { service: [{ type: 'line', expression: 'service_sla' }] } };
    expect(paths(src, { dashboards: { service: [{ expression: 'evil_mqe' }] } })).toEqual([
      'dashboards.service.0.expression',
    ]);
  });

  it('still allows a translatable field nested under those containers', () => {
    const src = { dashboards: { service: [{ type: 'line', title: 'Latency' }] } };
    expect(overlayFindings(src, { dashboards: { service: [{ title: 'Latencia' }] } })).toEqual([]);
  });

  it('refuses a key the source does not have', () => {
    expect(paths({ alias: 'General' }, { nope: 'x' })).toEqual(['nope']);
  });
});
