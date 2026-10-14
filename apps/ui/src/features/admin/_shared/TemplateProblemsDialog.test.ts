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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import TemplateProblemsDialog from './TemplateProblemsDialog.vue';
import { formatProblemPath, type TemplateProblem } from './templateProblems';

// Monaco does not run under jsdom; the stub keeps the props the dialog hands
// the editor and exposes the same `revealOffset` it calls.
const { revealOffset } = vi.hoisted(() => ({ revealOffset: vi.fn() }));
vi.mock('@/components/primitives/MonacoView.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'MonacoView',
      props: { value: { type: String, required: true }, language: String, markers: Array },
      setup(_props, { expose }) {
        expose({ revealOffset });
        return () => h('div', { class: 'monaco-stub' });
      },
    }),
  };
});

const TEXT = '{\n  "content": {\n    "key": "GENERAL",\n    "widgets": [\n      { "title": 1 }\n    ]\n  }\n}';

const PROBLEMS: TemplateProblem[] = [
  { path: ['content', 'widgets', 0, 'title'], message: 'Expected a string' },
  { path: ['content', 'components'], message: 'Required' },
  { path: ['not', 'here'], message: 'Unknown section' },
  { path: [], message: 'Unexpected end of input', offset: 7 },
  { path: [], message: 'Past the end', offset: 999 },
];

function mountDialog(props: Partial<InstanceType<typeof TemplateProblemsDialog>['$props']> = {}) {
  return mount(TemplateProblemsDialog, {
    props: { open: true, title: 'horizon.layer.GENERAL', text: TEXT, problems: PROBLEMS, ...props },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

afterEach(() => {
  revealOffset.mockReset();
  vi.restoreAllMocks();
});

describe('formatProblemPath', () => {
  it('writes keys with dots, indexes in brackets, and odd keys quoted', () => {
    expect(formatProblemPath(['dashboards', 'service', 3, 'expressions', 0], '(root)')).toBe(
      'dashboards.service[3].expressions[0]',
    );
    expect(formatProblemPath(['layer-header', 'columns'], '(root)')).toBe('layer-header.columns');
    expect(formatProblemPath(['i18n', 'a.b', '', 'x y'], '(root)')).toBe('i18n["a.b"][""]["x y"]');
    expect(formatProblemPath([2, 'k'], '(root)')).toBe('[2].k');
    expect(formatProblemPath([], '(root)')).toBe('(root)');
  });
});

describe('TemplateProblemsDialog', () => {
  it('lists every problem with its path, and says which ones could not be placed', () => {
    const w = mountDialog();
    expect(w.get('.tpd__count').text()).toBe('5 problems');
    const items = w.findAll('.tpd__item');
    expect(items.map((i) => i.get('.tpd__path').text())).toEqual([
      'content.widgets[0].title',
      'content.components',
      'not.here',
      '(root)',
      '(root)',
    ]);
    expect(items.map((i) => i.find('.tpd__lost').exists())).toEqual([false, false, false, false, true]);
    expect(items[4]!.attributes('disabled')).toBeDefined();
    expect(items[0]!.attributes('disabled')).toBeUndefined();
  });

  it('marks each placeable problem where it sits in the text', () => {
    const w = mountDialog();
    const markers = w.getComponent({ name: 'MonacoView' }).props('markers') as Array<{
      offset: number;
      length: number;
      message: string;
    }>;
    expect(markers).toHaveLength(4);
    const at = (i: number): string => TEXT.slice(markers[i]!.offset, markers[i]!.offset + markers[i]!.length);
    expect(at(0)).toBe('1');
    expect(markers[0]!.message).toBe('content.widgets[0].title: Expected a string');
    // The missing key marks the object that lacks it.
    expect(at(1)).toBe('"content"');
    // A key missing from the root marks the root's opening brace.
    expect(markers[2]).toEqual({ offset: 0, length: 1, message: 'not.here: Unknown section' });
    expect(markers[3]).toEqual({ offset: 7, length: 1, message: 'Unexpected end of input' });
  });

  it('reveals a problem in the text when it is clicked', async () => {
    const w = mountDialog();
    await w.findAll('.tpd__item')[1]!.trigger('click');
    expect(revealOffset).toHaveBeenCalledWith(TEXT.indexOf('"content"'));
    expect(w.findAll('.tpd__item')[1]!.classes()).toContain('tpd__item--sel');
  });

  it('places nothing by path in text that is not JSON, but keeps offset problems', () => {
    const w = mountDialog({ text: '{"content": {', problems: [PROBLEMS[0]!, { path: [], message: 'cut', offset: 13 }] });
    expect(w.findAll('.tpd__item').map((i) => i.find('.tpd__lost').exists())).toEqual([true, false]);
  });

  it('downloads the text exactly as given, only when a file name is set', async () => {
    expect(
      mountDialog()
        .findAll('button')
        .some((b) => b.text() === 'Download'),
    ).toBe(false);

    let blob: Blob | null = null;
    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:test';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('GENERAL.json');
    });
    const w = mountDialog({ downloadName: 'GENERAL.json' });
    await w
      .findAll('button')
      .find((b) => b.text() === 'Download')!
      .trigger('click');
    expect(click).toHaveBeenCalledOnce();
    expect(blob!.type).toBe('application/json');
    const read = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blob!);
    });
    expect(read).toBe(TEXT);
  });

  it('emits close from the Close button', async () => {
    const w = mountDialog();
    await w
      .findAll('button')
      .find((b) => b.text() === 'Close')!
      .trigger('click');
    expect(w.emitted('close')).toHaveLength(1);
  });
});
