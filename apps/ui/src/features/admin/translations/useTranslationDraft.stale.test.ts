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
 * What the editor makes of a stored overlay the template has outgrown.
 *
 * The page turns this into a gate — leftovers make the language read-only
 * until they are removed — so what the composable reports decides whether
 * an operator can work at all.
 *
 * Leftovers come in two shapes and the gate has to catch both, for
 * opposite reasons. A key the source lost entirely survives
 * canonicalization, so `dirty` goes TRUE and an ordinary push is offered
 * that would take the leftovers with it. An entry inside an array the
 * source still has is canonicalized away, so `dirty` stays FALSE and the
 * ordinary push is disabled — leaving the cleanup, which bypasses
 * `dirty`, as the only way to remove it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, computed } from 'vue';

vi.mock('@/shell/useAdminFeatures', () => ({
  useAdminFeatures: () => ({ templatesMode: ref('live') }),
}));

import { useTranslationDraft, type EffectiveSource } from './useTranslationDraft';
import { useLocalTranslationEdits } from '@/controls/localTranslationEdits';

const NAME = 'horizon.layer.CUSTOM_MQ';
const LOC = 'zh-CN';

const w = (id: string, title: string) => ({ id, type: 'line', title, expressions: ['x'] });

/** A layer with one default-grid widget and one extension page. */
const withPage = (): EffectiveSource => ({
  source: {
    key: 'CUSTOM_MQ',
    alias: 'Custom MQ',
    dashboards: { service: [w('svc-a', 'Throughput')] },
    dashboardExtPages: {
      service: [{ id: 'agents', name: 'Agents', widgets: [w('ag-a', 'Agent count')] }],
    },
  },
});

/** The same layer after the operator deleted the page and pushed. */
const withoutPage = (): EffectiveSource => ({
  source: {
    key: 'CUSTOM_MQ',
    alias: 'Custom MQ',
    dashboards: { service: [w('svc-a', 'Throughput')] },
  },
});

const JA = 'ja';

function harness(eff: EffectiveSource) {
  const selectedKind = ref<'overview' | 'layer'>('layer');
  const selectedName = ref(NAME);
  const source = ref(eff);
  const draft = useTranslationDraft({
    selectedKind,
    selectedName,
    effective: computed(() => source.value),
    readOnly: computed(() => false),
  });
  draft.target.value = LOC;
  /** Seed the fetched OAP snapshot the way a BFF read would. */
  const store = (oap: unknown, loc: string = LOC) => {
    draft.fetchedOverlays.value = {
      ...draft.fetchedOverlays.value,
      [draft.overlayKey(NAME, loc)]: { disk: null, oap },
    };
  };
  return { draft, source, store };
}

beforeEach(() => {
  // The local-edit store is module state shared across tests; a draft
  // staged by one would seed the next one's editor.
  useLocalTranslationEdits().remove(NAME);
});

describe('leftovers in a stored overlay', () => {
  it('are none while the template still declares the page', () => {
    const { draft, store } = harness(withPage());
    store({
      dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] },
    });
    expect(draft.staleOverlayForTarget.value).toEqual([]);
  });

  it('appear the moment the page is gone from the source', () => {
    const { draft, store, source } = harness(withPage());
    store({ dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] } });
    source.value = withoutPage();
    // The whole key, because the source lost it entirely.
    expect(draft.staleOverlayForTarget.value).toEqual(['dashboardExtPages']);
  });

  it('survive canonicalization when the source lost the key entirely', () => {
    // Canonicalizing copies an unknown key through verbatim, so the
    // canonical row still carries the leftover — and the draft does not.
    // The two therefore differ, `dirty` goes true, and an ordinary push
    // would have been offered and would have dropped them silently. That
    // is the case the gate exists for.
    const { draft, store } = harness(withoutPage());
    store({ dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] } });
    expect(draft.staleOverlayForTarget.value).toEqual(['dashboardExtPages']);
    expect(draft.oapOverlayForTarget.value).toHaveProperty('dashboardExtPages');
    expect(draft.dirty.value).toBe(true);
  });

  it('are dropped by canonicalization when they sit inside a live array', () => {
    // The opposite shape, and it needs the gate for the opposite reason:
    // canonicalizing removes the entry, so the canonical row and the
    // draft agree, `dirty` stays false, and "Check diff & push" is
    // disabled. Without a cleanup that bypasses `dirty` there would be no
    // way to remove this leftover at all.
    const { draft, store } = harness(withPage());
    store({
      dashboardExtPages: {
        service: [
          { id: 'agents', name: '探针' },
          { id: 'deleted', name: '已删除' },
        ],
      },
    });
    draft.rebuildDraftForLocale(NAME, LOC, 'remote');
    expect(draft.staleOverlayForTarget.value).toEqual(['dashboardExtPages.service[1]']);
    expect(draft.dirty.value).toBe(false);
  });

  it('do not count a widget the template still has', () => {
    const { draft, store } = harness(withoutPage());
    store({ dashboards: { service: [{ id: 'svc-a', title: '吞吐量' }] } });
    expect(draft.staleOverlayForTarget.value).toEqual([]);
  });
});

