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
 * State and actions of the Alarm pages admin: which page is open, the
 * operator's unsaved edits (kept per page, so switching pages loses nothing),
 * and the direct save / delete against OAP's template store.
 *
 * The default page is read the way every reader reads it — the effective
 * `alert` setting — and the named pages from the stored rows, because they
 * have no effective form of their own for an admin who may not reach them.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ALERT_DEFAULT_PAGE_ID } from '@skywalking-horizon-ui/api-client';
import { bff, BffApiError, type AlarmsConfig } from '@/api/client';
import type { TemplateSyncStatus } from '@/api/scopes/template-sync';
import { refreshConfigBundle } from '@/controls/configBundle';
import { ALARM_PAGES_QUERY_KEY } from '@/shell/useAlarmPages';
import { pushErrorLines } from '@/features/admin/_shared/pushError';
import {
  alertRowName,
  defaultContent,
  draftFromDefault,
  draftFromNamed,
  draftProblems,
  draftsEqual,
  hasProblems,
  namedContent,
  namedPagesFromRows,
  sameContent,
  storedPageContent,
  takenPageIds,
  type DraftProblems,
  type NamedAlertPage,
  type NamedPageContent,
  type PageDraft,
} from './alertPages';

export const ALERT_ROWS_QUERY_KEY = ['admin/alert-pages/rows'] as const;
const ALARMS_CONFIG_QUERY_KEY = ['alarms/config'] as const;

export interface EditorFlash {
  text: string;
  kind: 'ok' | 'err';
}

