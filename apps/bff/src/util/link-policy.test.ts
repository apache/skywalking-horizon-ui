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

import { describe, it, expect } from 'vitest';
import { linkSchemeIssue, linkDomainIssue } from './link-policy.js';
import { layerTemplatePushSchema } from '../logic/templates/bundled-schema.js';

describe('linkSchemeIssue', () => {
  // The reason this check exists: the value is bound to an `href` in the
  // layer header, and the store it comes from validates nothing.
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('refuses %s', (value) => {
    expect(linkSchemeIssue(value)).not.toBeNull();
  });

  // An internal deployment may have no TLS and may host its runbook on the
  // same origin — neither is a reason to reject.
  it.each([
    'https://skywalking.apache.org/docs/',
    'http://wiki.internal/runbook',
    'http://10.0.0.5:8080/docs',
    '/internal-docs/general',
    '',
    '   ',
  ])('accepts %s', (value) => {
    expect(linkSchemeIssue(value)).toBeNull();
  });

  // `//host/x` reads like a path but inherits the page scheme and leaves the
  // origin, so it must not pass as "site-relative".
  it('refuses a protocol-relative URL', () => {
    expect(linkSchemeIssue('//evil.example/x')).not.toBeNull();
  });

  // Browsers normalise backslashes inside special URLs, so each of these
  // resolves to https://evil.example/x — confirmed in Chromium, Firefox and
  // WebKit. A prefix test on "/" would accept them as same-origin and skip
  // the domain allow-list, defeating `trustedLinkDomains: []`.
  it.each(['/\\evil.example/x', '\\/evil.example/x', '/\\\\evil.example/x', '\\\\evil.example/x'])(
    'refuses the backslash-normalised escape %s',
    (value) => {
      expect(linkSchemeIssue(value)).not.toBeNull();
    },
  );
});

describe('linkDomainIssue', () => {
  const trusted = ['skywalking.apache.org', 'wiki.internal'];

  it('accepts a listed host and its subdomains', () => {
    expect(linkDomainIssue('https://skywalking.apache.org/docs/', trusted)).toBeNull();
    expect(linkDomainIssue('https://docs.wiki.internal/x', trusted)).toBeNull();
  });

  it('refuses an unlisted host, naming it', () => {
    expect(linkDomainIssue('https://evil.example/x', trusted)).toContain('evil.example');
  });

  // A host that merely ENDS with the trusted string is a different host —
  // `notwiki.internal` is not a subdomain of `wiki.internal`, and an attacker
  // registering `skywalking.apache.org.evil.com` must not inherit trust.
  it('does not treat a lookalike suffix as a subdomain', () => {
    expect(linkDomainIssue('https://notwiki.internal/x', ['wiki.internal'])).not.toBeNull();
    expect(linkDomainIssue('https://skywalking.apache.org.evil.com/x', trusted)).not.toBeNull();
  });

  it('never blocks a site-relative link, whatever the list says', () => {
    expect(linkDomainIssue('/runbook/kafka', [])).toBeNull();
  });

  // The closed-console guarantee has to survive the same escape. The domain
  // check defers a malformed value to linkSchemeIssue rather than reporting
  // it twice, so the guarantee lives in the pair — which is how both call
  // sites apply it (`linkSchemeIssue(v) ?? linkDomainIssue(v, …)`).
  it.each(['/\\evil.example/x', '\\/evil.example/x'])(
    'rejects %s through the pair, with an empty allow-list or a populated one',
    (value) => {
      for (const list of [[], ['skywalking.apache.org']]) {
        expect(linkSchemeIssue(value) ?? linkDomainIssue(value, list)).not.toBeNull();
      }
    },
  );

  // An empty list is the fully-closed console, not "unconfigured".
  it('refuses every outbound link when the list is empty', () => {
    expect(linkDomainIssue('https://skywalking.apache.org/x', [])).toContain('empty');
  });
});

describe('the layer push schema applies the scheme check', () => {
  const base = { key: 'GENERAL', components: {}, dashboards: {} };

  it('refuses a stored javascript: documentLink with a reason naming the scheme', () => {
    const parsed = layerTemplatePushSchema.safeParse({
      ...base,
      documentLink: 'javascript:alert(document.domain)',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path[0] === 'documentLink');
    expect(issue?.message).toContain('javascript:');
  });

  it('still accepts the shape every bundled template uses', () => {
    const parsed = layerTemplatePushSchema.safeParse({
      ...base,
      documentLink: 'https://skywalking.apache.org/docs/main/next/en/setup/',
    });
    expect(parsed.success).toBe(true);
  });
});
