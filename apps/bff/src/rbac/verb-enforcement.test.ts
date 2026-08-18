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
 * Drift gate between four lists that have no compiler link:
 * the verb namespace, the places that enforce a verb, the Roles board that
 * presents verbs to an admin as capabilities, and the sidebar menu whose
 * per-role visibility that same board tabulates.
 *
 * The failure this exists to stop: a verb shown on the board (and granted by
 * a stock role) that nothing anywhere checks — an admin reads it as a working
 * capability and hands it out. The inverse is just as wrong: a verb marked
 * RESERVED that has since been wired up would be documented as inert while it
 * really gates something. The menu matrix fails the same way in both
 * directions — a row naming a verb nothing gates promises a control that does
 * not exist, and a sidebar entry with no row makes the matrix an incomplete
 * answer to "what will this role see" while the page says it is the whole one.
 *
 * Enforcement is read out of the sources rather than declared, so adding a
 * route / handler check / nav gate is enough to move a verb — nothing here
 * needs a parallel edit except when a verb genuinely changes status.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { RESERVED_VERBS, VERBS, hasVerb } from './verbs.js';
import { ROUTE_POLICY } from './route-policy.js';
import { configSchema } from '../config/schema.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const BFF_SRC = join(REPO, 'apps/bff/src');
const UI_SRC = join(REPO, 'apps/ui/src');
const ROLES_VIEW = join(UI_SRC, 'features/admin/roles/RolesView.vue');
/** The static (non-layer) sidebar registry the menu matrix tabulates. */
const SIDEBAR_MENU = join(UI_SRC, 'shell/useSidebarMenu.ts');
/** The nav entries the shell builds itself instead of from that registry. */
const APP_SIDEBAR = join(UI_SRC, 'shell/AppSidebar.vue');

/** `admin` is a grant sentinel, not a required verb: no request asks for it,
 *  it is what `matchOne` honors to mean "everything". Asserted separately. */
const GRANT_SENTINEL = 'admin';

const ALL_VERBS = Object.values(VERBS).filter((v) => v !== GRANT_SENTINEL);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|vue)$/.test(p) && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Comments are prose, not enforcement — a verb named only in a comment must
 *  not count as a gate. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const KNOWN_VERBS = new Set<string>(Object.values(VERBS));

/** Every verb any route requires, conjunctions flattened. */
const POLICY_VERBS = new Set(
  Object.values(ROUTE_POLICY).flatMap((p) => (Array.isArray(p) ? p : [p])),
);

/** A call that can deny the request. `hasVerb` covers the UI's
 *  `auth.hasVerb(...)` and the AI tools' `ctx.hasVerb(...)` alike. */
const CHECK_CALL = /(?:ensureVerb|sessionHasVerb|checkVerb|hasVerb)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
const QUOTED = /'([^'\n]+)'|"([^"\n]+)"/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The verbs a source file can DENY a request on — never the ones it merely
 * names. A verb reaches a check three ways:
 *   - as a literal argument to a check call;
 *   - through a local `const` a check call is handed (the rule routes pick
 *     between two verbs by a ternary, the template save between two kinds);
 *   - in a UI file, as a `verb:` field — a sidebar row (the menu filters rows
 *     through `auth.hasVerb`) or a route's `meta.verb` (the router guard reads
 *     it). BFF files carry `verb:` fields too, but there they are audit-log
 *     metadata, which is the whole point of this distinction: a verb that
 *     survives only in an audit record passed this whole file green while
 *     nothing checked it.
 * A construction this cannot resolve statically (a verb built at runtime, a
 * check behind an indirection) is left OUT: under-claiming reports a verb as
 * unenforced and gets looked at; over-claiming is how the miss happened.
 */
