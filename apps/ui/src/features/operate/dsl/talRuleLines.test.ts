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
import { ruleLines } from './talRuleLines';

const at = (text: string, rules: { name: string; line: number }[]) =>
  Object.fromEntries([...ruleLines(text.split('\n'), rules)].map(([line, rule]) => [rule.name + '@' + rules.indexOf(rule), line]));

describe('ruleLines', () => {
  it('keeps the listing’s line when the text declares the rule there, quoted or commented', () => {
    const text = ['rules:', "  - name: 'PAY' # payments rule", '    layer: GENERAL', '  - name: "ship"', '    layer: GENERAL'].join('\n');
    expect(at(text, [{ name: 'PAY', line: 2 }, { name: 'ship', line: 4 }])).toEqual({ 'PAY@0': 2, 'ship@1': 4 });
  });

  it('finds the line the text declares the rule on when the listing read another version of the file', () => {
    const text = ['rules:', '  # added since the listing', '  - name: demo', '    layer: GENERAL'].join('\n');
    expect(at(text, [{ name: 'demo', line: 2 }])).toEqual({ 'demo@0': 3 });
  });

  it('declares a rule only in the rules sequence: not a layer definition, nor a key inside a rule', () => {
    const text = [
      'layerDefinitions:',
      '  - name: PAY',
      'rules:',
      '  - layer: GENERAL',
      '    name: PAY',
      '    dsl: |',
      '      name: PAY',
    ].join('\n');
    expect(at(text, [{ name: 'PAY', line: 1 }])).toEqual({ 'PAY@0': 5 });
  });

  it('gives two rules of one name a declaration each, in order, and leaves out a rule the text lacks', () => {
    const text = ['rules:', '  - name: twin', '  - name: twin'].join('\n');
    expect(at(text, [{ name: 'twin', line: 9 }, { name: 'twin', line: 9 }, { name: 'gone', line: 2 }])).toEqual({
      'twin@0': 2,
      'twin@1': 3,
    });
  });

  it('reads a sequence whose dashes sit at the key’s column, or take more than one space', () => {
    const indentless = ['rules:', '- name: first', '  layer: GENERAL', '- layer: GENERAL', '  name: second', 'other: x', '- name: not-a-rule'].join('\n');
    expect(at(indentless, [{ name: 'first', line: 0 }, { name: 'second', line: 0 }, { name: 'not-a-rule', line: 0 }]))
      .toEqual({ 'first@0': 2, 'second@1': 5 });
    const spaced = ['rules:', '  -  name: r1', '     layer: GENERAL', '  -  name: r2'].join('\n');
    expect(at(spaced, [{ name: 'r1', line: 0 }, { name: 'r2', line: 0 }])).toEqual({ 'r1@0': 2, 'r2@1': 4 });
  });
});