export function useAlertPageEditor(readOnly: Ref<boolean>) {
  const { t } = useI18n({ useScope: 'global' });
  const queryClient = useQueryClient();

  const configQ = useQuery({
    queryKey: ALARMS_CONFIG_QUERY_KEY,
    queryFn: (): Promise<AlarmsConfig> => bff.alarms.config(),
    staleTime: Infinity,
  });
  const rowsQ = useQuery({
    queryKey: ALERT_ROWS_QUERY_KEY,
    queryFn: (): Promise<TemplateSyncStatus> => bff.templateSync.syncStatus(true),
    staleTime: 30_000,
  });

  const named = computed<NamedAlertPage[]>(() => namedPagesFromRows(rowsQ.data.value?.rows ?? []));
  /** A page named in the modal and not saved yet: it needs a pin first.
   *  `sent` is what a save that timed out wrote for it, which OAP may show
   *  later. */
  const pending = ref<{ id: string; title: string; sent?: NamedPageContent } | null>(null);
  const taken = computed<Set<string>>(() => {
    const ids = takenPageIds(rowsQ.data.value?.rows ?? []);
    if (pending.value) ids.add(pending.value.id);
    return ids;
  });

  const selectedId = ref<string>(ALERT_DEFAULT_PAGE_ID);
  // A Map, not an object: a page id such as `constructor` must not find a prototype member.
  const edits = ref(new Map<string, PageDraft>());

  const isDefault = computed<boolean>(() => selectedId.value === ALERT_DEFAULT_PAGE_ID);
  const isPending = computed<boolean>(() => pending.value?.id === selectedId.value);

  function savedDraft(id: string): PageDraft | null {
    if (id === ALERT_DEFAULT_PAGE_ID) return configQ.data.value ? draftFromDefault(configQ.data.value) : null;
    if (pending.value?.id === id) {
      return draftFromNamed({ title: pending.value.title, order: null, pinnedLayers: [], defaultWindowMs: null });
    }
    const page = named.value.find((p) => p.id === id);
    return page ? draftFromNamed(page) : null;
  }

  const draft = computed<PageDraft | null>(() => edits.value.get(selectedId.value) ?? savedDraft(selectedId.value));
  const problems = computed<DraftProblems>(() => (draft.value ? draftProblems(draft.value, isDefault.value) : {}));

  function dropEdits(id: string): void {
    const next = new Map(edits.value);
    next.delete(id);
    edits.value = next;
  }

  function isDirty(id: string): boolean {
    const edit = edits.value.get(id);
    if (!edit) return false;
    const saved = savedDraft(id);
    return !saved || !draftsEqual(edit, saved);
  }

  const selectedNamed = computed<NamedAlertPage | null>(
    () => named.value.find((p) => p.id === selectedId.value) ?? null,
  );
  const saving = ref(false);
  const deleting = ref(false);
  const resetting = ref(false);
  /** A write is in flight: the form holds still until it lands, so nothing
   *  typed meanwhile is dropped with the edits it settles. */
  const busy = computed<boolean>(() => saving.value || deleting.value || resetting.value);

  const canSave = computed<boolean>(
    () =>
      !readOnly.value &&
      !busy.value &&
      draft.value !== null &&
      !hasProblems(problems.value) &&
      (isPending.value ||
        isDirty(selectedId.value) ||
        selectedNamed.value?.mismatched === true ||
        selectedNamed.value?.needsRewrite === true),
  );

  // A named page deleted elsewhere drops out of the rows; fall back to the
  // default page rather than leave an editor over nothing.
  watch(named, (list) => {
    const p = pending.value;
    // The new page a timed-out save wrote has shown up: it is stored now.
    if (p?.sent && list.some((x) => x.id === p.id)) pending.value = null;
    if (isDefault.value || isPending.value || !rowsQ.data.value) return;
    if (!list.some((p) => p.id === selectedId.value)) selectedId.value = ALERT_DEFAULT_PAGE_ID;
  });

  function select(id: string): void {
    selectedId.value = id;
  }

  function update(patch: Partial<PageDraft>): void {
    if (readOnly.value || busy.value || !draft.value) return;
    edits.value = new Map(edits.value).set(selectedId.value, { ...draft.value, ...patch });
  }

  function create(page: { id: string; title: string }): void {
    if (readOnly.value) return;
    if (pending.value) dropEdits(pending.value.id);
    pending.value = page;
    dropEdits(page.id);
    selectedId.value = page.id;
  }

  // Shallow: the timeout below knows its note by identity, which a deep ref's proxy would not keep.
  const flash = shallowRef<EditorFlash | null>(null);
  function setFlash(text: string, kind: EditorFlash['kind'] = 'ok'): void {
    const entry = { text, kind };
    flash.value = entry;
    setTimeout(() => {
      if (flash.value === entry) flash.value = null;
    }, 4000);
  }

  function reset(): void {
    if (readOnly.value || busy.value) return;
    dropEdits(selectedId.value);
  }

  function discardPending(): void {
    if (!pending.value || busy.value) return;
    dropEdits(pending.value.id);
    pending.value = null;
    selectedId.value = ALERT_DEFAULT_PAGE_ID;
  }

  /** After a write: every reader of the pages follows it — the sidebar and the
   *  Alarms page (`alarms/pages`), the badge and overview widget
   *  (`alarms/config`), and this page's own sync badges (the bundle). */
  async function afterWrite(): Promise<void> {
    try {
      queryClient.setQueryData(ALERT_ROWS_QUERY_KEY, await bff.templateSync.resync());
    } catch {
      await rowsQ.refetch();
    }
    await refreshConfigBundle({ force: true });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ALARMS_CONFIG_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ALARM_PAGES_QUERY_KEY }),
    ]);
  }

  const WINDOW_LABELS = computed<Record<number, string>>(() => ({
    [20 * 60_000]: t('20 minutes'),
    [2 * 60 * 60_000]: t('2 hours'),
    [4 * 60 * 60_000]: t('4 hours'),
  }));

  function contentOf(id: string, d: PageDraft): unknown {
    return id === ALERT_DEFAULT_PAGE_ID ? defaultContent(d) : namedContent(id, d);
  }

  async function save(): Promise<void> {
    const id = selectedId.value;
    const d = draft.value;
    if (!canSave.value || !d) return;
    const defaultPage = id === ALERT_DEFAULT_PAGE_ID;
    const wasPending = pending.value?.id === id;
    saving.value = true;
    try {
      // A save under a name OAP already holds updates that row, so a page
      // someone else created since the modal checked would be overwritten.
      // The one exception is this very page, created by a save that timed
      // out before OAP showed it: it reads back as what that save sent, or
      // as what is saved now.
      if (wasPending) {
        const fresh = await bff.templateSync.syncStatus(true);
        const stored = storedPageContent(fresh.rows, id);
        const sent = pending.value?.sent;
        const ours = sameContent(stored, namedContent(id, d)) || (sent !== undefined && sameContent(stored, sent));
        if (takenPageIds(fresh.rows).has(id) && !ours) {
          setFlash(t('An alarm page with the id “{id}” is already stored on OAP. A deleted page keeps its id, so pick another.', { id }), 'err');
          return;
        }
      }
      await bff.templateSync.save(alertRowName(id), contentOf(id, d));
      // Edits go only once the fresh rows are in, so the editor never shows
      // the pre-save values in between.
      await afterWrite();
      if (wasPending) pending.value = null;
      dropEdits(id);
      if (!defaultPage && !named.value.some((p) => p.id === id)) selectedId.value = ALERT_DEFAULT_PAGE_ID;
      setFlash(
        defaultPage
          ? t('saved · {pinned} pinned · {window} · limit {limit}', {
              pinned: d.pinnedLayers.length,
              window: WINDOW_LABELS.value[d.windowMs ?? 0] ?? '—',
              limit: Number(d.limitText.trim()),
            })
          : t('saved · {title} · {pinned} pinned', { title: d.title.trim(), pinned: d.pinnedLayers.length }),
      );
    } catch (err) {
      if (err instanceof BffApiError && err.status === 504) {
        // The BFF stopped waiting for OAP to show the write, which may have
        // landed all the same. Read again, and settle what did: a new page
        // that is stored now is no longer pending, and edits the stored page
        // already holds go.
        await afterWrite();
        if (wasPending && named.value.some((p) => p.id === id)) pending.value = null;
        else if (wasPending && pending.value?.id === id) pending.value = { ...pending.value, sent: namedContent(id, d) };
        const saved = pending.value?.id === id ? null : savedDraft(id);
        const landed = saved !== null && sameContent(contentOf(id, saved), contentOf(id, d));
        if (landed) dropEdits(id);
        setFlash(t('Refetched after timeout — the push may have completed; please verify.'), landed ? 'ok' : 'err');
      } else {
        setFlash(t('error: {msg}', { msg: pushErrorLines(err).join('; ') }), 'err');
      }
    } finally {
      saving.value = false;
    }
  }

  async function remove(id: string): Promise<boolean> {
    if (readOnly.value || busy.value || id === ALERT_DEFAULT_PAGE_ID || pending.value?.id === id) return false;
    const title = named.value.find((p) => p.id === id)?.title || id;
    deleting.value = true;
    try {
      await bff.templateSync.disable(alertRowName(id));
      dropEdits(id);
      if (selectedId.value === id) selectedId.value = ALERT_DEFAULT_PAGE_ID;
      await afterWrite();
      setFlash(t('deleted · {title}', { title }));
      return true;
    } catch (err) {
      setFlash(t('error: {msg}', { msg: pushErrorLines(err).join('; ') }), 'err');
      return false;
    } finally {
      deleting.value = false;
    }
  }

  /** The default page was reset to the bundled one (the diff modal wrote it):
   *  every reader follows, as after a save, and its edits here go. */
  async function afterReset(): Promise<void> {
    resetting.value = true;
    try {
      await afterWrite();
      dropEdits(ALERT_DEFAULT_PAGE_ID);
    } finally {
      resetting.value = false;
    }
  }

  return {
    configQ,
    rowsQ,
    named,
    pending,
    taken,
    selectedId,
    selectedNamed,
    isDefault,
    isPending,
    draft,
    problems,
    canSave,
    isDirty,
    select,
    update,
    create,
    reset,
    discardPending,
    save,
    saving,
    remove,
    deleting,
    busy,
    afterReset,
    flash,
    setFlash,
  };
}