function checkedVerbs(src: string, opts: { ui: boolean }): Set<string> {
  const source = code(src);
  const found = new Set<string>();
  const viaIdentifier = new Set<string>();
  const keep = (s: string | undefined): void => {
    if (s !== undefined && KNOWN_VERBS.has(s)) found.add(s);
  };
  for (const call of source.matchAll(CHECK_CALL)) {
    const args = call[1] ?? '';
    for (const q of args.matchAll(QUOTED)) keep(q[1] ?? q[2]);
    for (const arg of args.split(',')) {
      const a = arg.trim();
      if (IDENTIFIER.test(a)) viaIdentifier.add(a);
    }
  }
  for (const id of viaIdentifier) {
    for (const decl of source.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*=([^;\\n]*)`, 'g'))) {
      for (const q of decl[1].matchAll(QUOTED)) keep(q[1] ?? q[2]);
    }
  }
  if (opts.ui) for (const m of source.matchAll(/\bverb:\s*'([^'\n]+)'/g)) keep(m[1]);
  return found;
}

/**
 * Where each verb is actually checked:
 *   - the route table (`ROUTE_POLICY`),
 *   - an in-handler check under `http/` or an AI-tool check under `ai/`,
 *   - a UI gate: a sidebar row's `verb`, a route's `meta.verb`, or
 *     `auth.hasVerb(...)` in a view. The Roles board itself is excluded —
 *     it *displays* every verb, which is exactly what is being checked.
 *
 * `policyVerbs` is injectable so a test can ask what the detector would say
 * with the route-table gate removed.
 */
function enforcementSites(verb: string, policyVerbs: ReadonlySet<string> = POLICY_VERBS): string[] {
  const sites: string[] = [];
  if (policyVerbs.has(verb)) sites.push('ROUTE_POLICY');
  for (const dir of ['http', 'ai']) {
    for (const file of walk(join(BFF_SRC, dir))) {
      if (checkedVerbs(readFileSync(file, 'utf8'), { ui: false }).has(verb)) {
        sites.push(file.slice(REPO.length));
      }
    }
  }
  for (const file of walk(UI_SRC)) {
    if (file === ROLES_VIEW) continue;
    if (checkedVerbs(readFileSync(file, 'utf8'), { ui: true }).has(verb)) {
      sites.push(file.slice(REPO.length));
    }
  }
  return sites;
}

const rolesView = readFileSync(ROLES_VIEW, 'utf8');
/** Every verb listed in a `verbs: [...]` group of the capability matrix. */
const boardVerbs = new Set(
  [...rolesView.matchAll(/verbs: \[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]),
  ),
);
/** Verbs the board gives a plain-English label — the `verb` fallback label
 *  would print the raw identifier the page deliberately keeps off screen. */
const labeledVerbs = new Set(
  [...rolesView.matchAll(/'([a-z0-9:*-]+)':\s*\{\s*label:/g)].map((m) => m[1]),
);

/** The `[…]` a `const <name> = …(() => [` registry is initialised to. Both
 *  registries the menu gate compares are plain literals, which is why it can
 *  read them here instead of pulling Vue into a BFF test run. */
function registryLiteral(src: string, name: string): string {
  const decl = src.indexOf(`const ${name}`);
  const arrow = decl < 0 ? -1 : src.indexOf('=> [', decl);
  // Must belong to THIS declaration: latching onto the next one's literal
  // would compare a registry nobody asked about and call the result agreement.
  const next = /\n\s*const /.exec(src.slice(decl + 1));
  const nextDecl = next?.index === undefined ? -1 : decl + 1 + next.index;
  if (arrow < 0 || (nextDecl >= 0 && arrow > nextDecl)) {
    throw new Error(`${name}: no array-literal registry found on the declaration`);
  }
  const open = arrow + 3;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name}: unbalanced array literal`);
}

const at = (m: RegExpMatchArray): number => m.index ?? 0;

interface SidebarEntry {
  path: string;
  /** `null` when the row's gate could not be resolved — see below. */
  verb: string | null;
}

/**
 * Every destination the static sidebar menu renders, with the verb its row is
 * hidden by: the L1 rows and the L2 rows under an expandable one alike (an
 * expandable L1 repeats its first child's path, which is harmless — the gate
 * compares sets).
 *
 * A row's verb is the first `verb:` between its `to:` and the next row's,
 * which is the shape every entry in the registry has. A row that carries none
 * there comes back `null` rather than borrowing the following row's: the
 * assertions report it instead of pairing an entry with a gate it does not
 * have. Under-claiming is the point — a wrong pairing reads as agreement.
 */
function sidebarEntries(): SidebarEntry[] {
  const block = registryLiteral(readFileSync(SIDEBAR_MENU, 'utf8'), 'sections');
  const tos = [...block.matchAll(/\bto:\s*'([^']+)'/g)];
  return tos.map((m, i) => {
    const from = at(m) + m[0].length;
    const until = i + 1 < tos.length ? at(tos[i + 1]!) : block.length;
    const verb = /\bverb:\s*'([^']+)'/.exec(block.slice(from, until));
    return { path: m[1]!, verb: verb ? verb[1]! : null };
  });
}

interface MatrixRow {
  label: string;
  verb: string | null;
  /** Sidebar destinations the row stands for; empty for the entries the shell
   *  builds itself and for the topbar's 3D-map entry. */
  covers: string[];
  /** False when the row omits `covers` altogether — a row the gate could not
   *  check, reported rather than passed over. */
  declaresCovers: boolean;
}

/** The menu-visibility rows of the Roles board. Each is a flat object
 *  literal, so no nesting analysis is needed to split them. */
function matrixRows(): MatrixRow[] {
  const block = registryLiteral(rolesView, 'MENU_GATES');
  return [...block.matchAll(/\{[^{}]*\}/g)].map((m) => {
    const row = m[0];
    const label = /label:\s*t\('([^']*)'\)/.exec(row);
    const verb = /\bverb:\s*'([^']+)'/.exec(row);
    const covers = /covers:\s*\[([^\]]*)\]/.exec(row);
    return {
      label: label ? label[1]! : row,
      verb: verb ? verb[1]! : null,
      covers: covers ? [...covers[1]!.matchAll(/'([^']+)'/g)].map((c) => c[1]!) : [],
      declaresCovers: covers !== null,
    };
  });
}

