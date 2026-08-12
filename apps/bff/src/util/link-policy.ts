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
 * Policy for the outbound links a template may carry. Today that is exactly
 * one field — a layer template's `documentLink`, rendered as the "docs ↗"
 * anchor in the layer header — but the checks live here so a second one
 * cannot arrive without a policy.
 *
 * Two independent checks, deliberately separated because only one of them
 * needs configuration:
 *
 *   - {@link linkSchemeIssue} is pure and belongs in the push schema. It is
 *     the security check: a stored `javascript:` value reaching an `href` is
 *     script execution in the operator's session.
 *   - {@link linkDomainIssue} takes the operator's allow-list, so it runs
 *     where config is in hand. It is a policy check, not a vulnerability
 *     fix: whoever can set `documentLink` already holds `dashboard:write`.
 *
 * Both are applied on the WRITE path (so the operator gets a reason) and on
 * the READ path (because the template store is OAP, which validates nothing
 * and can be written without going through Horizon at all).
 */

/**
 * A value is "site-relative" only if resolving it against an origin actually
 * KEEPS that origin. Testing the string shape instead is not safe: browsers
 * normalise backslashes inside special URLs, so `/\evil.example/x` and
 * `\/evil.example/x` both resolve to `https://evil.example/x` — verified in
 * Chromium, Firefox and WebKit. A prefix test would wave those through as
 * same-origin and skip the domain allow-list entirely, which is exactly the
 * guarantee `trustedLinkDomains: []` is supposed to give.
 *
 * Delegating to the URL parser rather than blocking one character also covers
 * the next quirk without needing to know it.
 */
const SAME_ORIGIN_PROBE = 'https://horizon.invalid';

function staysSameOrigin(value: string): boolean {
  try {
    return new URL(value, SAME_ORIGIN_PROBE).origin === SAME_ORIGIN_PROBE;
  } catch {
    return false;
  }
}

/** True when the value never leaves this origin, however it is spelled. */
function isSiteRelative(value: string): boolean {
  // Must not carry its own scheme AND must resolve back to the probe origin.
  try {
    new URL(value);
    return false; // parsed standalone ⇒ absolute
  } catch {
    return staysSameOrigin(value);
  }
}

/**
 * The whole policy in one call — what every render path must apply.
 *
 * There is more than one route that can put a `documentLink` in front of a
 * user: the menu, and the layer-template list the layer page falls back to
 * when OAP does not list a layer yet. Both render the same anchor, so both
 * ask this, and a new route that forgets to is the failure mode this exists
 * to make hard.
 */
export function documentLinkIssue(
  raw: string,
  trustedDomains: readonly string[],
): string | null {
  return linkSchemeIssue(raw) ?? linkDomainIssue(raw, trustedDomains);
}

/** Scheme check. Returns null when the value is safe to bind to an `href`.
 *
 *  A site-relative path is allowed: an internal deployment may host its
 *  runbook on the same origin. Everything else must parse as http(s) —
 *  enumerating the dangerous schemes instead would mean predicting them. */
export function linkSchemeIssue(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (isSiteRelative(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute http(s) URL or a path that stays on this site';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `scheme "${url.protocol}" is not allowed — only http, https, or a same-origin path`;
  }
  return null;
}

/** Allow-list check against `security.trustedLinkDomains`. An empty
 *  allow-list means "no outbound links at all" — a deliberate, fully closed
 *  console — so it is not treated as "unset". A site-relative path is always
 *  fine; it never leaves the origin. */
export function linkDomainIssue(raw: string, trustedDomains: readonly string[]): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (isSiteRelative(value)) return null;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return null; // shape is linkSchemeIssue's job; don't report it twice
  }
  const trusted = trustedDomains.some((d) => {
    const domain = d.trim().toLowerCase().replace(/^\.+/, '');
    if (!domain) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
  if (trusted) return null;
  return trustedDomains.length === 0
    ? `outbound links are disabled — "${host}" is rejected because security.trustedLinkDomains is empty`
    : `host "${host}" is not in security.trustedLinkDomains`;
}
