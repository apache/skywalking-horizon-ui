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
import { parseTagPair } from './tagFilter';

describe('parseTagPair', () => {
  it('reads key=value, trimming both sides', () => {
    expect(parseTagPair(' http.method = GET ')).toEqual({ key: 'http.method', value: 'GET' });
  });

  it('splits at the first = so a value may hold one', () => {
    expect(parseTagPair('db.statement=a=b')).toEqual({ key: 'db.statement', value: 'a=b' });
  });

  it('keeps the value verbatim when asked, still trimming the key', () => {
    expect(parseTagPair(' db.statement= SELECT 1 ', { exactValue: true })).toEqual({ key: 'db.statement', value: ' SELECT 1 ' });
    expect(parseTagPair('db.statement=  ', { exactValue: true })).toBeNull();
  });

  it('refuses text without =, or with either side empty', () => {
    expect(parseTagPair('http.method')).toBeNull();
    expect(parseTagPair('http.method=')).toBeNull();
    expect(parseTagPair('=GET')).toBeNull();
    expect(parseTagPair(' = ')).toBeNull();
  });
});
