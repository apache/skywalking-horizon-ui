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

import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { i18n } from '@/i18n';
import EvaluationRecordDetailPopout from './EvaluationRecordDetailPopout.vue';

vi.mock('@/state/auth', () => ({ useAuthStore: () => ({ hasVerb: () => true }) }));

function row(valueType: string, content: string) {
  return {
    serviceName: 'e2e-spring-ai', serviceId: 's', serviceInstanceName: null, serviceInstanceId: null,
    endpointName: 'Faithfulness', endpointId: null, traceId: 'trace-1', timestamp: 1788393600000,
    contentType: 'text/plain', content,
    tags: [{ key: 'task_name', value: 'Faithfulness' }, { key: 'value_type', value: valueType }, { key: 'reason', value: 'grounded' }],
  };
}
function open(r: ReturnType<typeof row>) {
  return mount(EvaluationRecordDetailPopout, {
    props: { row: r },
    attachTo: document.body,
    global: { plugins: [createPinia(), i18n], stubs: { teleport: true } },
  });
}

describe('EvaluationRecordDetailPopout', () => {
  it.each([['SCORE', '0.8'], ['BOOLEAN', 'true']])('shows a %s verdict as the first table row, with no content pane', (type, value) => {
    const w = open(row(type, value));
    expect(w.find('.ld-body').exists()).toBe(false);
    expect(w.find('.ld-tags').classes()).toContain('ld-tags--full');
    const first = w.findAll('.ld-tag-tbl tbody tr')[0];
    expect(first.classes()).toContain('ld-value-row');
    expect(first.text()).toContain(value);
    w.unmount();
  });

  it.each(['STRING', 'JSON'])('keeps the content pane beside the table for a %s verdict', (type) => {
    const w = open(row(type, type === 'JSON' ? '{"ok":true}' : 'looks fine'));
    expect(w.find('.ld-body').exists()).toBe(true);
    expect(w.find('.ld-tags').classes()).not.toContain('ld-tags--full');
    expect(w.find('.ld-value-row').exists()).toBe(false);
    w.unmount();
  });
});
