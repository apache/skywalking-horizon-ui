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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

/** What `execCommand('copy')` would put on the clipboard: the selected text
 *  of the text area at the moment it runs. jsdom does not move the focus on
 *  `select()`, so the text area is looked up rather than read from the focus. */
function stubExecCommand(result: boolean | 'throws') {
  const copied: string[] = [];
  const exec = vi.fn((command: string) => {
    const area = document.querySelector('textarea');
    if (command === 'copy' && area instanceof HTMLTextAreaElement) {
      copied.push(area.value.slice(area.selectionStart, area.selectionEnd));
    }
    if (result === 'throws') throw new Error('not allowed');
    return result;
  });
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
  return { exec, copied };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('copyText', () => {
  it('uses the Clipboard API where the page has it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { exec } = stubExecCommand(true);
    await expect(copyText('trace-1')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('trace-1');
    expect(exec).not.toHaveBeenCalled();
  });

  it('copies through a selection on a plain HTTP page, which has no Clipboard API', async () => {
    vi.stubGlobal('navigator', {});
    const { copied } = stubExecCommand(true);
    await expect(copyText('trace-1')).resolves.toBe(true);
    expect(copied).toEqual(['trace-1']);
    // The text area goes as soon as the copy is done.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('copies through a selection when the Clipboard API refuses', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const { copied } = stubExecCommand(true);
    await expect(copyText('trace-1')).resolves.toBe(true);
    expect(copied).toEqual(['trace-1']);
  });

  it('says it did not copy when the selection cannot be copied either', async () => {
    vi.stubGlobal('navigator', {});
    stubExecCommand(false);
    await expect(copyText('trace-1')).resolves.toBe(false);
    stubExecCommand('throws');
    await expect(copyText('trace-1')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('gives the focus back to what had it', async () => {
    vi.stubGlobal('navigator', {});
    stubExecCommand(true);
    // A browser's select() moves the focus to the text area; jsdom's does not.
    const select = vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (this: HTMLTextAreaElement) {
      this.focus();
      this.setSelectionRange(0, this.value.length);
    });
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    await copyText('trace-1');
    expect(select).toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    select.mockRestore();
  });
});
