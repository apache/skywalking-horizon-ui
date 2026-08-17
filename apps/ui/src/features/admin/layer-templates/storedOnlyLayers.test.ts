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
 * Which layers the dashboard editor can open.
 *
 * A bundled default is not a precondition for editing. A template
 * published from this page for a layer that never shipped one — or one
 * whose services are not reporting right now — is the operator's own
 * configuration, and it has to be reachable again. When it was not, the
 * picker silently fell back to another layer and an edit meant for the
 * published template landed on that one instead.
 *
 * The composition is exercised directly rather than restated here: a test
 * that reimplemented it would keep passing while the store drifted away
 * from it. What it pins is the ordering of the three sources, that each
 * key appears once, and that a stored-only layer is not counted among the
 * "not configured yet" layers the banner reports.
 */

import { describe, it, expect } from 'vitest';
import type { AdminLayerTemplate } from '@/api/client';
import { layerEditName, layerKeyFromEditName } from '@/controls/localTemplateEdits';
import { composeLayerPickerList } from './layerPickerList';

type Tpl = AdminLayerTemplate;

const blank = (key: string, alias: string): Tpl =>
  ({ key, alias, slots: {}, components: { service: true }, metrics: {}, widgets: [] }) as Tpl;

/** The real composition, with its four sources supplied. */
function compose(
  bundled: Tpl[],
  remoteNames: string[],
  remoteContent: (name: string) => Tpl | null,
  roster: Array<{ key: string; name: string }>,
) {
  return composeLayerPickerList(bundled, remoteNames, remoteContent, roster, blank);
}

const BUNDLED: Tpl[] = [blank('GENERAL', 'General')];
const stored = (key: string): Tpl => blank(key, `${key} stored`);

describe('the editor picker', () => {
  it('offers a layer that exists ONLY as a stored row', () => {
    const r = compose(
      BUNDLED,
      [layerEditName('CUSTOM_MQ')],
      () => stored('CUSTOM_MQ'),
      [],
    );
    expect(r.list.map((t) => t.key)).toEqual(['GENERAL', 'CUSTOM_MQ']);
  });

  it('opens it from its stored content, not from a blank', () => {
    // The bug this replaces did not merely hide the layer — anything that
    // opened it from a blank would silently discard the published widgets
    // on the next save.
    const r = compose(BUNDLED, [layerEditName('CUSTOM_MQ')], () => stored('CUSTOM_MQ'), []);
    expect(r.list[1].alias).toBe('CUSTOM_MQ stored');
  });

  it('does not need the layer to be reporting', () => {
    // No roster entry at all: services may be down, or the layer may not
    // have started reporting yet. The configuration still exists.
    const r = compose(BUNDLED, [layerEditName('CUSTOM_MQ')], () => stored('CUSTOM_MQ'), []);
    expect(r.list.some((t) => t.key === 'CUSTOM_MQ')).toBe(true);
  });

  it('keeps one entry per layer when a stored row also ships a bundle', () => {
    const r = compose(BUNDLED, [layerEditName('GENERAL')], () => stored('GENERAL'), []);
    expect(r.list.map((t) => t.key)).toEqual(['GENERAL']);
    // The bundled entry wins its slot — the store's own remote/local
    // resolution decides what the editor then loads into it.
    expect(r.list[0].alias).toBe('General');
  });

  it('still synthesizes a blank for a reporting layer with no template', () => {
    const r = compose(BUNDLED, [], () => null, [{ key: 'mesh', name: 'Mesh' }]);
    expect(r.list.map((t) => t.key)).toEqual(['GENERAL', 'MESH']);
    expect(r.unconfigured).toBe(1);
  });

  it('does not count a stored-only layer as "not configured yet"', () => {
    // It IS configured — by the operator, on this page. Counting it would
    // report their own published template back to them as missing.
    const r = compose(
      BUNDLED,
      [layerEditName('CUSTOM_MQ')],
      () => stored('CUSTOM_MQ'),
      [{ key: 'mesh', name: 'Mesh' }],
    );
    expect(r.unconfigured).toBe(1);
    expect(r.list.map((t) => t.key)).toEqual(['GENERAL', 'CUSTOM_MQ', 'MESH']);
  });

  it('marks only the blanks as "not configured"', () => {
    // The picker's filter reads this set. Deriving it as "missing from the
    // bundled list" instead answers a different question and swept in
    // every stored-only layer — a template the operator had published.
    const r = compose(
      BUNDLED,
      [layerEditName('CUSTOM_MQ')],
      () => stored('CUSTOM_MQ'),
      [{ key: 'mesh', name: 'Mesh' }],
    );
    expect([...r.unconfiguredKeys]).toEqual(['MESH']);
    expect(r.unconfiguredKeys.has('CUSTOM_MQ')).toBe(false);
    expect(r.unconfiguredKeys.has('GENERAL')).toBe(false);
  });

  it('ignores stored rows of another kind', () => {
    const r = compose(BUNDLED, ['horizon.overview.services', 'horizon.alert.page-setup'], () => stored('X'), []);
    expect(r.list.map((t) => t.key)).toEqual(['GENERAL']);
  });

  it('matches the roster case-insensitively, so a layer is never listed twice', () => {
    const r = compose(BUNDLED, [layerEditName('CUSTOM_MQ')], () => stored('CUSTOM_MQ'), [
      { key: 'custom_mq', name: 'Custom MQ' },
    ]);
    expect(r.list.map((t) => t.key)).toEqual(['GENERAL', 'CUSTOM_MQ']);
    expect(r.unconfigured).toBe(0);
  });
});

describe('layerKeyFromEditName', () => {
  it('round-trips a layer name', () => {
    expect(layerKeyFromEditName(layerEditName('custom_mq'))).toBe('CUSTOM_MQ');
  });

  it('refuses another kind, and the bare prefix', () => {
    expect(layerKeyFromEditName('horizon.overview.services')).toBeNull();
    expect(layerKeyFromEditName('horizon.layer.')).toBeNull();
  });
});
