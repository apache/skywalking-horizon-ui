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
 * What a failure card is allowed to put on the screen.
 *
 * Testing the store's redaction is not enough on its own: the card is what an
 * operator screenshots into a ticket, so the proof has to be about the rendered
 * DOM. And a card describes text from outside the UI — a server's message, a
 * URL, a response body — which makes it the last place that should be able to
 * EXECUTE what it is describing.
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import ErrorRecordCard from './ErrorRecordCard.vue';
import type { UiErrorRecord } from './errorCenter';

const card = (over: Partial<UiErrorRecord> = {}, expanded = false) =>
  mount(ErrorRecordCard, {
    props: {
      record: {
        id: 'e1',
        occurredAt: Date.UTC(2026, 0, 1, 12, 0, 0),
        scope: 'refresh',
        owner: 'Service map',
        action: 'reading the service map',
        summary: 'upstream timed out',
        ...over,
      } as UiErrorRecord,
      expanded,
    },
    global: { plugins: [i18n] },
  });

describe('a card renders text, never markup', () => {
  it('escapes a summary that looks like a script', () => {
    const w = card({ summary: '<img src=x onerror="alert(1)">' });

    expect(w.html(), 'the summary reached the DOM as an element').not.toContain('<img');
    expect(w.text()).toContain('onerror');
  });

  it('escapes a response body that looks like markup', () => {
    const w = card({ responseBody: '<script>alert(1)</script>' }, true);

    expect(w.html()).not.toContain('<script>alert(1)</script>');
    expect(w.text()).toContain('alert(1)');
  });

  it('escapes a URL that looks like markup', () => {
    const w = card({ url: '/api/x?q=<b>hi</b>', method: 'GET' }, true);

    expect(w.html()).not.toContain('<b>hi</b>');
  });
});

describe('a card says what it knows and no more', () => {
  it('does not print "0" as a status when there was no response', () => {
    const w = card({ status: 0 });

    expect(w.text()).not.toMatch(/\b0\b/);
    expect(w.text().toLowerCase()).toContain('no response');
  });

  it('shows a real status', () => {
    expect(card({ status: 503 }).text()).toContain('503');
  });

  it('offers no details affordance when there are none to show', () => {
    expect(card().find('.err-more').exists()).toBe(false);
  });

  it('offers one as soon as there is something behind it', () => {
    expect(card({ url: '/api/x' }).find('.err-more').exists()).toBe(true);
  });

  it('keeps the detail closed until it is asked for', () => {
    const w = card({ responseBody: 'the body' });

    expect(w.text()).not.toContain('the body');
  });

  it('prefers OUR sentence over the server’s when we have one', () => {
    // A translatable key wins, because the server has no words for a case it
    // never reported — an OAP that could not be reached at all, say.
    const w = card({ summary: 'graph unavailable', summaryKey: 'The request failed.' });

    expect(w.text()).toContain('The request failed.');
    expect(w.text()).not.toContain('graph unavailable');
  });
});
