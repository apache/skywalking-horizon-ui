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
 * The editor must not mint a draft its own push route refuses. The BFF's
 * header check (bundled-schema `checkHeader`) rejects two shapes this editor
 * can otherwise reach by ordinary clicking: a duplicate column metric, and an
 * orderBy naming no column. Both are asserted here at the draft level — the
 * operator finds out at "Check diff & push", long after the click that caused
 * it, so the guard belongs in the editor.
 */

import { describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { i18n } from '@/i18n';
import type { AdminLayerTemplate } from '@/api/client';
import ServiceListMetricsEditor from './ServiceListMetricsEditor.vue';

type Metrics = AdminLayerTemplate['metrics'];

/** The editor mutates the block IN PLACE (it is part of the parent's live
 *  draft), so `draft` stays the object the assertions read. */
function mountEditor(draft: Metrics): VueWrapper {
  return mount(ServiceListMetricsEditor, {
    props: { config: draft, serviceLabel: 'Service' },
    global: { plugins: [i18n] },
  });
}

const addColumn = (w: VueWrapper) => w.get('.card-head .add').trigger('click');
const removeColumn = (w: VueWrapper, i: number) =>
  w.findAll('.metrics-table tbody tr')[i]!.get('.sw-btn.danger').trigger('click');
/** Retype a row's metric id, the way the operator does. */
async function renameColumn(w: VueWrapper, i: number, to: string): Promise<void> {
  const input = w.findAll('.metrics-table tbody tr')[i]!.get('td:first-child input');
  await input.setValue(to);
}

describe('service-list metrics editor — drafts the push route accepts', () => {
  it('never re-mints a metric id a surviving column still holds', async () => {
    const draft: Metrics = { columns: [] };
    const w = mountEditor(draft);

    await addColumn(w);
    await addColumn(w);
    await addColumn(w);
    await removeColumn(w, 1); // drop metric_2 — length is 2 again
    await addColumn(w);

    const ids = draft.columns!.map((c) => c.metric);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['metric_1', 'metric_3', 'metric_2']);
  });

  it('labels the new column with the id it actually got', async () => {
    const draft: Metrics = { columns: [] };
    const w = mountEditor(draft);

    await addColumn(w);
    await addColumn(w);
    await removeColumn(w, 0);
    await addColumn(w);

    expect(draft.columns!.at(-1)).toMatchObject({ metric: 'metric_1', label: 'Metric 1' });
  });

  it('clears an orderBy whose column is deleted', async () => {
    const draft: Metrics = {
      orderBy: 'cpm',
      columns: [
        { metric: 'cpm', label: 'Load' },
        { metric: 'sla', label: 'Success rate' },
      ],
    };

    await removeColumn(mountEditor(draft), 0);

    expect(draft.orderBy).toBeUndefined();
    expect(draft.columns!.map((c) => c.metric)).toEqual(['sla']);
  });

  it('keeps an orderBy that another surviving column still carries', async () => {
    // Two columns can share a metric mid-edit (the id field is operator-typed);
    // deleting one of them leaves the sort key resolvable.
    const draft: Metrics = {
      orderBy: 'cpm',
      columns: [
        { metric: 'cpm', label: 'Load' },
        { metric: 'cpm', label: 'Load (copy)' },
      ],
    };

    await removeColumn(mountEditor(draft), 1);

    expect(draft.orderBy).toBe('cpm');
  });

  it('leaves an unrelated orderBy alone', async () => {
    const draft: Metrics = {
      orderBy: 'sla',
      columns: [
        { metric: 'cpm', label: 'Load' },
        { metric: 'sla', label: 'Success rate' },
      ],
    };

    await removeColumn(mountEditor(draft), 0);

    expect(draft.orderBy).toBe('sla');
  });

  it('follows a rename of the sorted-on column instead of stranding orderBy', async () => {
    const draft: Metrics = {
      orderBy: 'sla',
      columns: [
        { metric: 'cpm', label: 'Load' },
        { metric: 'sla', label: 'Success rate' },
      ],
    };

    await renameColumn(mountEditor(draft), 1, 'sla_1');

    expect(draft.columns![1]!.metric).toBe('sla_1');
    expect(draft.orderBy).toBe('sla_1');
  });

  it('leaves orderBy alone when a column it does not name is renamed', async () => {
    const draft: Metrics = {
      orderBy: 'sla',
      columns: [
        { metric: 'cpm', label: 'Load' },
        { metric: 'sla', label: 'Success rate' },
      ],
    };

    await renameColumn(mountEditor(draft), 0, 'rpm');

    expect(draft.orderBy).toBe('sla');
  });

  it('clears orderBy rather than stranding it when the sort column is emptied', async () => {
    const draft: Metrics = { orderBy: 'cpm', columns: [{ metric: 'cpm', label: 'Load' }] };

    await renameColumn(mountEditor(draft), 0, '');

    expect(draft.orderBy).toBeUndefined();
  });

  it('stops adding columns at the cap the service list query accepts', async () => {
    const draft: Metrics = { columns: [] };
    const w = mountEditor(draft);

    for (let i = 0; i < 12; i += 1) await addColumn(w);

    expect(draft.columns).toHaveLength(10);
    expect(w.get('.card-head .add').attributes('disabled')).toBeDefined();
  });

  it('marks an emptied metric or label invalid, since the push bar refuses both', async () => {
    const draft: Metrics = { columns: [{ metric: 'cpm', label: 'Load' }] };
    const w = mountEditor(draft);

    expect(w.findAll('.metrics-table input.invalid')).toHaveLength(0);

    await renameColumn(w, 0, '   ');
    await w.findAll('.metrics-table tbody tr')[0]!.findAll('td')[1]!.get('input').setValue('');

    expect(w.findAll('.metrics-table input.invalid')).toHaveLength(2);
  });
});
