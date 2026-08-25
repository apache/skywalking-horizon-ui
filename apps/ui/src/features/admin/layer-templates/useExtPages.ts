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
 * Extension pages in the layer-dashboard admin: which page is being
 * edited, and where its widgets are stored.
 *
 * A component's DEFAULT page is `dashboards.<scope>` — the grid every
 * layer has always had. Extension pages live in the sibling
 * `dashboardExtPages.<scope>` array. Both are edited by the same canvas,
 * which asks this module where to read and write rather than knowing the
 * difference.
 */

import { computed, type Ref } from 'vue';
import type { InstanceAttributePredicate } from '@skywalking-horizon-ui/api-client';
import type { AdminEntityFilter, AdminExtPage, AdminLayerTemplate } from '@/api/client';
import {
  isBuiltInLayerRow,
  MAX_EXT_PAGE_ID_LENGTH,
  MAX_EXT_PAGE_NAME_LENGTH,
} from '@skywalking-horizon-ui/api-client';
import type { DashboardWidget } from '@skywalking-horizon-ui/api-client';

/** The three components that can carry more than one page. */
export const PAGEABLE_SCOPES = ['service', 'instance', 'endpoint'] as const;
export type PageableScope = (typeof PAGEABLE_SCOPES)[number];

/** Publish rejects a 13th, so the UI stops offering to add one. */
export const MAX_EXT_PAGES = 12;

/** `null` selects the component's default page. */
export type PageSelection = string | null;

export function isPageableScope(scope: string): scope is PageableScope {
  return (PAGEABLE_SCOPES as readonly string[]).includes(scope);
}

/** Route segments a page id may not take, because a whole-path match
 *  elsewhere would read the page as that feature. Mirrors the publish
 *  rule; kept here so the editor refuses the name at the point the
 *  operator types it rather than at push. */
/**
 * Every page-id fault in a draft, as `<scope>.<id>: <reason>`.
 *
 * The publish schema refuses these, but only once the operator has
 * pressed push and read a server error — and a hand-imported template can
 * carry them from the moment it loads. Checking the whole draft at save
 * names them where they were authored.
 */
export function draftPageIdIssues(tpl: AdminLayerTemplate | null): string[] {
  const out: string[] = [];
  const byScope = tpl?.dashboardExtPages;
  if (!byScope) return out;
  for (const scope of ['service', 'instance', 'endpoint'] as const) {
    const pages = byScope[scope] ?? [];
    const seen: string[] = [];
    for (const p of pages) {
      const issue = extPageIdIssue(p.id, seen, isBuiltInLayerRow);
      if (issue) out.push(`${scope}.${p.id || '(empty)'}: ${issue}`);
      else if (p.id.length > MAX_EXT_PAGE_ID_LENGTH) out.push(`${scope}.${p.id}: too long`);
      else if (p.name.trim() === '') out.push(`${scope}.${p.id}: empty name`);
      else if (p.name.trim().length > MAX_EXT_PAGE_NAME_LENGTH) out.push(`${scope}.${p.id}: name too long`);
      seen.push(p.id);
    }
  }
  return out;
}

export function extPageIdIssue(id: string, taken: readonly string[], reserved: (v: string) => boolean): string | null {
  if (!id) return 'empty';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return 'format';
  if (reserved(id)) return 'reserved';
  if (taken.includes(id)) return 'duplicate';
  return null;
}

/**
 * Derive a route id from a display name — lowercase, hyphenated, and
 * numbered until it is free.
 *
 * `reserved` rejects ids that would impersonate a built-in tab. A display
 * name is NOT an id, so a page legitimately called "Topology" gets
 * `topology-2` rather than being refused: the operator named a page, they
 * did not ask for a route.
 */
