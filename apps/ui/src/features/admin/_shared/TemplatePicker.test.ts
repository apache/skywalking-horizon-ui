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

import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import TemplatePicker, { type TemplatePickerEntry } from './TemplatePicker.vue';

const entry = (key: string, extra: Partial<TemplatePickerEntry> = {}): TemplatePickerEntry => ({
  value: `horizon.layer.${key}`,
  label: key,
  key,
  syncBadge: 'synced',
  ...extra,
});

enableAutoUnmount(afterEach);

describe('TemplatePicker — Invalid filter', () => {
  it('counts and keeps an entry whose source — enabled or disabled — or any language is invalid', async () => {
    const w = mount(TemplatePicker, {
      props: {
        modelValue: null,
        kindLabel: 'layers',
        entries: [
          entry('GENERAL', { localeBadges: [{ locale: 'zh-CN', status: 'invalid' }, { locale: 'ja', status: 'synced' }] }),
          entry('MESH', { localeBadges: [{ locale: 'zh-CN', status: 'synced' }] }),
          entry('FLINK', { syncBadge: 'invalid' }),
          entry('KAFKA', { syncBadge: 'disabled', invalid: true }),
        ],
      },
      global: { plugins: [i18n] },
    });
    await w.find('.tp-btn').trigger('click');
    expect(w.find('.tp-filter-count.invalid').text()).toBe('3');

    await w.find('.tp-filter.invalid input').setValue(true);
    expect(w.findAll('.tp-row .tp-name').map((n) => n.text())).toEqual(['GENERAL', 'FLINK', 'KAFKA']);
    // Disabled and invalid are two facts, so a disabled invalid record shows both.
    const kafka = w.findAll('.tp-row').find((r) => r.text().includes('KAFKA'))!;
    expect(kafka.findAll('.tsb').map((c) => c.text())).toEqual(['disabled', 'invalid']);
  });
});
