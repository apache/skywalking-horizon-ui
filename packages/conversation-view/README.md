# @skywalking-horizon-ui/conversation-view

Renders one AI agent conversation — an `asz.view` 1.0 document, as the [SkyWalking AI Sessionizer](https://github.com/apache/skywalking-ai-sessionizer) assembles it and the SkyWalking OAP reproduces it — into a host element: the transcript of talks, the flow timeline of one execution stream, and an inspector that answers where every step came from.

No framework, no network. The host parses and version-checks the document and hands it in; the renderer fetches nothing. Every colour and font is a Horizon design token, so the host chooses the theme by setting `data-theme` on `<html>`.

Horizon's conversation page wraps this in one small Vue component. The AI Sessionizer's own viewer embeds the same build, made from a pinned Horizon commit, so the two hosts draw a conversation identically.

A document that carries `workspace_changes` (Sessionizer 0.3.0 and later) also gets the changes drawn: a mark on each tool card that changed files, or an eye for a shell command the asz plugin classed read-only and did not scan, opening inline to the changed files and their diffs; a **Changes** tab in the inspector with each record's provenance; and a panel over the whole conversation grouped by workspace root and file. Records are grouped by root and producer and never merged, and the counts are of unique files, since two overlapping windows each net their own span. A document without the key draws as before.

A tool call's input and result are drawn as the fields they hold when they are a JSON object, with the encoder's escapes decoded and a note where the Sessionizer's 2,000-byte clip fell; any other text is drawn as it is. Fields carry a copy button, a result that is one text has one on its label, an edit's old and new text are drawn as one diff, and the inspector can pop out into a panel over the whole page, four fifths of it, behind a scrim that docks it again.

## Using it

```ts
import { mountConversationView, isSupportedDocument, makeFormatter } from '@skywalking-horizon-ui/conversation-view';
import '@skywalking-horizon-ui/conversation-view/style.css';

const doc = await (await fetch(url)).json();
if (!isSupportedDocument(doc)) throw new Error(`unknown document ${doc.format} ${doc.version}`);

const view = mountConversationView(document.getElementById('conversation')!, {
  document: doc,
  formatter: makeFormatter(navigator.language),     // or EN_US_FORMATTER for one rendering everywhere
  state: { talk: params.get('talk') ?? undefined, step: params.get('step') ?? undefined },
  onStateChange: (s) => history.replaceState(null, '', `?${new URLSearchParams(s)}`),
});
view.destroy();
```

| Option | Meaning |
|---|---|
| `document` | The parsed `asz.view` document. |
| `strings` | Any of the renderer's texts, translated. English is the default for every key. Node kinds, relation types, qualities and states from the document are never translated. |
| `formatter` | How times, counts and spans are written. `EN_US_FORMATTER` is the Sessionizer's fixed rendering; `makeFormatter(locale)` follows a locale. |
| `glossary` | The Sessionizer's glossary, when the host has one. Puts a `?` beside every name it can explain. |
| `loadRecord` | Reads one landed record by `{seq, row}`. Offered in the Evidence tab only when present. |
| `state` / `onStateChange` | The reader's position — talk, step, stream — for a host to keep in its URL and restore. |

## Embedding outside Horizon

The package also builds a **host shell** for a page that does not have Horizon's tokens and fonts of its own:

```
dist/host-shell/horizon-theme.css   the design tokens, the five themes, the base body rules, the font faces
dist/host-shell/fonts/*.woff2       Inter and JetBrains Mono (latin, variable weight; SIL OFL 1.1)
dist/host-shell/themes.json         [{ id, label, appearance }] for every theme
```

Four steps:

1. Load `host-shell/horizon-theme.css`, then `style.css`.
2. Pick a theme id from `themes.json`.
3. Set `<html data-theme="<id>" data-appearance="<appearance>">`.
4. Mount the renderer.

Horizon never loads the host shell; it has the same tokens and fonts already.

## Building

```sh
pnpm --filter @skywalking-horizon-ui/conversation-view build     # dist/conversation-view.{js,css}, index.d.ts, host-shell/
pnpm --filter @skywalking-horizon-ui/conversation-view test:unit
```

The output is deliberately readable — not minified, ASF header kept — because another project commits it after building it from a pinned commit of this repository.
