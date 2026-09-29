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
 * The layer URLs resolve by position alone: a group, a tab, `page` and a page
 * id never have to be told apart by name, so no name is reserved.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { layerRoutes } from './index';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' }, children: layerRoutes() },
    { path: '/:catchAll(.*)*', component: { template: '<div />' }, meta: { notFound: true } },
  ],
});

function resolve(url: string) {
  const r = router.resolve(url);
  return {
    path: r.path,
    layer: r.params.layerKey,
    group: r.params.group,
    row: r.meta.layerRow,
    page: r.params.pageId,
    notFound: r.meta.notFound === true,
  };
}

describe('layer URLs', () => {
  it('put a split layer\'s group in its own segment, and its ungrouped services on the layer\'s own URLs', () => {
    expect(resolve('/layer/general/payments/topology')).toMatchObject({ layer: 'general', group: 'payments', row: 'topology' });
    expect(resolve('/layer/general/topology')).toMatchObject({ layer: 'general', group: undefined, row: 'topology' });
    expect(resolve('/layer/general/payments')).toMatchObject({ group: 'payments', row: undefined, notFound: false });
  });

  it('put a sub page under page/, on any entry', () => {
    expect(resolve('/layer/general/service/page/usage')).toMatchObject({ group: undefined, row: 'service', page: 'usage' });
    expect(resolve('/layer/general/payments/instance/page/jvm')).toMatchObject({ group: 'payments', row: 'instance', page: 'jvm' });
  });

  it('let a group be named like a tab, and a page like a tab', () => {
    expect(resolve('/layer/general/service/topology')).toMatchObject({ group: 'service', row: 'topology' });
    expect(resolve('/layer/general/service/service')).toMatchObject({ group: 'service', row: 'service', page: undefined });
    expect(resolve('/layer/general/service/service/page/topology')).toMatchObject({ group: 'service', row: 'service', page: 'topology' });
    expect(resolve('/layer/general/topology/service')).toMatchObject({ group: 'topology', row: 'service' });
  });

  it('decode a group that is not a plain path segment', () => {
    expect(resolve('/layer/general/a%2Fb%20c/service')).toMatchObject({ group: 'a/b c', row: 'service' });
  });

  it('open a group named like a component on its own tabs', () => {
    expect(resolve('/layer/general/service/topology')).toMatchObject({ group: 'service', row: 'topology' });
    expect(resolve('/layer/general/instance/logs')).toMatchObject({ group: 'instance', row: 'logs' });
  });

  // Old addresses are not carried over: a bookmark in an old form is not found.
  it('send an old sub-page address, and any other unknown path, to the app\'s not-found route', () => {
    for (const url of [
      '/layer/mesh/service/usage',
      '/layer/general/service/traces',
      '/layer/general/topology/x',
      '/layer/general/payments/topology/x',
      '/layer/general/services/abc',
      // Renamed tabs are not carried over either.
      '/layer/general/traces/x',
    ]) {
      expect(resolve(url).notFound, url).toBe(true);
    }
  });



});
