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
 * Two questions, and both are answered wrong by the obvious implementation:
 * WHERE a failure goes, and WHAT of it may be shown.
 *
 * Routing is not cosmetic. A background failure shown as a toast trains people
 * to dismiss without reading, and an operator's own failed click hidden in a
 * panel they never open reads as the click doing nothing.
 *
 * Redaction is tested rather than assumed because the failure mode is silent:
 * a token in a query string renders perfectly, and nobody notices until the
 * screenshot is already in a ticket.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import {
  REFRESH_HISTORY,
  describeFailure,
  redactBody,
  redactUrl,
  useErrorCenterStore,
  useRefreshErrorReport,
  reportActionFailure,
} from './errorCenter';
import { useAutoRefreshStore } from './autoRefresh';

beforeEach(() => setActivePinia(createPinia()));

const record = (scope: 'refresh' | 'component', summary = 'boom') => ({
  scope,
  owner: 'Service map',
  action: 'reading the service map',
  summary,
});

describe('where a failure goes', () => {
  it('sends a refresh failure to the history, never to a toast', () => {
    const c = useErrorCenterStore();
    c.record(record('refresh'));

    expect(c.refreshHistory).toHaveLength(1);
    expect(c.toasts, 'a background failure interrupted the operator').toHaveLength(0);
  });

  it('sends an operator’s failure to a toast, never to the history', () => {
    const c = useErrorCenterStore();
    c.record(record('component'));

    expect(c.toasts).toHaveLength(1);
    expect(c.refreshHistory, 'a click’s outcome was buried in a panel').toHaveLength(0);
  });

  it('keeps only the newest five refresh failures', () => {
    const c = useErrorCenterStore();
    for (let i = 0; i < REFRESH_HISTORY + 3; i += 1) c.record(record('refresh', `boom ${i}`));

    expect(c.refreshHistory).toHaveLength(REFRESH_HISTORY);
    expect(c.refreshHistory[0]?.summary, 'the list is oldest-first').toBe('boom 7');
  });

  it('caps the unread count at what the list can actually show', () => {
    const c = useErrorCenterStore();
    for (let i = 0; i < 20; i += 1) c.record(record('refresh'));

    expect(c.unreadCount).toBe(REFRESH_HISTORY);
  });

  it('clears the badge on read but KEEPS the records', () => {
    const c = useErrorCenterStore();
    c.record(record('refresh'));

    c.markRead();

    expect(c.hasUnread).toBe(false);
    expect(c.refreshHistory, 'reading the panel destroyed what it was showing').toHaveLength(1);
  });
});

describe('what may be shown', () => {
  it('removes secret query values and keeps their names', () => {
    const out = redactUrl('/api/layer/general/topology?token=abc123&depth=2');

    expect(out).not.toContain('abc123');
    expect(out, 'the parameter’s NAME is useful and was dropped with its value').toContain('token');
    expect(out).toContain('depth=2');
  });

  it('redacts every spelling a secret arrives under', () => {
    for (const key of ['password', 'authorization', 'api_key', 'accessToken', 'client_secret']) {
      expect(redactUrl(`/x?${key}=s3cr3t`), key).not.toContain('s3cr3t');
    }
  });

  it('redacts a secret nested deep in a body, not just at the top', () => {
    const out = redactBody({ data: { user: { name: 'ann', password: 'hunter2' } } });

    expect(out).not.toContain('hunter2');
    expect(out, 'redaction took the surrounding data with it').toContain('ann');
  });

  it('redacts a JSON body that arrived as a string', () => {
    expect(redactBody('{"token":"abc123"}')).not.toContain('abc123');
  });

  it('shows a non-JSON string body as it is', () => {
    expect(redactBody('upstream timed out')).toBe('upstream timed out');
  });

  it('caps a body rather than pasting a megabyte into the panel', () => {
    const out = redactBody('x'.repeat(50_000));

    expect(out.length).toBeLessThan(2200);
    expect(out, 'truncation was silent — the reader would think that was all of it').toContain(
      'truncated',
    );
  });

  it('does not recurse for ever on a self-referential body', () => {
    const loop: Record<string, unknown> = { name: 'a' };
    loop.self = loop;

    expect(() => redactBody(loop)).not.toThrow();
  });
});

