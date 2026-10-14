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
 * A layer with no topology or API-dependency block of its own gets the
 * built-in default metrics, while an empty block means none. So opening either
 * tab must write nothing: an empty block seeded on view would take the map's
 * metrics away on the next save.
 */

import { describe, expect, it } from 'vitest';
import { defineComponent, h, ref, type Component } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import TopologyConfigEditor from './TopologyConfigEditor.vue';
import DependencyConfigSection from './DependencyConfigSection.vue';
import ProcessConfigEditor from './ProcessConfigEditor.vue';
import DeploymentConfigEditor from './DeploymentConfigEditor.vue';

const global = { plugins: [i18n], stubs: { MqeExpressionInput: true } };

describe('config editors — opening a tab is no edit', () => {
  it('Topology: writes nothing, and says the built-in metrics apply', () => {
    const w = mount(TopologyConfigEditor, { props: { config: undefined, serviceNoun: 'Service', instanceNoun: 'Instance' }, global });
    expect(w.emitted('update:config')).toBeUndefined();
    expect(w.find('.defaults-note').exists()).toBe(true);
  });

  it('API dependency: writes nothing, and says the built-in metrics apply', () => {
    const w = mount(DependencyConfigSection, { props: { config: undefined }, global });
    expect(w.emitted('update:config')).toBeUndefined();
    expect(w.find('.defaults-note').exists()).toBe(true);
  });

  it('Process topology: writes nothing for a layer that has no block', () => {
    const w = mount(ProcessConfigEditor, { props: { config: undefined }, global });
    expect(w.emitted('update:config')).toBeUndefined();
  });

  it('Topology: the first change starts the layer’s own block', async () => {
    const w = mount(TopologyConfigEditor, { props: { config: undefined, serviceNoun: 'Service', instanceNoun: 'Instance' }, global });
    await w.find('.comp-toggle input').trigger('change');
    expect(w.emitted('update:config')?.[0]?.[0]).toMatchObject({ nodeMetrics: [], showGroup: true });
  });
});

/** The editor as the page mounts it: the parent owns the model, so a write
 *  comes back as a prop only after the parent re-renders. */
function bound(editor: Component, props: Record<string, unknown>) {
  const model = ref<Record<string, unknown[]> | undefined>(undefined);
  const Parent = defineComponent({
    render: () => h(editor, { ...props, config: model.value, 'onUpdate:config': (v: Record<string, unknown[]>) => (model.value = v) }),
  });
  return { wrapper: mount(Parent, { global }), model };
}

describe('config editors — the first change on a layer with no block lands', () => {
  it.each([
    ['Topology', TopologyConfigEditor, { serviceNoun: 'Service', instanceNoun: 'Instance' }, 'nodeMetrics'],
    ['API dependency', DependencyConfigSection, {}, 'nodeMetrics'],
    ['Process topology', ProcessConfigEditor, {}, 'edgeMetrics'],
    ['Deployment', DeploymentConfigEditor, { instanceNoun: 'Instance' }, 'roles'],
  ] as const)('%s', async (_name, editor, props, list) => {
    const { wrapper, model } = bound(editor, props);
    await wrapper.find('.sw-btn.add').trigger('click');
    await flushPromises();
    expect(model.value?.[list]).toHaveLength(1);
  });
});