describe('reserved verbs — declared but enforced nowhere', () => {
  it.each([...RESERVED_VERBS])('%s is checked by nothing', (verb) => {
    expect(enforcementSites(verb)).toEqual([]);
  });

  it('no stock role grants a reserved verb', () => {
    const roles = configSchema.parse({}).rbac.roles;
    for (const [role, grants] of Object.entries(roles)) {
      if (grants.includes('*')) continue; // the admin role is the escape hatch
      for (const reserved of RESERVED_VERBS) {
        expect(
          { role, grants: grants.filter((g) => hasVerb([g], reserved)) },
          `role "${role}" grants reserved verb ${reserved}`,
        ).toEqual({ role, grants: [] });
      }
    }
  });
});

describe('every other verb earns its place', () => {
  it.each(ALL_VERBS.filter((v) => !RESERVED_VERBS.includes(v)))(
    '%s is enforced somewhere',
    (verb) => {
      expect(enforcementSites(verb).length, `${verb} has no enforcement site`).toBeGreaterThan(0);
    },
  );

  it('the sentinel grants everything and is required by no route', () => {
    expect([...POLICY_VERBS]).not.toContain(GRANT_SENTINEL);
    for (const verb of ALL_VERBS) expect(hasVerb([GRANT_SENTINEL], verb)).toBe(true);
  });
});

describe('enforcement detection tells a gate from a log field', () => {

  /**
   * A `verb:` field naming a capability is not a check on it. The audit trail
   * used to carry such fields, which is what this guards against; the trail is
   * gone, so the case is stated as source rather than read from a file that no
   * longer contains one — the detector must stay wrong-proof either way.
   */
  it('does not read a `verb:` data field as a check', () => {
    const src = "record({ action: 'debug.start', verb: 'live-debug:write', outcome: 'ok' });";
    expect([...checkedVerbs(src, { ui: false })]).not.toContain('live-debug:write');
  });

  it('reads a real check — literal, via a local const, and a UI nav gate', () => {
    expect([
      ...checkedVerbs("if (!ensureVerb(req, reply, deps, 'live-debug:write')) return;", {
        ui: false,
      }),
    ]).toContain('live-debug:write');
    expect([
      ...checkedVerbs(
        "const v = force ? 'rule:write:structural' : 'rule:write';\nif (!ensureVerb(req, reply, deps, v)) return;",
        { ui: false },
      ),
    ]).toEqual(expect.arrayContaining(['rule:write:structural', 'rule:write']));
    expect([...checkedVerbs("{ to: '/operate/cluster', verb: 'cluster:read' }", { ui: true })])
      .toContain('cluster:read');
  });

  // The regression this whole file exists to catch, run end to end. The route
  // table is `live-debug:write`'s only gate: take it away and the verb survives
  // in the sources purely as audit metadata and a Roles-board row, so every
  // site must disappear. Before the detector was strengthened it reported those
  // audit records as gates, and 44 green tests said a verb was enforced while
  // it enforced nothing.
  it('reports live-debug:write unenforced the moment the route table stops requiring it', () => {
    const withoutPolicy = new Set([...POLICY_VERBS].filter((v) => v !== 'live-debug:write'));
    expect(enforcementSites('live-debug:write', withoutPolicy)).toEqual([]);
    expect(enforcementSites('live-debug:write')).toContain('ROUTE_POLICY');
  });
});

