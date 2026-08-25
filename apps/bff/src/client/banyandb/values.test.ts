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
 * The encoder is the client's most silent failure mode: a TagValue whose oneof
 * arm disagrees with the tag's DECLARED type is stored as NULL and the write
 * still reports success. These tests pin that the arm is chosen by the
 * declared type and never by the JavaScript value.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeFieldValue,
  decodeTagFamily,
  decodeTagValue,
  fieldValue,
  fromPbTimestamp,
  pbTimestamp,
  tagValue,
} from './values.js';

describe('tag encoding', () => {
  it('picks the arm from the DECLARED type, not the runtime value', () => {
    // A number handed to a string tag must land in `str`, not `int`.
    expect(tagValue('TAG_TYPE_STRING', 42)).toEqual({ str: { value: '42' } });
    // ...and a numeric string handed to an int tag must land in `int`.
    expect(tagValue('TAG_TYPE_INT', '42')).toEqual({ int: { value: '42' } });
  });

  it('carries 64-bit integers as decimal strings', () => {
    expect(tagValue('TAG_TYPE_INT', 9007199254740993n)).toEqual({
      int: { value: '9007199254740993' },
    });
  });

  it('refuses a number that has already lost precision', () => {
    // Above 2^53 the caller's value was wrong before it arrived; writing it
    // would silently store a different number than they meant. Computed rather
    // than written as a literal, because the literal itself cannot survive the
    // parser — which is the whole point being asserted.
    expect(() => tagValue('TAG_TYPE_INT', Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer/);
  });

  it('encodes absent as an explicit NULL arm, not an empty message', () => {
    const expected = { null: 'NULL_VALUE' };
    expect(tagValue('TAG_TYPE_STRING', undefined)).toEqual(expected);
    expect(tagValue('TAG_TYPE_STRING', null)).toEqual(expected);
    expect(tagValue('TAG_TYPE_INT', undefined)).toEqual(expected);
  });

  it('encodes arrays by their declared element type', () => {
    expect(tagValue('TAG_TYPE_STRING_ARRAY', ['a', 'b'])).toEqual({ str_array: { value: ['a', 'b'] } });
    expect(tagValue('TAG_TYPE_INT_ARRAY', [1, 2])).toEqual({ int_array: { value: ['1', '2'] } });
  });
});

describe('tag decoding', () => {
  it('switches on the oneof discriminator, which shares its name with the payload', () => {
    // A decoded tag reads `value === 'str'` AND `str.value === 'a'`; probing
    // the arms instead of the discriminator confuses the two.
    expect(decodeTagValue({ value: 'str', str: { value: 'a' } })).toBe('a');
    expect(decodeTagValue({ value: 'int', int: { value: '7' } })).toBe('7');
    expect(decodeTagValue({ value: 'str_array', str_array: { value: ['a'] } })).toEqual(['a']);
  });

  it('reads an explicit NULL back as null, distinct from an empty string', () => {
    expect(decodeTagValue({ value: 'null', null: 'NULL_VALUE' })).toBeNull();
    expect(decodeTagValue({ value: 'str', str: { value: '' } })).toBe('');
  });

  it('survives an absent submessage, which defaults leave null rather than filling', () => {
    expect(decodeTagValue({ value: 'str' })).toBeNull();
    expect(decodeTagValue(null)).toBeNull();
  });

  it('reads a family as a name-keyed object', () => {
    expect(
      decodeTagFamily({
        name: 'searchable',
        tags: [
          { key: 'a', value: { value: 'str', str: { value: 'x' } } },
          { key: 'b', value: { value: 'int', int: { value: '2' } } },
        ],
      }),
    ).toEqual({ a: 'x', b: '2' });
  });
});

describe('field values', () => {
  it('encodes by declared type', () => {
    expect(fieldValue('FIELD_TYPE_INT', 5)).toEqual({ int: { value: '5' } });
    expect(fieldValue('FIELD_TYPE_FLOAT', 1.5)).toEqual({ float: { value: 1.5 } });
    expect(fieldValue('FIELD_TYPE_STRING', 5)).toEqual({ str: { value: '5' } });
    expect(fieldValue('FIELD_TYPE_INT', undefined)).toEqual({ null: 'NULL_VALUE' });
  });

  it('decodes what the wire returns', () => {
    // Encoding and decoding are NOT symmetric, and a naive round-trip test
    // would hide that: the oneof discriminator is added by the decoder, so a
    // locally-built value has no `value` key and the decoders — which trust
    // the discriminator — would read it as null. Decode is only ever applied
    // to a message that came back from the server, so the fixtures here carry
    // the discriminator the way a decoded one does.
    expect(decodeFieldValue({ value: 'int', int: { value: '5' } })).toBe('5');
    expect(decodeFieldValue({ value: 'float', float: { value: 1.5 } })).toBe(1.5);
    expect(decodeFieldValue({ value: 'null', null: 'NULL_VALUE' })).toBeNull();
  });
});

describe('timestamps', () => {
  it('splits whole milliseconds into seconds and nanos', () => {
    expect(pbTimestamp(1_700_000_000_123)).toEqual({ seconds: '1700000000', nanos: 123_000_000 });
  });

  it('refuses sub-millisecond precision the server would reject outright', () => {
    expect(() => pbTimestamp(1.5)).toThrow(/whole milliseconds/);
  });

  it('round-trips', () => {
    expect(fromPbTimestamp(pbTimestamp(1_700_000_000_123))).toBe(1_700_000_000_123);
    expect(fromPbTimestamp(undefined)).toBe(0);
  });
});
