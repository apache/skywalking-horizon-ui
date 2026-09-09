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
 * A tool call's input and result as the runtime carries them: one JSON
 * object, which the Sessionizer clips to 2,000 bytes and whose encoder
 * writes `>` as `\u003e`. Read leniently into the fields it holds, so a
 * shell command is drawn as the lines that were run rather than as one
 * escaped string; a clipped object still yields the fields before the cut,
 * with the cut marked. Anything that is not such an object stays the text
 * it is, since a misread is worse than the raw text.
 */

import { esc } from '../dom.js';
import { fill, type ViewStrings } from '../strings.js';
import type { ViewContext } from './context.js';
import { lineDiff } from './linediff.js';

export interface StructuredField {
  /** The runtime's own key, shown as given. */
  key: string;
  /** The decoded string; the JSON text of anything else. */
  value: string;
  /** Drawn on lines of its own: the value holds a newline or is long. */
  block: boolean;
  /** The document's clip fell inside this value. */
  cut: boolean;
}

export interface Structured {
  fields: StructuredField[];
  /** The object ended at the clip rather than at its closing brace. */
  cut: boolean;
}

/** A string value up to this long, without a newline, sits beside its key. */
const INLINE_MAX = 80;

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };

class Malformed extends Error {}

interface Piece {
  value: string;
  /** False when the text ended inside the piece. */
  closed: boolean;
}

class Reader {
  pos = 0;
  constructor(private readonly t: string) {}

  get done(): boolean {
    return this.pos >= this.t.length;
  }

  peek(): string {
    return this.t[this.pos] ?? '';
  }

  ws(): void {
    while (!this.done && /\s/.test(this.t[this.pos]!)) this.pos++;
  }

  /** From the opening quote to the closing one, decoding the escapes. */
  string(): Piece {
    const t = this.t;
    let out = '';
    let j = this.pos + 1;
    while (j < t.length) {
      const c = t[j]!;
      if (c === '"') {
        this.pos = j + 1;
        return { value: out, closed: true };
      }
      if (c !== '\\') {
        out += c;
        j++;
        continue;
      }
      const e = t[j + 1];
      if (e === undefined) break;
      if (e === 'u') {
        const hex = t.slice(j + 2, j + 6);
        if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Malformed();
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        j += 6;
        continue;
      }
      const plain = ESCAPES[e];
      if (plain === undefined) throw new Malformed();
      out += plain;
      j += 2;
    }
    this.pos = t.length;
    return { value: out, closed: false };
  }

  /** An object or array as its own text, balanced over the strings inside. */
  nested(): Piece {
    const t = this.t;
    const start = this.pos;
    let depth = 0;
    let j = start;
    while (j < t.length) {
      const c = t[j]!;
      if (c === '"') {
        this.pos = j;
        if (!this.string().closed) return { value: t.slice(start), closed: false };
        j = this.pos;
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          this.pos = j + 1;
          const value = t.slice(start, j + 1);
          try {
            JSON.parse(value);
          } catch {
            throw new Malformed();
          }
          return { value, closed: true };
        }
      }
      j++;
    }
    this.pos = t.length;
    return { value: t.slice(start), closed: false };
  }

  /** A number, `true`, `false` or `null`. */
  token(): Piece {
    const t = this.t;
    const start = this.pos;
    while (this.pos < t.length && /[-+0-9.eEa-z]/.test(t[this.pos]!)) this.pos++;
    const value = t.slice(start, this.pos);
    if (this.done) return { value, closed: false };
    if (!/^(?:-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)$/.test(value)) throw new Malformed();
    return { value, closed: true };
  }
}

/** The fields of the object `text` holds, or `null` when it is not one. */
export function structure(text: string): Structured | null {
  try {
    return readObject(new Reader(text));
  } catch (e) {
    if (e instanceof Malformed) return null;
    throw e;
  }
}

function readObject(r: Reader): Structured | null {
  r.ws();
  if (r.peek() !== '{') return null;
  r.pos++;
  const fields: StructuredField[] = [];
  let cut = false;
  let afterComma = false;
  for (;;) {
    r.ws();
    if (r.done) {
      cut = true;
      break;
    }
    if (r.peek() === '}') {
      if (afterComma) throw new Malformed();
      r.pos++;
      break;
    }
    if (r.peek() !== '"') throw new Malformed();
    const key = r.string();
    if (!key.closed) {
      cut = true;
      break;
    }
    r.ws();
    if (r.done) {
      cut = true;
      break;
    }
    if (r.peek() !== ':') throw new Malformed();
    r.pos++;
    r.ws();
    if (r.done) {
      cut = true;
      break;
    }
    const c = r.peek();
    const v = c === '"' ? r.string() : c === '{' || c === '[' ? r.nested() : r.token();
    fields.push({ key: key.value, value: v.value, block: v.value.includes('\n') || v.value.length > INLINE_MAX, cut: !v.closed });
    if (!v.closed) {
      cut = true;
      break;
    }
    r.ws();
    if (r.done) {
      cut = true;
      break;
    }
    if (r.peek() === ',') {
      r.pos++;
      afterComma = true;
      continue;
    }
    if (r.peek() === '}') {
      r.pos++;
      break;
    }
    throw new Malformed();
  }
  if (!cut) {
    r.ws();
    if (!r.done) return null;
  }
  return fields.length ? { fields, cut } : null;
}

