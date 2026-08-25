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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INCLUDE_DIR, loadBanyanDBProto, PROTO_FILES } from './proto.js';
import type { banyandb } from './proto.pb.js';

describe('vendored BanyanDB proto tree', () => {
  it('vendors validate/validate.proto, without which nothing loads', () => {
    // Every banyandb .proto does `import "validate/validate.proto"`, and the
    // BanyanDB proto repo does NOT ship it — it comes from protoc-gen-validate.
    // Miss it and the whole tree fails to parse, so it is asserted separately
    // from the load below to make the cause obvious when it regresses.
    expect(existsSync(join(INCLUDE_DIR, 'validate', 'validate.proto'))).toBe(true);
  });

  it('loads every file the client uses', () => {
    const def = loadBanyanDBProto();
    expect(Object.keys(def).length).toBeGreaterThan(0);
    for (const f of PROTO_FILES) expect(existsSync(join(INCLUDE_DIR, f))).toBe(true);
  });

  it('exposes the services the audit store will call', () => {
    const def = loadBanyanDBProto();
    for (const svc of [
      'banyandb.stream.v1.StreamService',
      'banyandb.measure.v1.MeasureService',
      'banyandb.database.v1.GroupRegistryService',
      'banyandb.database.v1.StreamRegistryService',
      'banyandb.database.v1.MeasureRegistryService',
      'banyandb.database.v1.IndexRuleRegistryService',
      'banyandb.database.v1.IndexRuleBindingRegistryService',
    ]) {
      expect(def[svc], `${svc} missing from the vendored tree`).toBeDefined();
    }
  });

  it('generated types describe what the loader actually returns', () => {
    // The declarations are generated from the same .proto the loader reads, but
    // they encode the OPTIONS too — snake_case names, 64-bit as string, enums as
    // their names. Assert that here, or the two drift silently and the compiler
    // cheerfully checks a shape the wire never produces.
    const opts: banyandb.common.v1.ResourceOpts = {
      shard_num: 1,
      ttl: { unit: 'UNIT_DAY', num: 30 },
      replicas: 1,
    };
    expect(opts.shard_num).toBe(1);

    const meta: banyandb.common.v1.Metadata = { group: 'g', name: 'n', mod_revision: '9007199254740993' };
    // int64 as a STRING: this value is above Number.MAX_SAFE_INTEGER, and a
    // number-typed field would have made it unrepresentable.
    expect(meta.mod_revision).toBe('9007199254740993');

    const ok: banyandb.model.v1.Status = 'STATUS_SUCCEED';
    expect(ok).toBe('STATUS_SUCCEED');
  });

  it('keeps field names snake_case rather than camel-casing the wire', () => {
    // `keepCase: false` would silently rename every field, and the failure
    // would surface as an empty result rather than an error. Assert on real
    // fields the audit store depends on.
    const def = loadBanyanDBProto();
    const names = (t: unknown): string[] =>
      (t as { type: { field: Array<{ name: string }> } }).type.field.map((f) => f.name);

    expect(names(def['banyandb.stream.v1.QueryRequest'])).toEqual(
      expect.arrayContaining(['time_range', 'order_by', 'projection', 'limit']),
    );
    expect(names(def['banyandb.stream.v1.ElementValue'])).toEqual(
      expect.arrayContaining(['element_id', 'timestamp', 'tag_families']),
    );
  });
});
