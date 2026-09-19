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

import { describe, it, expect } from 'vitest';
import { lintTraceQL, buildTraceQL, serviceInExpression } from '@/layer/traceql/traceqlLint';
/** Nothing to warn about: every field is one the schema has. */
const clean = (q: string, ds?: 'native' | 'zipkin') => lintTraceQL(q, ds).length === 0;
const ids = (q: string) => lintTraceQL(q).map((i) => i.id);

describe('lint', () => {
  it('passes every form the language defines, whatever a backend does with it', () => {
    // None of these is Horizon's to judge: the fields are in the schema, so the
    // query goes to the backend and the backend answers for it.
    expect(clean('{span.http.method!="GET"}')).toBe(true);
    expect(clean('{span.foo=~"bar"}')).toBe(true);
    expect(clean('{resource.service.name="a"} && {span.http.method="GET"}')).toBe(true);
    expect(clean('{span.a="1" || span.b="2"}')).toBe(true);
    expect(clean('{!status="error"}')).toBe(true);
    expect(clean('{duration=100ms}')).toBe(true);
    expect(clean('{span.retries>=3}')).toBe(true);
    expect(clean('{span.http.status_code>=500}')).toBe(true);
    expect(clean('{resource.instance="aaa"}')).toBe(true);
    expect(clean('{name="/checkout"}')).toBe(true);
    expect(clean('{resource.service.name="a" && duration>100ms && duration<2s}')).toBe(true);
    expect(clean('{}')).toBe(true);
    expect(clean('')).toBe(true);
  });

  it('warns about an attribute with no scope', () => {
    expect(ids('{http.method="GET"}')).toEqual(['unscoped-attribute']);
    expect(ids('{service.name="skywalking"}')).toEqual(['unscoped-attribute']);
    // A scope the schema does not define is the same mistake by another name.
    expect(ids('{event.foo="x"}')).toEqual(['unscoped-attribute']);
    expect(clean('{span.http.method="GET"}')).toBe(true);
    expect(clean('{.http.method="GET"}')).toBe(true);
    expect(clean('{resource.service.name="a"}')).toBe(true);
  });

  it('warns about a bare name that is not an intrinsic', () => {
    expect(ids('{kind=server}')).toEqual(['unknown-field']);
    expect(ids('{traceDuration>1s}')).toEqual(['unknown-field']);
    // The three intrinsics are bare by grammar.
    expect(clean('{duration>100ms}')).toBe(true);
    expect(clean('{status="ok"}')).toBe(true);
    expect(clean('{name="/checkout"}')).toBe(true);
  });

  it('warns about the other store’s resource attribute', () => {
    expect(ids('{resource.instance="aaa"}').length).toBe(0);
    expect(lintTraceQL('{resource.instance="aaa"}', 'zipkin').map((i) => i.id)).toEqual(['other-store-attribute']);
    expect(lintTraceQL('{resource.remote.service="a"}', 'zipkin')).toEqual([]);
    expect(lintTraceQL('{resource.remote.service="a"}', 'native').map((i) => i.id)).toEqual(['other-store-attribute']);
  });

  it('does not fire on text inside a literal', () => {
    expect(clean('{span.message="x!=y"}')).toBe(true);
    expect(clean('{resource.service.name="or"}')).toBe(true);
    expect(clean('{span.message="}" }')).toBe(true);
    expect(clean('{span.kind="server"}')).toBe(true);
    expect(clean('{span.message="not found"}')).toBe(true);
    expect(clean('{span.path="/a!b"}')).toBe(true);
  });

  it('warns on a status the language does not define', () => {
    expect(lintTraceQL('{status="STATUS_CODE_OK"}').map((i) => i.id)).toEqual(['status-vocabulary']);
    expect(clean('{status="error"}')).toBe(true);
    expect(clean('{status="unset"}')).toBe(true);
  });

  it('warns about an expression that is not one complete spanset', () => {
    expect(ids('{')).toContain('incomplete-spanset');
    expect(ids('{resource.service.name="a"')).toContain('incomplete-spanset');
    expect(ids('{resource.service.name=}')).toContain('empty-value');
    expect(ids('{resource.service.name="a" && span.http.method=}')).toContain('empty-value');
  });

  it('escapes a value that carries a quote', () => {
    expect(buildTraceQL({ service: 'svc"quoted' })).toBe('{resource.service.name="svc\\"quoted"}');
  });

  it('reads the service out of a hand-written expression', () => {
    expect(serviceInExpression('{resource.service.name="agent::songs" && duration>10ms}')).toBe('agent::songs');
    expect(serviceInExpression('{ resource.service.name = "a b" }')).toBe('a b');
    // The escapes buildTraceQL wrote come back off.
    expect(serviceInExpression('{resource.service.name="svc\\"quoted"}')).toBe('svc"quoted');
    expect(serviceInExpression('{duration>10ms}')).toBeNull();
    expect(serviceInExpression('')).toBeNull();
  });
});
