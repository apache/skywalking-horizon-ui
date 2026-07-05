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

// Minimal, SAFE markdown to HTML for the assistant's streamed prose (headings,
// bold, italic, inline code, code fences, ordered/unordered lists, links). No
// dependency: the source is HTML-escaped FIRST, so any raw HTML the model emits
// is rendered inert - only the whitelist of tags this function generates can
// appear, and link hrefs are restricted to http(s). That is why the result is
// safe to pass to v-html. Unsupported constructs (tables, blockquotes, nested
// lists) degrade to plain text rather than breaking.

const URL_OK = /^https?:\/\//i;
// A control char that cannot appear in the escaped source - used to park inline
// code spans so their contents aren't re-processed as emphasis.
const SENTINEL = String.fromCharCode(0);
const RESTORE = new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g');

// Escape ALL five HTML-significant chars, not just &<>. The quote escapes matter
// because inline() splices the (already-escaped) link URL into a double-quoted
// href attribute - an unescaped " would break out into an injected event handler
// (e.g. onmouseover=) even though URL_OK still gates the scheme. Escaping here,
// before any inline transform, keeps the escape-first guarantee whole.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Inline transforms - operate on already-escaped text.
function inline(s: string): string {
  const codes: string[] = [];
  let out = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push('<code>' + c + '</code>');
    return SENTINEL + (codes.length - 1) + SENTINEL;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t: string, u: string) =>
    URL_OK.test(u) ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>' : m,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
  out = out.replace(RESTORE, (_m, i: string) => codes[Number(i)]);
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = esc(src).split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = (): void => {
    if (para.length) {
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      const items = list.items.map((it) => '<li>' + inline(it) + '</li>').join('');
      out.push('<' + list.type + '>' + items + '</' + list.type + '>');
      list = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence
      out.push('<pre><code>' + buf.join('\n') + '</code></pre>');
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      // Chat headings are modest - map #..###+ into h4..h6.
      const lvl = Math.min(6, h[1].length + 3);
      out.push('<h' + lvl + '>' + inline(h[2].trim()) + '</h' + lvl + '>');
      i++;
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(ul[1]);
      i++;
      continue;
    }

    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(ol[1]);
      i++;
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      flushList();
      i++;
      continue;
    }

    flushList();
    para.push(line.trim());
    i++;
  }
  flushPara();
  flushList();
  return out.join('\n');
}