export function suggestPageId(
  name: string,
  taken: readonly string[],
  reserved: (id: string) => boolean = () => false,
): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'page';
  const free = (id: string): boolean => !taken.includes(id) && !reserved(id);
  if (free(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (free(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function useExtPages(
  template: Ref<AdminLayerTemplate | null>,
  activeScope: Ref<string>,
  activePage: Ref<PageSelection>,
) {
  /** Pages declared for the active component, or none when it cannot
   *  carry them (topology, traces, logs, the profilings). */
  const pages = computed<AdminExtPage[]>(() => {
    const tpl = template.value;
    if (!tpl || !isPageableScope(activeScope.value)) return [];
    return tpl.dashboardExtPages?.[activeScope.value] ?? [];
  });

  /** The active scope's default-page filter, for the editor to read. */
  const defaultFilter = computed<AdminEntityFilter | null>(() => {
    const tpl = template.value;
    if (!tpl || !isPageableScope(activeScope.value)) return null;
    return (
      (tpl.dashboardDefaultFilters as Record<string, AdminEntityFilter | undefined> | undefined)?.[
        activeScope.value
      ] ?? null
    );
  });

  const canAddPage = computed<boolean>(
    () => isPageableScope(activeScope.value) && pages.value.length < MAX_EXT_PAGES,
  );

  /** Mutable handle on the pages array, created on demand. Returns null
   *  when the active scope cannot hold pages. */
  function pagesMut(): AdminExtPage[] | null {
    const tpl = template.value;
    if (!tpl || !isPageableScope(activeScope.value)) return null;
    const byScope = tpl.dashboardExtPages ?? {};
    const list = byScope[activeScope.value] ?? [];
    byScope[activeScope.value] = list;
    tpl.dashboardExtPages = byScope;
    return list;
  }

  function addPage(name: string, id: string): void {
    const tpl = template.value;
    const list = pagesMut();
    if (!tpl || !list || list.length >= MAX_EXT_PAGES) return;
    list.push({ id, name, widgets: [] });
    placeInMenuOrder(tpl, activeScope.value, id);
    activePage.value = id;
  }

  /**
   * Give a new page a place in a stored order, next to its component.
   *
   * Without this the row is simply absent from the order, and the runtime
   * appends unnamed rows — so a page created under a custom order would
   * appear at the BOTTOM of the sidebar, nowhere near the component it
   * belongs to. It is draggable from there like any other row.
   */
  function placeInMenuOrder(tpl: AdminLayerTemplate, scope: string, id: string): void {
    if (!tpl.menuOrder) return;
    const path = `${scope}/${id}`;
    if (tpl.menuOrder.includes(path)) return;
    // After the component's last existing page, else after the component.
    let at = -1;
    tpl.menuOrder.forEach((p, i) => {
      if (p === scope || p.startsWith(`${scope}/`)) at = i;
    });
    if (at < 0) tpl.menuOrder.push(path);
    else tpl.menuOrder.splice(at + 1, 0, path);
  }

  function renamePage(id: string, name: string): void {
    const p = pagesMut()?.find((x) => x.id === id);
    if (p) p.name = name;
  }

  /** What the page calls the entity it lists. Blank clears it, so the
   *  layer's own alias takes over again. */
  function setPageAlias(id: string, alias: string): void {
    const p = pagesMut()?.find((x) => x.id === id);
    if (!p) return;
    if (alias.trim() === '') delete p.alias;
    else p.alias = alias;
  }

  /** The default page's filter block for the active scope, created on
   *  first write and removed once it holds nothing — an empty object
   *  would show as a pending change against OAP forever. */
  function defaultFilterMut(): AdminEntityFilter | null {
    const tpl = template.value;
    if (!tpl) return null;
    const key = activeScope.value;
    if (!isPageableScope(key)) return null;
    tpl.dashboardDefaultFilters ??= {};
    const bag = tpl.dashboardDefaultFilters as Record<string, AdminEntityFilter | undefined>;
    bag[key] ??= {};
    return bag[key]!;
  }

  function pruneDefaultFilter(): void {
    const tpl = template.value;
    const bag = tpl?.dashboardDefaultFilters as Record<string, AdminEntityFilter | undefined> | undefined;
    const key = activeScope.value;
    if (!bag || !bag[key]) return;
    if (Object.keys(bag[key]!).length === 0) delete bag[key];
    if (tpl && Object.keys(bag).length === 0) delete tpl.dashboardDefaultFilters;
  }

  /** `id === null` addresses the component's DEFAULT page. */
  function setDefaultEntityFilter(scope: string, filter: string): void {
    const f = defaultFilterMut();
    if (!f) return;
    const blank = filter.trim() === '';
    if (scope === 'instance') {
      if (blank) delete f.instanceFilter;
      else f.instanceFilter = filter;
    } else if (blank) {
      delete f.serviceFilter;
    } else {
      f.serviceFilter = filter;
    }
    pruneDefaultFilter();
  }

  function setDefaultInstanceAttributes(attributes: InstanceAttributePredicate[]): void {
    const f = defaultFilterMut();
    if (!f) return;
    if (attributes.length === 0) delete f.instanceAttributes;
    else f.instanceAttributes = attributes;
    pruneDefaultFilter();
  }

  /** The name filter for whichever picker this scope's pages narrow. */
  function setEntityFilter(scope: string, id: string, filter: string): void {
    const p = pagesMut()?.find((x) => x.id === id);
    if (!p) return;
    // An empty box means "no filter", not a filter that matches nothing —
    // and storing `''` shows as a pending change against OAP forever.
    const blank = filter.trim() === '';
    if (scope === 'instance') {
      if (blank) delete p.instanceFilter;
      else p.instanceFilter = filter;
      return;
    }
    if (blank) delete p.serviceFilter;
    else p.serviceFilter = filter;
  }

  function setInstanceAttributes(id: string, attributes: InstanceAttributePredicate[]): void {
    const p = pagesMut()?.find((x) => x.id === id);
    if (!p) return;
    if (attributes.length === 0) delete p.instanceAttributes;
    else p.instanceAttributes = attributes;
  }

  /**
   * Delete a page and its widgets. Returns the deleted page for the
   * caller's confirmation text.
   *
   * Translations stored for it are deliberately LEFT: the merger ignores
   * an overlay entry the source cannot place, so nothing renders from
   * them, and a layer push that rewrote every locale's record would be
   * the most dangerous write in the admin. They are surfaced and removed
   * on the Translations page instead.
   */
  function deletePage(id: string): AdminExtPage | null {
    const tpl = template.value;
    const list = pagesMut();
    if (!tpl || !list) return null;
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return null;
    const [removed] = list.splice(i, 1);
    pruneMenuOrder(tpl, [`${activeScope.value}/${removed.id}`]);
    if (list.length === 0 && isPageableScope(activeScope.value)) {
      delete tpl.dashboardExtPages?.[activeScope.value];
      if (tpl.dashboardExtPages && Object.keys(tpl.dashboardExtPages).length === 0) {
        delete tpl.dashboardExtPages;
      }
    }
    if (activePage.value === id) activePage.value = null;
    return removed;
  }

  /**
   * Drop every page of a component — used when the component itself is
   * disabled, where dormant pages would be config nobody can reach and
   * nobody can see to delete.
   */
  function clearScopePages(scope: string): AdminExtPage[] {
    const tpl = template.value;
    if (!tpl?.dashboardExtPages || !isPageableScope(scope)) return [];
    const removed = tpl.dashboardExtPages[scope] ?? [];
    // The component's own row goes too — it is being switched off.
    pruneMenuOrder(tpl, [scope, ...removed.map((p) => `${scope}/${p.id}`)]);
    delete tpl.dashboardExtPages[scope];
    if (Object.keys(tpl.dashboardExtPages).length === 0) delete tpl.dashboardExtPages;
    if (activeScope.value === scope) activePage.value = null;
    return removed;
  }

  /** Drop rows that no longer exist from a stored order. The runtime
   *  skips a stale entry anyway, but leaving one behind means the saved
   *  order describes a menu that is not this one — and publish rejects it. */
  function pruneMenuOrder(tpl: AdminLayerTemplate, paths: readonly string[]): void {
    if (!tpl.menuOrder) return;
    const gone = new Set(paths);
    tpl.menuOrder = tpl.menuOrder.filter((p) => !gone.has(p));
  }

  /** Widgets of the page being edited. */
  function readWidgets(scope: string, page: PageSelection): DashboardWidget[] {
    const tpl = template.value;
    if (!tpl) return [];
    if (page && isPageableScope(scope)) {
      return tpl.dashboardExtPages?.[scope]?.find((p) => p.id === page)?.widgets ?? [];
    }
    // Read from `dashboards.<scope>`, falling back to legacy `widgets`
    // for the service scope so the existing JSONs keep their content
    // until we explicitly migrate them.
    const scoped = tpl.dashboards?.[scope];
    if (scoped) return scoped;
    if (scope === 'service' && tpl.widgets) return tpl.widgets;
    return [];
  }

  function writeWidgets(scope: string, page: PageSelection, widgets: DashboardWidget[]): void {
    const tpl = template.value;
    if (!tpl) return;
    if (page && isPageableScope(scope)) {
      const p = tpl.dashboardExtPages?.[scope]?.find((x) => x.id === page);
      if (p) p.widgets = widgets;
      return;
    }
    const dashboards = tpl.dashboards ?? {};
    dashboards[scope] = widgets;
    tpl.dashboards = dashboards;
    // Drop the legacy `widgets` once we've split — keeps the JSON clean.
    if (scope === 'service' && tpl.widgets) {
      (tpl as unknown as { widgets?: DashboardWidget[] }).widgets = undefined;
    }
  }

  /** Every widget list in the draft, so a new id can be minted against
   *  all of them. Extension pages are included: ids must not collide
   *  across a component's pages, and a widget moved between them must not
   *  meet one it left behind. */
  function allWidgetLists(): DashboardWidget[][] {
    const tpl = template.value;
    if (!tpl) return [];
    const out: DashboardWidget[][] = [];
    if (tpl.dashboards) out.push(...Object.values(tpl.dashboards));
    if (tpl.widgets) out.push(tpl.widgets);
    for (const scope of PAGEABLE_SCOPES) {
      for (const p of tpl.dashboardExtPages?.[scope] ?? []) out.push(p.widgets);
    }
    return out;
  }

  return {
    pages,
    canAddPage,
    addPage,
    renamePage,
    setPageAlias,
    setEntityFilter,
    setInstanceAttributes,
    setDefaultEntityFilter,
    setDefaultInstanceAttributes,
    defaultFilter,
    deletePage,
    clearScopePages,
    readWidgets,
    writeWidgets,
    allWidgetLists,
  };
}
