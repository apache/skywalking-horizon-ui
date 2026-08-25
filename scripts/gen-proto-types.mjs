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
 * Emit TypeScript declarations for the vendored BanyanDB wire contract.
 *
 * TYPES ONLY — no encode/decode, no clients, no runtime code. Generated
 * serialization would need ASF headers it does not carry, earn NOTICE
 * entries, and go stale the moment the pin moves; a declaration file is pure
 * compiler input with none of that. The wire codec stays `@grpc/proto-loader`
 * reading the .proto at runtime.
 *
 * The shapes describe what proto-loader ACTUALLY HANDS BACK under the options
 * in client/banyandb/proto.ts, which is why this generator is coupled to them:
 *   keepCase: true  → field names stay snake_case
 *   longs:   String → 64-bit integers arrive as decimal strings
 *   enums:   String → enum values arrive as their names
 *   oneofs:  true   → a `<name>` discriminator names the set member
 * Change an option there and the declarations here become a lie, so both are
 * asserted by the same test.
 *
 * Run via `pnpm proto:sync`; `pnpm proto:check` regenerates and fails on any
 * diff, so this output is committed and provably in step with the .proto.
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

// protobufjs ships the well-known types (descriptor.proto and friends) inside
// its own package. validate.proto imports descriptor.proto, and the vendored
// tree deliberately does not carry it — so those resolve against protobufjs
// rather than against our directory.
const PROTOBUFJS_DIR = dirname(createRequire(import.meta.url).resolve('protobufjs/package.json'));

const root_ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROTO_DIR = resolve(root_, 'apps/bff/src/client/banyandb/proto');
const OUT = resolve(root_, 'apps/bff/src/client/banyandb/proto.pb.d.ts');

const FILES = [
  'banyandb/v1/banyandb-common.proto',
  'banyandb/v1/banyandb-model.proto',
  'banyandb/v1/banyandb-database.proto',
  'banyandb/v1/banyandb-stream.proto',
  'banyandb/v1/banyandb-measure.proto',
  // Loaded at runtime by proto.ts, so its types belong here too — otherwise
  // the barrier's request and response shapes are hand-written and sit outside
  // what `proto:check` can keep honest.
  'banyandb/v1/banyandb-schema.proto',
];

// `longs: String` is why every 64-bit width maps to string: a JS number silently
// loses precision above 2^53, and BanyanDB INT tags are full-width.
const SCALARS = {
  double: 'number', float: 'number',
  int32: 'number', uint32: 'number', sint32: 'number', fixed32: 'number', sfixed32: 'number',
  int64: 'string', uint64: 'string', sint64: 'string', fixed64: 'string', sfixed64: 'string',
  bool: 'boolean', string: 'string', bytes: 'Buffer',
};

const root = new protobuf.Root();
root.resolvePath = (_origin, target) =>
  target.startsWith('google/protobuf/')
    ? resolve(PROTOBUFJS_DIR, target)
    : resolve(PROTO_DIR, target);
root.loadSync(FILES, { keepCase: true });
root.resolveAll();

const ind = (n) => '  '.repeat(n);

function typeOf(field) {
  if (SCALARS[field.type]) return SCALARS[field.type];
  const r = field.resolvedType;
  if (!r) return 'unknown';
  // google.protobuf.Struct / Value / ListValue are dynamic JSON by definition;
  // naming their generated shape would be more precise than it is true.
  // The JSON-ish well-known types are wrappers, not the JS values they model.
  // A Struct is `{fields: {name: Value}}` and a Value is a oneof — typing
  // either as a bare object or as `unknown` invites a literal that type-checks
  // and then serialises to an EMPTY message with no error from either side.
  if (r.fullName === '.google.protobuf.Struct') return 'google.protobuf.Struct';
  if (r.fullName === '.google.protobuf.Value') return 'google.protobuf.Value';
  if (r.fullName === '.google.protobuf.ListValue') return 'google.protobuf.ListValue';
  return r.fullName.replace(/^\./, '');
}

function emitEnum(e, depth) {
  const names = Object.keys(e.values).map((v) => `'${v}'`).join(' | ');
  // `enums: String` — the wire hands back the NAME, not the number.
  return `${ind(depth)}export type ${e.name} = ${names};\n`;
}

