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
import { topNOrderOf } from './loader';

describe('topNOrderOf — resolve top_n sort direction from the MQE', () => {
  it('reads the explicit asc / des argument', () => {
    expect(topNOrderOf(['top_n(service_instance_sla,10,asc)/100'])).toBe('asc');
    expect(topNOrderOf(['top_n(endpoint_cpm,20,des)'])).toBe('des');
  });

  it('takes the FIRST top_n expression when several are present (tab-switch widgets)', () => {
    // The compare grid merges the first expression (topGroups[0]), so its order wins.
    expect(
      topNOrderOf(['top_n(endpoint_cpm,20,des)', 'top_n(endpoint_sla,20,asc)/100']),
    ).toBe('des');
  });

  it('tolerates whitespace and case', () => {
    expect(topNOrderOf(['top_n( service_instance_sla , 10 , ASC )/100'])).toBe('asc');
  });

  it('is undefined when no order argument is declared', () => {
    expect(topNOrderOf(['top_n(service_instance_cpm,10)'])).toBeUndefined();
  });

  it('is undefined for non-top_n expressions (record sources, plain metrics)', () => {
    expect(topNOrderOf(['top_n_service_database_statement'])).toBeUndefined();
    expect(topNOrderOf(['service_instance_cpm'])).toBeUndefined();
  });

  it('is undefined for empty / missing input', () => {
    expect(topNOrderOf([])).toBeUndefined();
    expect(topNOrderOf(undefined)).toBeUndefined();
  });
});
