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

// e2e widget-form coverage. The template-fidelity spec proves a rendered
// dashboard matches the template that declared it, and it dispatches on widget
// TYPE: each form names the element proving that branch actually drew. If a
// bundled template starts using a form the spec has no proof for, the spec does
// not fail — it silently stops covering that form.
//
// This lives here rather than in the spec because it drives nothing and
// observes nothing: it reads two files. Inside the Playwright project it cost a
// browser and a full OAP + BanyanDB stack to answer a question about disk, and
// could fail the UI e2e project without the product being involved at all.
//
// The SELECTOR is checked, not just the key. `line: ''` keeps the key while the
// spec's own dispatch treats it as absent and skips the assertion — a hole that
// leaves both sides green and the form uncovered.
//
// Its adversarial fixtures run on every invocation, before the real check. A
// coverage gate that cannot demonstrate failure is decoration, and this one
// depends on regexes over a file it does not own, so "still parses" is a claim
// worth re-proving each time rather than trusting.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = resolve(root, 'test/e2e/playwright/specs/ui/template-fidelity.spec.ts');
const FIXTURE = resolve(root, 'test/e2e/playwright/specs/fixture.ts');
const TEMPLATES = resolve(root, 'apps/bff/src/bundled_templates/layers');

/** Forms the fixture must keep exercising; losing one silently guts the spec. */
const REQUIRED_FORMS = ['line', 'top'];

/**
 * Every problem with one (spec, template) pair, as plain strings.
 *
 * Pure so the fixtures below can drive it without touching the repo.
 */
function coverageIssues(specSrc, template, layer) {
  const issues = [];
  const block = specSrc.match(/const RENDERED_AS[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!block) return [`could not find the RENDERED_AS map — has it been renamed?`];

  // Key AND selector. A blank selector is a missing proof, not a proof.
  const proofs = new Map();
  for (const m of block[1].matchAll(/^\s*([a-z][a-z0-9]*)\s*:\s*'([^']*)'/gm)) {
    proofs.set(m[1], m[2].trim());
  }
  if (proofs.size === 0) return ['parsed the RENDERED_AS map but found no widget forms in it'];
  for (const [form, selector] of proofs) {
    if (selector === '') {
      issues.push(
        `widget form "${form}" has an empty selector in RENDERED_AS — the spec skips its rendered-proof entirely`,
      );
    }
  }

  // Ungated widgets only, matching what the spec asserts: a `visibleWhen`
  // widget is dropped per entity, so it is not guaranteed to render.
  const used = new Set(
    ['service', 'endpoint', 'instance']
      .flatMap((scope) => template.dashboards?.[scope] ?? [])
      .filter((w) => w?.visibleWhen === undefined && typeof w?.type === 'string')
      .map((w) => w.type),
  );
  if (used.size === 0) return [`${layer} declares no ungated widgets — wrong layer?`];

  for (const type of used) {
    if (!proofs.has(type)) {
      issues.push(
        `no rendered-proof defined for widget type "${type}" — add one to RENDERED_AS in template-fidelity.spec.ts, or its assertions silently stop covering it`,
      );
    }
  }
  // `card` and `table` are not reachable from this fixture: general declares
  // neither. They live in the Kubernetes layers, so coverage arrives with the
  // planned k8s monitoring case. Until then this keeps the omission visible
  // rather than letting it pass as covered.
  for (const form of REQUIRED_FORMS) {
    if (!used.has(form)) issues.push(`the ${layer} fixture no longer renders any "${form}" widget`);
  }
  return issues;
}

const GOOD_SPEC = "const RENDERED_AS: Record<string, string> = {\n  line: '.time-chart',\n  top: '.top-list',\n};";
const GOOD_TEMPLATE = {
  dashboards: { service: [{ type: 'line' }, { type: 'top' }], endpoint: [], instance: [] },
};

/** Each fixture must produce an issue mentioning `expect`; the good pair must produce none. */
const FIXTURES = [
  ['a blank selector', GOOD_SPEC.replace("'.time-chart'", "''"), GOOD_TEMPLATE, 'empty selector'],
  ['a renamed map', GOOD_SPEC.replace('RENDERED_AS', 'RENDERED_MAP'), GOOD_TEMPLATE, 'renamed'],
  [
    'an unproven widget form',
    GOOD_SPEC,
    { dashboards: { service: [{ type: 'line' }, { type: 'top' }, { type: 'heatmap' }] } },
    'heatmap',
  ],
  [
    'a form the fixture stopped rendering',
    GOOD_SPEC,
    { dashboards: { service: [{ type: 'line' }] } },
    'top',
  ],
];

function selfTest() {
  const clean = coverageIssues(GOOD_SPEC, GOOD_TEMPLATE, 'selftest');
  if (clean.length > 0) {
    return `the healthy fixture reported ${clean.length} issue(s): ${clean.join('; ')}`;
  }
  for (const [name, spec, template, expected] of FIXTURES) {
    const found = coverageIssues(spec, template, 'selftest');
    if (!found.some((i) => i.includes(expected))) {
      return `fixture "${name}" was not caught (expected an issue mentioning "${expected}", got: ${found.join('; ') || 'none'})`;
    }
  }
  return null;
}

const broken = selfTest();
if (broken) {
  console.error(`check-e2e-widget-coverage: SELF-TEST FAILED — ${broken}`);
  console.error('the gate cannot be trusted until this passes; it would report zero findings.');
  process.exit(1);
}

const layerMatch = readFileSync(FIXTURE, 'utf8').match(/export const LAYER\s*=\s*'([^']+)'/);
if (!layerMatch) {
  console.error(`check-e2e-widget-coverage: could not read LAYER from ${FIXTURE}`);
  process.exit(1);
}
const layer = layerMatch[1];
const issues = coverageIssues(
  readFileSync(SPEC, 'utf8'),
  JSON.parse(readFileSync(resolve(TEMPLATES, `${layer}.json`), 'utf8')),
  layer,
);

if (issues.length > 0) {
  for (const issue of issues) console.error(`check-e2e-widget-coverage: ${issue}`);
  process.exit(1);
}
console.log(
  `check-e2e-widget-coverage: ok — ${layer}'s widget forms all have a non-empty rendered-proof (${FIXTURES.length} self-test fixtures passed)`,
);
