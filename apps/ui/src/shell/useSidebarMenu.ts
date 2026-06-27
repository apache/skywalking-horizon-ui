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

import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { IconName } from '@/components/icons/Icon.vue';
import { useAuthStore } from '@/state/auth';
import { useConfigBundle } from '@/controls/configBundle';

export interface NavRow {
  icon: IconName;
  label: string;
  to: string;
  badge?: { text: string; kind?: 'ok' | 'warn' | 'err' | 'info' };
  /** Custom active-match; defaults to exact `path === to`. */
  activeWhen?: (path: string) => boolean;
  /** Present ⇒ row renders as an L1 expandable with these as L2. */
  children?: NavRow[];
  /** Optional verb gate — row is removed from the DOM when the user
   *  lacks it. UI-only filter; the BFF enforces the same verbs server-
   *  side, so hiding is a UX nicety, not security. */
  verb?: string;
}

export interface NavSection {
  kicker: string;
  /** Stable identifier independent of locale — used by render-side
   *  filters that pick a specific section (e.g. the platform-monitoring
   *  block which is hoisted to the top of the operate area). Defaults
   *  to `'default'` for sections that don't need to be singled out. */
  kind?: 'platform' | 'operate' | 'setup' | 'admin' | 'default';
  links: NavRow[];
}

/**
 * The sidebar's static (non-layer) menu: the verb-filtered section
 * registry, the local-edit sync badges on template-admin rows, and the
 * L1 accordion (DSL management) open state. Layer rows are driven
 * separately from the live OAP menu; this is the hand-authored chrome.
 *
 * The L1-open route watch registers here, tearing down with the owner.
 */
