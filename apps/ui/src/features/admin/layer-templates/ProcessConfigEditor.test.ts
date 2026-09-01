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
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import ProcessConfigEditor from './ProcessConfigEditor.vue';

const config = () => ({
  edgeClientMetrics: [
    { id: 'write', label: 'Write', mqe: 'process_relation_client_write_cpm', aggregation: 'avg' as const },
  ],
  edgeServerMetrics: [
    { id: 'read', label: 'Read', mqe: 'process_relation_server_read_cpm', aggregation: 'avg' as const },
  ],
});

describe('ProcessConfigEditor MQE explorer coverage', () => {
  it('offers Run for both ProcessRelation metric buckets when a layer is selected', () => {
    const wrapper = mount(ProcessConfigEditor, {
      props: { config: config(), layerKey: 'GENERAL' },
      global: { plugins: [i18n] },
    });
    expect(wrapper.findAll('.mqe-run')).toHaveLength(2);
  });

  it('does not invent runnable context without a selected layer', () => {
    const wrapper = mount(ProcessConfigEditor, {
      props: { config: config() },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('.mqe-run').exists()).toBe(false);
  });
});