describe('the live debugger is gated on live-debug alone', () => {
  it('start and stop require live-debug:write', () => {
    expect(ROUTE_POLICY['POST /api/debug/session']).toEqual('live-debug:write');
    expect(ROUTE_POLICY['POST /api/debug/session/:id/stop']).toEqual('live-debug:write');
  });

  // A rule verb added here would gate the Live Debugger under a name that reads
  // like the DSL pages, which is how a permission ends up in the `rule:*` family
  // while only ever gating captures.
  it('no /api/debug/* route requires a rule verb', () => {
    for (const [route, policy] of Object.entries(ROUTE_POLICY)) {
      if (!route.includes(' /api/debug/')) continue;
      const verbs = Array.isArray(policy) ? policy : [policy];
      expect(verbs.filter((v) => v.startsWith('rule:')), route).toEqual([]);
    }
  });

  it('the session reads require live-debug:read and nothing else', () => {
    for (const route of [
      'GET /api/debug/session/:id',
      'GET /api/debug/sessions',
      'GET /api/debug/status',
    ]) {
      expect(ROUTE_POLICY[route], route).toEqual('live-debug:read');
    }
    expect([...checkedVerbs(readFileSync(join(BFF_SRC, 'http/admin/live-debug.ts'), 'utf8'), {
      ui: false,
    })], 'no handler-side verb may re-tighten a live-debug read').toEqual([]);
  });
});

