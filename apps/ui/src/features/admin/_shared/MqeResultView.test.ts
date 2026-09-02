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
import type { ExpressionResult, ExpressionResultType } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import MqeResultView from './MqeResultView.vue';

function empty(type: ExpressionResultType): ExpressionResult {
  return { type, results: [{ metric: { labels: [] }, values: [] }] };
}

describe('MqeResultView empty envelopes', () => {
  for (const type of ['SINGLE_VALUE', 'SORTED_LIST', 'RECORD_LIST'] as const) {
    it(`renders ${type} with an empty values row as no rows`, () => {
      const wrapper = mount(MqeResultView, {
        props: { result: empty(type), step: 'MINUTE' },
        global: { plugins: [i18n] },
      });
      expect(wrapper.get('.mrv-empty').text()).toContain('No rows returned');
      expect(wrapper.find('.mrv-table').exists()).toBe(false);
    });
  }
});