describe('what the cleanup publishes', () => {
  it('keeps the translations the template can still place', async () => {
    const { draft, store, source } = harness(withPage());
    store({
      dashboards: { service: [{ id: 'svc-a', title: '吞吐量' }] },
      dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] },
    });
    // Seeding maps the stored row onto the CURRENT source's field paths,
    // which is what drops the leftovers before anything is written.
    draft.rebuildDraftForLocale(NAME, LOC, 'remote');
    source.value = withoutPage();
    const next = draft.buildOverlayContent(NAME, LOC, withoutPage());
    expect(next).toEqual({ dashboards: { service: [{ id: 'svc-a', title: '吞吐量' }] } });
    expect(next).not.toHaveProperty('dashboardExtPages');
  });

  it('is a DELETE when every stored entry was a leftover', () => {
    // A row whose only content is text for things that no longer exist
    // translates nothing. Rebuilding it yields no overlay at all, and the
    // push path reads that as "remove the row" rather than writing an
    // empty one — which is the correct end state, not a missed case.
    const { draft, store, source } = harness(withPage());
    store({ dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] } });
    draft.rebuildDraftForLocale(NAME, LOC, 'remote');
    source.value = withoutPage();
    expect(draft.buildOverlayContent(NAME, LOC, withoutPage())).toBeNull();
  });

  it('leaves nothing stale behind', () => {
    const { draft, store, source } = harness(withPage());
    store({
      dashboards: { service: [{ id: 'svc-a', title: '吞吐量' }] },
      dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] },
    });
    draft.rebuildDraftForLocale(NAME, LOC, 'remote');
    source.value = withoutPage();
    const next = draft.buildOverlayContent(NAME, LOC, withoutPage());
    // Feed the result back as though it were the newly stored row: the
    // gate must not fire again, or the operator can never get out of it.
    store(next);
    expect(draft.staleOverlayForTarget.value).toEqual([]);
  });
});

/**
 * A template edit strands text in EVERY language that had translated what
 * it removed, so the cleanup offers to sweep them. Acting on a language
 * the operator has not selected is the part that can go wrong quietly:
 * its draft is only seeded when its overlay is fetched, and rebuilding an
 * unseeded draft yields nothing — which the push path reads as "remove the
 * row", deleting good translations instead of cleaning them.
 */
describe('sweeping other languages', () => {
  it('reports leftovers per language, not just for the selected one', () => {
    const { draft, store, source } = harness(withPage());
    store({ dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] } }, LOC);
    store({ dashboardExtPages: { service: [{ id: 'agents', name: 'エージェント' }] } }, JA);
    source.value = withoutPage();
    expect(draft.staleForLocale(LOC)).toEqual(['dashboardExtPages']);
    expect(draft.staleForLocale(JA)).toEqual(['dashboardExtPages']);
    // The selected language is just one of them.
    expect(draft.staleOverlayForTarget.value).toEqual(draft.staleForLocale(LOC));
  });

  it('says nothing about a language whose overlay was never fetched', () => {
    // Not "clean" — unknown. The scan fetches every language before
    // reporting, because an unfetched one would otherwise be omitted from
    // the sweep and left carrying its leftovers.
    const { draft, source } = harness(withPage());
    source.value = withoutPage();
    expect(draft.staleForLocale(JA)).toEqual([]);
  });

  it('rebuilds each language from ITS OWN translations', () => {
    const { draft, store, source } = harness(withPage());
    store({
      dashboards: { service: [{ id: 'svc-a', title: '吞吐量' }] },
      dashboardExtPages: { service: [{ id: 'agents', name: '探针' }] },
    }, LOC);
    store({
      dashboards: { service: [{ id: 'svc-a', title: 'スループット' }] },
      dashboardExtPages: { service: [{ id: 'agents', name: 'エージェント' }] },
    }, JA);
    draft.rebuildDraftForLocale(NAME, LOC, 'remote');
    draft.rebuildDraftForLocale(NAME, JA, 'remote');
    source.value = withoutPage();

    expect(draft.overlayForLocale(LOC)).toEqual({
      dashboards: { service: [{ id: 'svc-a', title: '吞吐量' }] },
    });
    expect(draft.overlayForLocale(JA)).toEqual({
      dashboards: { service: [{ id: 'svc-a', title: 'スループット' }] },
    });
  });

  it('would DELETE a language whose draft was never seeded', () => {
    // The failure mode the scan exists to prevent, pinned so a later
    // change that sweeps without fetching first fails here rather than in
    // production: an unseeded draft rebuilds to nothing, and nothing means
    // "remove the row" — including its still-valid translations.
    const { draft, store, source } = harness(withPage());
    store({ dashboards: { service: [{ id: 'svc-a', title: 'スループット' }] } }, JA);
    source.value = withoutPage();
    expect(draft.overlayForLocale(JA)).toBeNull();
    // Seeded first, the same language keeps its translation.
    draft.rebuildDraftForLocale(NAME, JA, 'remote');
    expect(draft.overlayForLocale(JA)).toEqual({
      dashboards: { service: [{ id: 'svc-a', title: 'スループット' }] },
    });
  });
});