describe('describing a failure', () => {
  it('never renders an unknown throw as "[object Object]"', () => {
    const out = describeFailure({ weird: true }, 'Service map', 'reading', 'refresh');

    expect(out.summary).not.toContain('object Object');
    expect(out.summaryKey, 'our own sentence must be translatable').toBeTruthy();
  });

  it('keeps a plain error’s own words', () => {
    const out = describeFailure(new Error('upstream timed out'), 'X', 'y', 'component');

    expect(out.summary).toBe('upstream timed out');
    expect(out.summaryKey, 'the server’s words were replaced by ours').toBeUndefined();
  });
});

describe('the toast queue', () => {
  it('dismisses one without touching the others', () => {
    const c = useErrorCenterStore();
    c.record(record('component', 'first'));
    c.record(record('component', 'second'));

    c.dismissToast(c.toasts[0]!.id);

    expect(c.toasts).toHaveLength(1);
    expect(c.toasts[0]?.summary).toBe('second');
  });

  it('clears everything on reset — one session’s failures are not another’s', () => {
    const c = useErrorCenterStore();
    c.record(record('component'));
    c.record(record('refresh'));

    c.reset();

    expect(c.toasts).toHaveLength(0);
    expect(c.refreshHistory).toHaveLength(0);
    expect(c.unreadCount).toBe(0);
  });
});

describe('a record is a snapshot, not a live view', () => {
  it('does not change when the error it was made from does', () => {
    const c = useErrorCenterStore();
    const err = ref(new Error('first'));
    c.record(describeFailure(err.value, 'X', 'y', 'refresh'));

    err.value = new Error('second');

    expect(c.refreshHistory[0]?.summary).toBe('first');
  });
});

describe('attributing a failure to the round that caused it', () => {
  const failing = () => {
    const err = ref<Error | null>(null);
    useRefreshErrorReport({ owner: 'Service map', action: 'reading the service map', error: err });
    return err;
  };

  it('records a failure that surfaces while a round is out', async () => {
    const c = useErrorCenterStore();
    const auto = useAutoRefreshStore();
    const err = failing();
    // Fails the way a query does: its error state settles INSIDE the round.
    auto.joinRound(() => { err.value = new Error('upstream timed out'); });

    await auto.refreshNow();

    expect(c.refreshHistory).toHaveLength(1);
    expect(c.refreshHistory[0]?.trigger, 'the round’s trigger was not carried').toBe('manual');
    expect(c.refreshHistory[0]?.roundId).toBeGreaterThan(0);
  });

  // A first load that fails already SAYS SO where the graph would have been.
  // Repeating it in a panel the operator has to open is the same news twice.
  it('ignores a failure outside any round', () => {
    const c = useErrorCenterStore();
    const err = failing();

    err.value = new Error('upstream timed out');

    expect(c.refreshHistory).toHaveLength(0);
  });

  it('does not repeat one sentence for every cycle of the same outage', async () => {
    const c = useErrorCenterStore();
    const auto = useAutoRefreshStore();
    const err = failing();
    auto.joinRound(() => { err.value = new Error('upstream timed out'); });

    // A second failing cycle: a NEW error object carrying the same sentence,
    // which is what a query produces when the backend is simply still down.
    // It never passes through null, so this is not a recovery.
    await auto.refreshNow();

    expect(c.refreshHistory, 'an outage papered the history with one repeated line').toHaveLength(1);
  });

  it('reports again once it recovered and failed anew', async () => {
    const c = useErrorCenterStore();
    const auto = useAutoRefreshStore();
    const err = failing();
    let attempt = 0;
    auto.joinRound(() => {
      attempt += 1;
      // Fail, recover, then fail with the SAME words — which is news again.
      err.value = attempt === 2 ? null : new Error('upstream timed out');
    });

    await auto.refreshNow();
    await auto.refreshNow();
    await auto.refreshNow();

    expect(c.refreshHistory).toHaveLength(2);
  });
});

