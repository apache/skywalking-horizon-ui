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
import { defineComponent, h, ref, type Component } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { DeploymentConfig } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import DeploymentConfigEditor from './DeploymentConfigEditor.vue';

function editorWith(config: DeploymentConfig) {
  const model = ref<DeploymentConfig | undefined>(config);
  const Parent = defineComponent({
    render: () =>
      h(DeploymentConfigEditor as Component, {
        instanceNoun: 'Instance',
        config: model.value,
        'onUpdate:config': (v: DeploymentConfig) => (model.value = v),
      }),
  });
  const wrapper = mount(Parent, { global: { plugins: [i18n], stubs: { MqeExpressionInput: true } } });
  return { wrapper, model };
}

describe('a role pair primary follows a committed metric rename', () => {
  type Input = ReturnType<ReturnType<typeof editorWith>['wrapper']['find']>;
  /** As a browser types: an input event per keystroke, a change on commit. */
  async function typeId(input: Input, values: string[], commit = true): Promise<void> {
    await input.trigger('focus');
    for (const value of values) {
      (input.element as HTMLInputElement).value = value;
      await input.trigger('input');
    }
    if (commit) await input.trigger('change');
    await flushPromises();
  }

  it('to the id it ends on, not one it passes through', async () => {
    const { wrapper, model } = editorWith({
      roleToRole: [{
        from: 'liaison', to: 'data', primary: 'latency',
        metrics: [{ id: 'latency', label: 'Latency', mqe: 'x' }, { id: 'load', label: 'Load', mqe: 'y' }],
      }],
    });
    await typeId(wrapper.findAll('.metric-row input.mf-input.mono')[0]!, ['', 'l', 'lo', 'load', 'load_', 'load_time']);
    expect(model.value!.roleToRole![0]!.primary).toBe('load_time');
  });

  it('through an id committed blank, then typed again', async () => {
    const { wrapper, model } = editorWith({
      roleToRole: [{ from: 'liaison', to: 'data', primary: 'latency', metrics: [{ id: 'latency', label: 'Latency', mqe: 'x' }] }],
    });
    const id = wrapper.findAll('.metric-row input.mf-input.mono')[0]!;
    await typeId(id, ['']);
    expect(model.value!.roleToRole![0]!.primary).toBe('latency');
    await typeId(id, ['p', 'p9', 'p99']);
    expect(model.value!.roleToRole![0]!.primary).toBe('p99');
  });

  it('not while the other metric sharing the id still answers to it', async () => {
    const { wrapper, model } = editorWith({
      roleToRole: [{
        from: 'liaison', to: 'data', primary: 'write',
        metrics: [{ id: 'write', label: 'Write', mqe: 'x', role: 'lineServer' }, { id: 'write', label: 'Write', mqe: 'y', role: 'lineClient' }],
      }],
    });
    await typeId(wrapper.findAll('.metric-row input.mf-input.mono')[0]!, ['writes']);
    expect(model.value!.roleToRole![0]!.primary).toBe('write');
  });
});
