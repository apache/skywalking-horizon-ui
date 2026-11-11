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
import { ANNOTATION_TERM_SEPARATOR, parseAnnotationTerms } from './zipkinAnnotationTerms';

describe('parseAnnotationTerms', () => {
  it('takes a bare annotation and a key=value tag', () => {
    expect(parseAnnotationTerms('error')).toEqual(['error']);
    expect(parseAnnotationTerms(' http.method = GET ')).toEqual(['http.method=GET']);
  });

  it('splits terms typed together on " and ", as Zipkin does', () => {
    expect(parseAnnotationTerms('error and http.method=GET')).toEqual(['error', 'http.method=GET']);
  });

  it('keeps a value that holds = whole', () => {
    expect(parseAnnotationTerms('http.url=/a?b=c')).toEqual(['http.url=/a?b=c']);
  });

  it('refuses a term with an empty side, and an empty term between separators', () => {
    expect(parseAnnotationTerms('http.method=')).toBeNull();
    expect(parseAnnotationTerms('=GET')).toBeNull();
    expect(parseAnnotationTerms('error and ')).toBeNull();
    expect(parseAnnotationTerms(' and error')).toBeNull();
  });

  it('joins back into the query Zipkin parses', () => {
    expect(['error', 'http.method=GET'].join(ANNOTATION_TERM_SEPARATOR)).toBe('error and http.method=GET');
  });
});