function emitMessage(m, depth) {
  let out = `${ind(depth)}export interface ${m.name} {\n`;
  for (const f of m.fieldsArray) {
    let t = typeOf(f);
    const isMessage = !SCALARS[f.type] && !(f.resolvedType instanceof protobuf.Enum);
    if (f.map) {
      const k = SCALARS[f.keyType] ?? 'string';
      t = `Partial<Record<${k}, ${t}>>`;
    } else if (f.repeated) {
      t = `${t}[]`;
    } else if (isMessage) {
      // `defaults: true` fills scalars but leaves an unset MESSAGE as null, not
      // absent. Typing it optional-only lets `a.b.c` compile and then throw.
      t = `${t} | null`;
    }
    // `defaults: true` fills scalars, but a message-typed field stays absent
    // when unset, and repeated/oneof members are genuinely optional.
    out += `${ind(depth + 1)}${f.name}?: ${t};\n`;
  }
  for (const o of m.oneofsArray ?? []) {
    const members = o.oneof.map((n) => `'${n}'`).join(' | ');
    // `oneofs: true` adds a discriminator naming which member is set.
    out += `${ind(depth + 1)}${o.name}?: ${members};\n`;
  }
  out += `${ind(depth)}}\n`;

  const nested = (m.nestedArray ?? []).filter((n) => !(n instanceof protobuf.Field));
  if (nested.length > 0) {
    out += `${ind(depth)}export namespace ${m.name} {\n`;
    for (const n of nested) out += emitNode(n, depth + 1);
    out += `${ind(depth)}}\n`;
  }
  return out;
}

function emitNode(node, depth) {
  if (node instanceof protobuf.Enum) return emitEnum(node, depth);
  if (node instanceof protobuf.Type) return emitMessage(node, depth);
  if (node instanceof protobuf.Namespace) {
    const kids = (node.nestedArray ?? []).filter((n) => !(n instanceof protobuf.Field));
    if (kids.length === 0) return '';
    let out = `${ind(depth)}export namespace ${node.name} {\n`;
    for (const k of kids) out += emitNode(k, depth + 1);
    out += `${ind(depth)}}\n`;
    return out;
  }
  return '';
}

let body = '';
for (const top of root.nestedArray) {
  // `validate` is build-time annotation only — it never appears on the wire.
  // `google` is emitted below, narrowed to what is actually referenced:
  // descriptor.proto in full is thousands of lines of types nothing here uses.
  if (top.name === 'google' || top.name === 'validate') continue;
  body += emitNode(top, 0);
}

// Well-known types, written out rather than generated, because their shape
// under `longs: String` is fixed and pulling them from descriptor.proto would
// drag in the entire descriptor surface. Kept honest by the same type-check:
// an unreferenced entry here is dead, a missing one fails to compile.
const referenced = new Set([...body.matchAll(/google\.protobuf\.([A-Za-z]+)/g)].map((m) => m[1]));
// These three refer to each other, so naming one pulls in the others.
if (referenced.has('Struct') || referenced.has('Value') || referenced.has('ListValue')) {
  referenced.add('Struct');
  referenced.add('Value');
  referenced.add('ListValue');
  referenced.add('NullValue');
}
const WELL_KNOWN = {
  // seconds is int64 → a decimal string, same rule as every other 64-bit field.
  Timestamp: '      export interface Timestamp {\n        seconds?: string;\n        nanos?: number;\n      }\n',
  Duration: '      export interface Duration {\n        seconds?: string;\n        nanos?: number;\n      }\n',
  NullValue: "      export type NullValue = 'NULL_VALUE';\n",
  // The loader keeps these in their protobuf form, and the oneof arms are
  // camelCase here because struct.proto declares them that way.
  Struct:
    '      export interface Struct {\n        fields?: Record<string, google.protobuf.Value>;\n      }\n',
  Value:
    '      export interface Value {\n' +
    '        nullValue?: google.protobuf.NullValue;\n' +
    '        numberValue?: number;\n' +
    '        stringValue?: string;\n' +
    '        boolValue?: boolean;\n' +
    '        structValue?: google.protobuf.Struct;\n' +
    '        listValue?: google.protobuf.ListValue;\n' +
    "        kind?: 'nullValue' | 'numberValue' | 'stringValue' | 'boolValue' | 'structValue' | 'listValue';\n" +
    '      }\n',
  ListValue: '      export interface ListValue {\n        values?: google.protobuf.Value[];\n      }\n',
};
const wk = [...referenced].sort().filter((n) => WELL_KNOWN[n]);
const missing = [...referenced].filter((n) => !WELL_KNOWN[n]);
if (missing.length > 0) {
  throw new Error(`unhandled google.protobuf type(s): ${missing.join(', ')} — add them to WELL_KNOWN`);
}
if (wk.length > 0) {
  body += 'export namespace google {\n  export namespace protobuf {\n';
  for (const n of wk) body += WELL_KNOWN[n];
  body += '  }\n}\n';
}

const header = `/**
 * GENERATED by \`pnpm proto:sync\` from the vendored .proto in ./proto — DO NOT EDIT.
 * \`pnpm proto:check\` regenerates this file and fails on any diff.
 *
 * Types only. These describe what @grpc/proto-loader returns under the options
 * in ./proto.ts (keepCase, longs: String, enums: String, oneofs: true) — see
 * scripts/gen-proto-types.mjs.
 */

`;

writeFileSync(OUT, header + body);
console.log(`  types → ${OUT.replace(root_ + '/', '')} (${(header + body).split('\n').length} lines)`);