/** The runtime's pair of fields that spell an edit: drawn as one diff. */
const EDIT_PAIR = ['old_string', 'new_string'] as const;

/** The fields as HTML: the short ones first, a line each, then the long ones
 *  as blocks, each group in the order the document gives, every one with a
 *  copy button. An `old_string` and `new_string` pair is drawn as the diff
 *  between them, the way git shows an edit. */
export function drawStructured(st: Structured, s: Pick<ViewStrings, 'copy'>): string {
  const copy = copyButton(s);
  const one = (f: StructuredField): string => {
    const tail = f.cut ? '<span class="acv-field-cut">…</span>' : '';
    if (f.block) {
      return `<span class="acv-field block"><span class="acv-field-key">${esc(f.key)}</span>${copy}<span class="acv-field-text">${esc(f.value)}${tail}</span></span>`;
    }
    const value = f.value === '' ? '<span class="acv-faint">""</span>' : esc(f.value);
    return `<span class="acv-field"><span class="acv-field-key">${esc(f.key)}</span><span class="acv-field-value">${value}${tail}</span>${copy}</span>`;
  };
  // A side the document clipped is not the whole text, and a diff against a
  // prefix would show edits that may never have happened: both sides are
  // drawn as they are, each cut where it was cut.
  const pair = editPair(st);
  const rest = pair ? st.fields.filter((f) => !EDIT_PAIR.includes(f.key as (typeof EDIT_PAIR)[number])) : st.fields;
  const inline = rest.filter((f) => !f.block);
  const blocks = rest.filter((f) => f.block);
  const side = (f: StructuredField): string =>
    `<span class="acv-copy-src" hidden>${esc(f.value)}</span>${copyButton(s, `${s.copy} ${f.key}`)}`;
  const diff = pair
    ? `<span class="acv-field block"><span class="acv-field-key">${EDIT_PAIR.join(' → ')}</span>${pair.map((f) => `<span class="acv-field acv-copy-side">${side(f)}</span>`).join('')}<pre class="acv-diff acv-edit-diff">${lineDiff(pair[0].value, pair[1].value)
        .map((r) => `<div class="acv-diff-line ${r.kind}">${esc((r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ') + r.text)}</div>`)
        .join('')}</pre></span>`
    : '';
  return `<span class="acv-fields">${[...inline, ...blocks].map(one).join('')}${diff}</span>`;
}

function editPair(st: Structured): [StructuredField, StructuredField] | null {
  const before = st.fields.find((f) => f.key === EDIT_PAIR[0]);
  const after = st.fields.find((f) => f.key === EDIT_PAIR[1]);
  return before && after && !before.cut && !after.cut ? [before, after] : null;
}

/** The copy button, titled with what it copies. */
export function copyButton(s: Pick<ViewStrings, 'copy'>, title = s.copy): string {
  return `<button type="button" class="acv-copy" data-copy title="${esc(title)}">${esc(s.copy)}</button>`;
}

/** Copy the text the button stands for: its field's, or the whole text of
 *  the block it is scoped to. Says so on the button for a moment. */
export function copyField(btn: HTMLElement, copied: string): void {
  const text = btn.closest('.acv-field, [data-copy-scope]')?.querySelector('.acv-copy-src, .acv-field-text, .acv-field-value, .acv-copy-text');
  if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
  const value = text.querySelector('.acv-faint')
    ? ''
    : Array.from(text.childNodes)
        .filter((node) => !(node instanceof HTMLElement && node.classList.contains('acv-field-cut')))
        .map((node) => node.textContent ?? '')
        .join('');
  void navigator.clipboard.writeText(value).then(() => {
    const was = btn.textContent;
    btn.textContent = copied;
    btn.classList.add('done');
    setTimeout(() => {
      btn.textContent = was;
      btn.classList.remove('done');
    }, 1400);
  });
}

export interface TextBody {
  html: string;
  /** Lines the body takes when drawn, for a card's clamp to judge. */
  lines: number;
  /** The document's clip fell inside the object. */
  cut: boolean;
  /** Drawn as fields, each with its own copy button; otherwise the text is
   *  one `.acv-copy-text` for a copy button scoped to the whole block. */
  fields: boolean;
}

/** A step's input or result as it is best read: the fields of a tool call's
 *  object, or the text itself for everything else. */
export function textBody(text: string, kind: string, s: Pick<ViewStrings, 'copy'>): TextBody {
  const st = kind === 'tool' || kind === 'agent.call' ? structure(text) : null;
  if (!st) return { html: `<span class="acv-copy-text">${esc(text)}</span>`, lines: text.split('\n').length, cut: false, fields: false };
  const lines = st.fields.reduce((n, f) => n + (f.block ? f.value.split('\n').length + 1 : 1), 1);
  return { html: drawStructured(st, s), lines, cut: st.cut, fields: true };
}

/** The note for a text the document clipped, when it says how long the whole
 *  part is; empty otherwise. */
export function clipNote(ctx: Pick<ViewContext, 's' | 'f'>, text: string, bytes: number | undefined): string {
  if (!bytes) return '';
  const shown = new TextEncoder().encode(text).length;
  return bytes > shown ? esc(fill(ctx.s.fullTextNote, { shown: ctx.f.number(shown), total: ctx.f.number(bytes) })) : '';
}
