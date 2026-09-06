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
import { ENGLISH } from '@skywalking-horizon-ui/conversation-view';
import { i18n, SUPPORTED_LOCALES } from '@/i18n';
import { conversationStrings } from './conversationStrings';

describe('conversationStrings', () => {
  it('covers every text the renderer has, and in English says what the renderer says', () => {
    const t = i18n.global.t as unknown as (key: string, named?: Record<string, unknown>) => string;
    const ours = conversationStrings(t);
    expect(Object.keys(ours).sort()).toEqual(Object.keys(ENGLISH).sort());
    for (const [k, v] of Object.entries(ENGLISH)) expect(ours[k as keyof typeof ours], k).toBe(v);
  });

  it('keeps the placeholders for the renderer to fill, in every locale', async () => {
    const placeholders = /\{[a-zA-Z]+\}/g;
    for (const locale of SUPPORTED_LOCALES) {
      if (locale !== 'en') await i18n.global.setLocaleMessage(locale, (await import(`@/i18n/locales/${locale}.json`)).default);
      i18n.global.locale.value = locale;
      const t = i18n.global.t as unknown as (key: string, named?: Record<string, unknown>) => string;
      const ours = conversationStrings(t);
      for (const [k, en] of Object.entries(ENGLISH)) {
        const want = [...en.matchAll(placeholders)].map((m) => m[0]).sort();
        if (want.length === 0) continue;
        const got = [...ours[k as keyof typeof ours].matchAll(placeholders)].map((m) => m[0]).sort();
        expect(got, `${locale} ${k}`).toEqual(want);
      }
    }
    i18n.global.locale.value = 'en';
  });
});