export function useSidebarMenu() {
  const { t } = useI18n({ useScope: 'global' });
  const auth = useAuthStore();
  const { bundle } = useConfigBundle();
  const route = useRoute();

  // Each static menu carries the read verb its page's primary data route
  // requires (see apps/bff/src/rbac/route-policy.ts). The sidebar removes
  // rows the user can't read; the BFF enforces the same verbs server-side.
  //
  // `sections` is a `computed`, not a module-level constant, so `t(...)`
  // resolves against the CURRENT locale — otherwise label / kicker text
  // would freeze at first render and a locale switch would only update
  // strings used directly in the template, not these object-embedded ones.
  const sections = computed<NavSection[]>(() => [
    // OAP self-observability diagnostics (the backend itself, not the
    // observed services). Rendered above the per-layer self-observability
    // dashboards. All three are read-only and gated on maintainer-tier verbs.
    {
      kind: 'platform',
      kicker: t('Platform monitoring'),
      links: [
        { icon: 'svc', label: t('Cluster status'), to: '/operate/cluster', verb: 'cluster:read' },
        { icon: 'clock', label: t('Data retention'), to: '/operate/ttl', verb: 'ttl:read' },
        { icon: 'db', label: t('OAP configuration'), to: '/operate/config', verb: 'config:read' },
      ],
    },
    {
      kind: 'operate',
      kicker: t('Operate'),
      links: [
        { icon: 'alert', label: t('Alerting rules'), to: '/operate/alerting-rules', verb: 'alarm-rule:read' },
        {
          icon: 'set',
          label: t('DSL management'),
          // No standalone landing — `to` jumps to the first rule page so
          // the L1 itself is clickable; activeWhen covers all DSL routes.
          to: '/operate/dsl/otel-rules',
          verb: 'rule:read',
          activeWhen: (p) => p === '/operate/oal' || /^\/operate\/dsl(\/|$)/.test(p),
          children: [
            { icon: 'set', label: 'MAL · OTEL', to: '/operate/dsl/otel-rules', verb: 'rule:read' },
            { icon: 'set', label: 'MAL · Telegraf', to: '/operate/dsl/telegraf-rules', verb: 'rule:read' },
            { icon: 'set', label: 'LAL', to: '/operate/dsl/lal', verb: 'rule:read' },
            { icon: 'set', label: 'LAL → MAL', to: '/operate/dsl/log-mal-rules', verb: 'rule:read' },
            { icon: 'trace', label: t('OAL · read-only'), to: '/operate/oal', verb: 'rule:read' },
            { icon: 'download', label: t('Dump & restore'), to: '/operate/dsl/dump', verb: 'rule:read' },
          ],
        },
        {
          icon: 'flame',
          label: t('Live debugger'),
          to: '/operate/live-debug',
          verb: 'live-debug:read',
          // Match the tab variants only; the history sibling at
          // /operate/live-debug/history must NOT highlight this row.
          activeWhen: (p) => p === '/operate/live-debug' || /^\/operate\/live-debug\/(mal|lal|oal)(\/|$)/.test(p),
        },
        { icon: 'event', label: t('Capture history'), to: '/operate/live-debug/history', verb: 'live-debug:read' },
        { icon: 'metric', label: t('Metrics inspect'), to: '/operate/inspect', verb: 'inspect:read' },
        { icon: 'trace', label: t('Trace inspect'), to: '/operate/trace-inspect', verb: 'inspect:read' },
        { icon: 'log', label: t('Log inspect'), to: '/operate/log-inspect', verb: 'inspect:read' },
      ],
    },
    {
      kind: 'setup',
      kicker: t('Dashboard setup'),
      links: [
        { icon: 'set', label: t('Overview templates'), to: '/admin/overview-templates', verb: 'overview:write' },
        { icon: 'metric', label: t('Layer dashboards'), to: '/admin/layer-dashboards', verb: 'dashboard:read' },
        { icon: 'web', label: t('Translations'), to: '/admin/translations', verb: 'overview:write' },
        { icon: 'alert', label: t('Alert page'), to: '/admin/alert-page-setup', verb: 'alarm-setup:read' },
        { icon: 'set', label: t('3D Infra Map'), to: '/admin/3d-map', verb: 'overview:write' },
        { icon: 'set', label: t('Global defaults'), to: '/admin/global-defaults', verb: 'setup:read' },
      ],
    },
    {
      kind: 'admin',
      kicker: t('Admin'),
      links: [
        { icon: 'user', label: t('Users'), to: '/admin/users', verb: 'user:read' },
        { icon: 'set', label: t('Auth status'), to: '/admin/auth-status', verb: 'auth:read' },
        { icon: 'set', label: t('Roles & permissions'), to: '/admin/roles', verb: 'role:read' },
      ],
    },
  ]);

  // Count of templates edited locally but not yet pushed to OAP
  // (diverged = bundled differs from the stored remote). Drives the
  // yellow "unsynced changes" warning on the template-admin menu rows.
  function divergedCount(kind: 'layer' | 'overview'): number {
    const badges = bundle.value?.syncStatus?.badges ?? [];
    return badges.filter((b) => b.kind === kind && b.status === 'diverged').length;
  }

  /** Per-route warn badge for the template-admin rows. */
  function syncBadgeFor(to: string): NavRow['badge'] | undefined {
    const kind = to === '/admin/layer-dashboards' ? 'layer' : to === '/admin/overview-templates' ? 'overview' : null;
    if (!kind) return undefined;
    const n = divergedCount(kind);
    return n > 0 ? { text: String(n), kind: 'warn' } : undefined;
  }

  /**
   * Verb-filtered view of `sections`: rows with a `verb` the current user
   * lacks are removed; rows without a `verb` always show; sections that
   * end up empty are dropped so we don't render orphan headers.
   *
   * Hiding is a UX nicety — the BFF enforces the same verbs server-side,
   * so this is "don't show controls that won't work," not security.
   */
  const visibleSections = computed<NavSection[]>(() => {
    const out: NavSection[] = [];
    for (const sec of sections.value) {
      const links = sec.links
        .filter((r) => !r.verb || auth.hasVerb(r.verb))
        .map((r) => {
          const badge = syncBadgeFor(r.to);
          return badge ? { ...r, badge } : r;
        });
      if (links.length === 0) continue;
      out.push({ kind: sec.kind, kicker: sec.kicker, links });
    }
    return out;
  });

  // Platform monitoring (OAP self-observability) renders at the top of the
  // operate area — above the per-layer self-observability dashboards — so
  // it's pulled out of the generic section loop below. Identified by the
  // locale-independent `kind` tag so the filter survives a language switch.
  const platformSection = computed<NavSection | undefined>(() =>
    visibleSections.value.find((s) => s.kind === 'platform'),
  );
  const menuSections = computed<NavSection[]>(() =>
    visibleSections.value.filter((s) => s.kind !== 'platform'),
  );

  const openNavL1 = ref<Set<string>>(new Set());
  function isNavL1Open(to: string): boolean { return openNavL1.value.has(to); }
  function toggleNavL1(row: NavRow): void {
    if (!row.children) return;
    const next = new Set(openNavL1.value);
    if (next.has(row.to)) next.delete(row.to);
    else next.add(row.to);
    openNavL1.value = next;
  }

  watch(
    () => route.path,
    (path) => {
      for (const sec of sections.value) {
        for (const row of sec.links) {
          if (!row.children) continue;
          const childActive = row.children.some((c) =>
            c.activeWhen ? c.activeWhen(path) : path === c.to,
          );
          const parentActive = row.activeWhen ? row.activeWhen(path) : path === row.to;
          if ((childActive || parentActive) && !openNavL1.value.has(row.to)) {
            openNavL1.value = new Set([...openNavL1.value, row.to]);
          }
        }
      }
    },
    { immediate: true },
  );

  return {
    platformSection,
    menuSections,
    isNavL1Open,
    toggleNavL1,
  };
}