describe('an operator who asked gets an answer, once', () => {
  const failing = () => {
    const err = ref<Error | null>(null);
    useRefreshErrorReport({ owner: 'Service map', action: 'reading the service map', error: err });
    return err;
  };

  // The contradiction this removes: clicking Refresh against a dead backend
  // filed the failure in a background history and showed nothing, even though
  // the operator had just pressed the button and was watching.
  it('says so on screen when the round was manual, and still records it', async () => {
    const c = useErrorCenterStore();
    const auto = useAutoRefreshStore();
    const err = failing();
    auto.joinRound(() => { err.value = new Error('upstream timed out'); });

    await auto.refreshNow();

    expect(c.refreshHistory, 'the failure left no record').toHaveLength(1);
    expect(c.toasts, 'the operator pressed Refresh and was shown nothing').toHaveLength(1);
  });

  it('says it ONCE, however many screens failed', async () => {
    const c = useErrorCenterStore();
    const auto = useAutoRefreshStore();
    const a = ref<Error | null>(null);
    const b = ref<Error | null>(null);
    useRefreshErrorReport({ owner: 'Service map', action: 'reading the service map', error: a });
    useRefreshErrorReport({ owner: 'Deployment', action: 'reading the deployment graph', error: b });
    auto.joinRound(() => {
      a.value = new Error('upstream timed out');
      b.value = new Error('upstream timed out');
    });

    await auto.refreshNow();

    expect(c.refreshHistory, 'each screen should have its own entry').toHaveLength(2);
    expect(c.toasts, 'an outage buried the screen in toasts saying the same thing').toHaveLength(1);
  });

  it('stays silent for a round the TIMER ran', async () => {
    const c = useErrorCenterStore();
    const auto = useAutoRefreshStore();
    const err = failing();
    auto.joinRound(() => { err.value = new Error('upstream timed out'); });

    // A trailing 'auto' round is what the timer produces.
    await auto.refreshNow('auto');

    expect(c.refreshHistory).toHaveLength(1);
    expect(c.toasts, 'a background round interrupted the operator').toHaveLength(0);
  });
});

describe('one event, one record', () => {
  // Two screens sharing a query both see the same transport failure; the
  // history showed one outage as several.
  it('records a repeated report from a second observer only once', async () => {
    const c = useErrorCenterStore();
    const auto = useAutoRefreshStore();
    const a = ref<Error | null>(null);
    const b = ref<Error | null>(null);
    // Same owner and action — the same query, watched twice.
    useRefreshErrorReport({ owner: 'Layer landing', action: 'reading the layer landing metrics', error: a });
    useRefreshErrorReport({ owner: 'Layer landing', action: 'reading the layer landing metrics', error: b });
    auto.joinRound(() => {
      a.value = new Error('upstream timed out');
      b.value = new Error('upstream timed out');
    });

    await auto.refreshNow();

    expect(c.refreshHistory, 'one outage was listed twice').toHaveLength(1);
  });
});

describe('a cancellation is not a failure', () => {
  it('is never recorded — we stopped it', () => {
    const c = useErrorCenterStore();
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';

    reportActionFailure(aborted, 'Endpoint dependency', 'expanding an endpoint');

    expect(c.toasts, 'the app’s own decision was reported as an outage').toHaveLength(0);
  });
});

describe('a manual retry during the same outage', () => {
  // The suppression exists for the TIMER — an outage fails identically every
  // cycle. Applied to the operator's own retry it reproduced the silence the
  // toast was added to remove.
  it('still answers on screen, and does not duplicate the record', async () => {
    const c = useErrorCenterStore();
    const auto = useAutoRefreshStore();
    const err = ref<Error | null>(null);
    useRefreshErrorReport({ owner: 'Service map', action: 'reading the service map', error: err });
    auto.joinRound(() => { err.value = new Error('upstream timed out'); });

    // The timer sees it first: recorded, no toast.
    await auto.refreshNow('auto');
    expect(c.refreshHistory).toHaveLength(1);
    expect(c.toasts).toHaveLength(0);

    // The operator retries against the same dead backend.
    err.value = new Error('upstream timed out');
    await auto.refreshNow('manual');

    expect(c.toasts, 'the operator pressed Refresh again and was shown nothing').toHaveLength(1);
    expect(c.refreshHistory, 'the same outage was listed twice').toHaveLength(1);
  });
});
