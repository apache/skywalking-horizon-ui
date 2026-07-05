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
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders headings, bold, and inline code', () => {
    expect(renderMarkdown('### Topology Views')).toBe('<h6>Topology Views</h6>');
    expect(renderMarkdown('the **songs** service')).toBe('<p>the <strong>songs</strong> service</p>');
    expect(renderMarkdown('use `agent::songs` here')).toBe('<p>use <code>agent::songs</code> here</p>');
  });

  it('renders unordered and ordered lists', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderMarkdown('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('renders a code fence verbatim (escaped, not formatted)', () => {
    expect(renderMarkdown('```\nkubectl get pods\n```')).toBe('<pre><code>kubectl get pods</code></pre>');
  });

  it('ESCAPES raw HTML so LLM output cannot inject (the safety guarantee)', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)> and <script>evil()</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
    expect(out).toContain('&lt;script');
  });

  it('allows http(s) links but drops javascript: URLs', () => {
    expect(renderMarkdown('[docs](https://skywalking.apache.org)')).toContain(
      '<a href="https://skywalking.apache.org"',
    );
    const bad = renderMarkdown('[x](javascript:alert(1))');
    expect(bad).not.toContain('href="javascript');
    expect(bad).toContain('[x](javascript:alert(1))');
  });

  it('escapes a double-quote inside an http(s) link URL (no attribute-injection)', () => {
    const out = renderMarkdown('[click](https://x"onmouseover="alert(document.cookie))');
    // The quote must not survive to break out of the href="..." attribute.
    expect(out).not.toContain('onmouseover="');
    expect(out).not.toContain('"onmouseover');
    expect(out).toContain('&quot;');
  });

  it('does not treat a bare number-in-spaces as an inline-code placeholder', () => {
    expect(renderMarkdown('scaled from 3 to 5 pods')).toBe('<p>scaled from 3 to 5 pods</p>');
  });
});
