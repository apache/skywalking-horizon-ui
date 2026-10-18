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

/** What the page says of where a call's history changed: the card's line, and the earlier reply's fate. */

import type { Step } from '../model.js';
import { fill } from '../strings.js';
import type { ViewContext } from './context.js';

/** What a history.change card says beneath its title: what was kept, changed, dropped and added, and
 *  what else changed with them. */
export function historyLine(ctx: ViewContext, e: Step): string {
  const { s } = ctx;
  const a = e.attrs ?? {};
  // The counts are said only when the card has all four; a count it does not carry is not zero.
  const keys = ['kept', 'changed', 'dropped', 'added'] as const;
  const counts = keys.every((k) => typeof a[k] === 'number')
    ? [fill(s.historyCounts, Object.fromEntries(keys.map((k) => [k, String(a[k])])))]
    : [];
  return [...counts, ...historyNotes(ctx, a, 'reply')].join(' · ');
}

/** What else a comparison found, from a card's attributes or a call's: whether the order and the
 *  system prompt changed, and what became of the earlier call's reply, named by replyKey. */
export function historyNotes(ctx: ViewContext, a: Record<string, unknown>, replyKey: string): string[] {
  const { s } = ctx;
  const out: string[] = [];
  if (a['order_changed'] === 'yes') out.push(s.historyOrderChanged);
  if (a['order_changed'] === 'unavailable') out.push(s.historyOrderUnknown);
  if (a['system_changed'] === 'yes') out.push(s.historySystemChanged);
  if (a['system_changed'] === 'unavailable') out.push(s.historySystemUnknown);
  const reply = replyText(ctx, a[replyKey]);
  if (reply) out.push(reply);
  return out;
}

/** What became of the earlier call's reply, as a call or a card says it. */
export function replyText(ctx: ViewContext, status: unknown): string {
  const { s } = ctx;
  switch (status) {
    case 'back':
      return s.historyReplyBack;
    case 'back_changed':
      return s.historyReplyBackChanged;
    case 'not_found':
      return s.historyReplyNotFound;
    case 'unavailable':
      return s.historyReplyUnknown;
  }
  return '';
}
