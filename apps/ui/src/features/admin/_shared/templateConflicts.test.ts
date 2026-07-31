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
 * Duplicate-template surfacing in the admin pages: the per-row DUPLICATE
 * marker and the selection-scoped conflict banner. Horizon only reports
 * duplicates — nothing here resolves one, so every assertion is about
 * what the operator is told.
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { TemplateConflict } from '@/api/scopes/configs';
import { i18n } from '@/i18n';
import { buildConflictBanner, conflictOf, type BannerTranslate } from './useTemplateSync';
import TemplateStatusBadge from './TemplateStatusBadge.vue';
import TemplatePicker, { type TemplatePickerEntry } from './TemplatePicker.vue';

const overviewConflict: TemplateConflict = {
  name: 'horizon.overview.services',
  kind: 'overview',
  key: 'services',
  enabledIds: ['row-a', 'row-b'],
};

/** Interpolating stand-in for vue-i18n's `t` so the builder's output can
 *  be asserted on without an app instance. */
const echo: BannerTranslate = (key, named) =>
  key.replace(/\{(\w+)\}/g, (_m, k: string) => String(named?.[k] ?? `{${k}}`));

const withI18n = { global: { plugins: [i18n] } };

describe('conflictOf', () => {
  it('finds the duplicate row for a name in its own kind', () => {
    expect(conflictOf([overviewConflict], 'overview', 'horizon.overview.services')).toBe(
      overviewConflict,
    );
  });

  it('returns null for a name OAP stores exactly once', () => {
    expect(conflictOf([overviewConflict], 'overview', 'horizon.overview.database')).toBeNull();
  });

  it('ignores a conflict of another kind — an admin page marks only its own family', () => {
    const layerConflict: TemplateConflict = {
      name: 'horizon.layer.MESH',
      kind: 'layer',
      key: 'MESH',
      enabledIds: ['row-a', 'row-b'],
    };
    expect(conflictOf([layerConflict], 'overview', 'horizon.layer.MESH')).toBeNull();
    expect(conflictOf([layerConflict], 'layer', 'horizon.layer.MESH')).toBe(layerConflict);
  });

  it('reports nothing when the bundle carries no conflicts field', () => {
    expect(conflictOf(undefined, 'layer', 'horizon.layer.MESH')).toBeNull();
    expect(conflictOf(null, 'layer', 'horizon.layer.MESH')).toBeNull();
  });
});

describe('buildConflictBanner', () => {
  it('names the one template it was built for and lists every enabled record id', () => {
    const banner = buildConflictBanner(overviewConflict, echo);
    expect(banner.message).toContain('horizon.overview.services');
    expect(banner.message).toContain('2');
    expect(banner.detail).toContain('row-a, row-b');
  });

  it('is conflict-severity and scoped to that single template', () => {
    const banner = buildConflictBanner(overviewConflict, echo);
    expect(banner.severity).toBe('conflict');
    expect(banner.conflicts).toEqual([overviewConflict]);
    expect(banner.counts).toEqual({});
    expect(banner.localCount).toBe(0);
  });

  it('offers no resolve action — the banner is text only', () => {
    expect(Object.keys(buildConflictBanner(overviewConflict, echo)).sort()).toEqual([
      'conflicts',
      'counts',
      'detail',
      'localCount',
      'message',
      'severity',
    ]);
  });
});

describe('TemplateStatusBadge — duplicate marker', () => {
  it('renders the sync chip alone when the name is not duplicated', () => {
    const w = mount(TemplateStatusBadge, { props: { status: 'synced' }, ...withI18n });
    expect(w.text()).toContain('synced');
    expect(w.find('.tsb--conflict').exists()).toBe(false);
  });

  it('adds a DUPLICATE chip beside the sync chip, naming the OAP records', () => {
    const w = mount(TemplateStatusBadge, {
      props: { status: 'diverged', conflictIds: ['row-a', 'row-b'] },
      ...withI18n,
    });
    const dup = w.find('.tsb--conflict');
    expect(dup.exists()).toBe(true);
    expect(dup.text()).toBe('duplicate');
    expect(dup.attributes('title')).toContain('row-a, row-b');
    // The sync chip stays: it describes the copy Horizon renders.
    expect(w.find('.tsb--diverged').exists()).toBe(true);
  });

  it('still marks the row when there is no sync status to show', () => {
    const w = mount(TemplateStatusBadge, {
      props: { status: null, conflictIds: ['row-a', 'row-b'] },
      ...withI18n,
    });
    expect(w.find('.tsb--conflict').exists()).toBe(true);
  });

  it('renders nothing for an empty conflict list', () => {
    const w = mount(TemplateStatusBadge, { props: { status: null, conflictIds: [] }, ...withI18n });
    expect(w.find('.tsb').exists()).toBe(false);
  });
});

describe('TemplatePicker — duplicate marker in the drop-down', () => {
  const entries: TemplatePickerEntry[] = [
    {
      value: 'services',
      label: 'Services',
      key: 'services',
      syncBadge: 'diverged',
      conflictIds: ['row-a', 'row-b'],
    },
    { value: 'database', label: 'Database', key: 'database', syncBadge: 'synced' },
  ];

  it('marks only the duplicated row in the browse list', async () => {
    const w = mount(TemplatePicker, {
      props: { modelValue: 'database', entries, kindLabel: 'dashboards' },
      ...withI18n,
    });
    await w.find('.tp-btn').trigger('click');
    const rows = w.findAll('.tp-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].find('.tsb--conflict').exists()).toBe(true);
    expect(rows[0].find('.tsb--conflict').attributes('title')).toContain('row-a, row-b');
    expect(rows[1].find('.tsb--conflict').exists()).toBe(false);
  });

  it('marks the closed picker chip when the duplicated entry is the selected one', () => {
    const w = mount(TemplatePicker, {
      props: { modelValue: 'services', entries, kindLabel: 'dashboards' },
      ...withI18n,
    });
    expect(w.find('.tp-btn .tsb--conflict').exists()).toBe(true);
  });

  it('leaves the closed picker chip unmarked for a clean selection', () => {
    const w = mount(TemplatePicker, {
      props: { modelValue: 'database', entries, kindLabel: 'dashboards' },
      ...withI18n,
    });
    expect(w.find('.tp-btn .tsb--conflict').exists()).toBe(false);
  });
});