describe('the Roles board matches the namespace', () => {
  it('describes every known verb — nothing falls into the uncategorised bucket', () => {
    const undescribed = Object.values(VERBS).filter((v) => !boardVerbs.has(v));
    expect(undescribed, 'add these to a VERB_GROUPS group in RolesView.vue').toEqual([]);
  });

  it('labels every known verb in plain English', () => {
    const unlabeled = Object.values(VERBS).filter((v) => !labeledVerbs.has(v));
    expect(unlabeled, 'add these to VERB_LABELS in RolesView.vue').toEqual([]);
  });

  it('shows no verb the server does not declare', () => {
    const known = new Set<string>(Object.values(VERBS));
    expect([...boardVerbs].filter((v) => !known.has(v))).toEqual([]);
  });

  it('every menu-visibility row names a verb the UI really gates on', () => {
    // `null` rows (visible to any signed-in user) carry no verb to check.
    const menuVerbs = matrixRows()
      .map((r) => r.verb)
      .filter((v): v is string => v !== null);
    expect(menuVerbs.length).toBeGreaterThan(0);
    for (const verb of menuVerbs) {
      const uiSites = enforcementSites(verb).filter((s) => s.startsWith('apps/ui/'));
      expect(uiSites.length, `menu row claims ${verb} hides an entry, but no UI gate reads it`)
        .toBeGreaterThan(0);
    }
  });
  // A route's policy verb runs in the preHandler hook, BEFORE the handler. So
  // when a handler also calls ensureVerb, the STRICTER of the two decides, and
  // the handler's own check can never be reached with anything the hook
  // rejected. If the two disagree, the handler's verb — the one the page and
  // the docs are written against — becomes a lie: the button renders enabled
  // and the request 403s. This caught `GET /api/dump*`, policy-gated on a debug
  // verb while its handler, its button and its docs all said `rule:read`.
  it('never gates a route on a different verb than its own handler enforces', () => {
    const httpDir = join(BFF_SRC, 'http');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.ts') && !f.endsWith('.test.ts')) files.push(f);
      }
    };
    walk(httpDir);

    const mismatches: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const handlerVerbs = new Set(
        [...src.matchAll(/ensureVerb\(\s*req,\s*reply,\s*deps,\s*'([a-z0-9:-]+)'/g)].map((m) => m[1]),
      );
      if (handlerVerbs.size === 0) continue;
      // The route paths this file registers, as they appear in ROUTE_POLICY.
      for (const [route, policy] of Object.entries(ROUTE_POLICY)) {
        const path = route.split(' ').slice(1).join(' ');
        if (!src.includes(`'${path}'`) && !src.includes(`"${path}"`)) continue;
        const policyVerbs = Array.isArray(policy) ? policy : [policy];
        if (policyVerbs.includes('auth')) continue;
        // Only flag when NO policy verb appears anywhere in the handler file.
        // A file registering several routes may select its verb through a
        // variable, which the literal scan above cannot resolve — pooling one
        // file's verbs against all its routes would call that a mismatch. If
        // the string is absent entirely, the handler cannot be enforcing it.
        if (policyVerbs.some((v) => src.includes(`'${v}'`))) continue;
        mismatches.push(
          `${route} is policy-gated on ${policyVerbs.map((v) => `'${v}'`).join(' + ')} but ` +
            `${relative(REPO, file)} enforces ` +
            `${[...handlerVerbs].map((v) => `'${v}'`).join(' / ')} — the hook wins, so the handler's verb never decides`,
        );
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});

/**
 * The board tells an admin the matrix is every navigation entry. Checking only
 * that each row names a real gate (above) leaves the promise open at the other
 * end, and that is where it broke: Trace inspect, Log inspect, Translations and
 * the 3D-map editor were all added to the sidebar re-using a verb the matrix
 * already listed, so every row still named a working gate and no row existed
 * for any of them. A verb-level check cannot see that — these assertions
 * compare ENTRIES.
 */
describe('the menu-visibility matrix mirrors the navigation', () => {
  const entries = sidebarEntries();
  const rows = matrixRows();
  const covered = new Set(rows.flatMap((r) => r.covers));

  it('resolves the gate on every sidebar entry', () => {
    expect(entries.length, 'no sidebar entries parsed — the registry shape moved').toBeGreaterThan(
      0,
    );
    expect(
      entries.filter((e) => e.verb === null).map((e) => e.path),
      'no verb between this entry and the next: the matrix cannot be checked against it',
    ).toEqual([]);
  });

  it('states what every row covers', () => {
    expect(
      rows.filter((r) => !r.declaresCovers).map((r) => r.label),
      'give each MENU_GATES row a `covers` list ([] for an entry the menu registry does not build)',
    ).toEqual([]);
  });

  it('gives every sidebar entry a row', () => {
    const orphans = [...new Set(entries.map((e) => e.path))].filter((p) => !covered.has(p));
    expect(orphans, 'these sidebar entries appear in no MENU_GATES row — add them').toEqual([]);
  });

  it('claims no entry the sidebar no longer builds', () => {
    const paths = new Set(entries.map((e) => e.path));
    expect(
      [...covered].filter((p) => !paths.has(p)),
      'MENU_GATES covers a destination the sidebar menu does not render',
    ).toEqual([]);
  });

  it('names the verb the sidebar really hides each covered entry by', () => {
    const gateOf = new Map(entries.map((e) => [e.path, e.verb]));
    const disagree = rows.flatMap((r) =>
      r.covers
        .filter((p) => gateOf.get(p) !== r.verb)
        .map((p) => `row "${r.label}" says ${r.verb} — the sidebar gates ${p} on ${gateOf.get(p)}`),
    );
    expect(disagree, disagree.join('\n')).toEqual([]);
  });

  // The rows with an empty `covers` stand for nav AppSidebar builds itself —
  // the overview links, Alarms, the layer rows — which are template blocks,
  // not registry rows, so their entries cannot be counted from here. What can
  // be checked is that no such block is gated on a verb the matrix never
  // mentions: it catches a new gated section, not a new entry inside one.
  it('carries every verb the shell gates a nav block on', () => {
    const shellVerbs = new Set(
      [...readFileSync(APP_SIDEBAR, 'utf8').matchAll(/auth\.hasVerb\('([^']+)'\)/g)].map(
        (m) => m[1]!,
      ),
    );
    const rowVerbs = new Set(rows.map((r) => r.verb));
    expect(
      [...shellVerbs].filter((v) => !rowVerbs.has(v)),
      'AppSidebar hides a nav block on a verb no menu-visibility row names',
    ).toEqual([]);
  });
});
