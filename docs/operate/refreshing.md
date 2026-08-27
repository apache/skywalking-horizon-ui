# Refreshing and the time range

Horizon keeps one clock for the whole page. When it fires, everything on screen that reads from OAP — the service header, the roster, every widget, the alarms card, the maps — is re-read **together, against one time window**, and the round is not finished until the last of them lands. They appear as they arrive rather than all at one instant, so a large comparison fills in over a second or two; what the round guarantees is that they are all answering the same question, not that they land on the same frame.

The controls live at the right of the topbar: a refresh button, a countdown, and a menu behind the caret.

## The countdown

The number is the time until the **next** round, and it is measured from the end of the last one rather than from its start. Time spent loading is therefore never counted against the interval: on a slow backend the gap between rounds genuinely stretches, and two rounds can never overlap.

While a round is out the countdown reads **Refreshing** rather than a number: the next round starts when this one ends, and that instant does not exist yet. The refresh buttons — the topbar's and the one on a map's own toolbar — are disabled meanwhile, because a click then could only ask for what is already being fetched.

A round that has started always finishes. Switching refreshing off, or moving to a page that pauses it, stops the *next* round; it does not abandon the readings already out, which would leave part of the page showing the new values beside the old ones with nothing to say which is which.

If a round takes longer than a minute its requests are cancelled and it gives up, so one wedged screen cannot stop everything else refreshing.

## The loading indicator

The refresh icon becomes a download arrow while requests are in flight, and returns to the circular arrow when they land. It answers a different question from the countdown — *is data arriving right now* rather than *when will it next be asked for* — which is why the two are separate: a page can be loading something you asked for while no round is running at all, and the icon shows that where the countdown has nothing to say about it.

## Turning it off, and choosing the interval

The caret menu carries both, as separate controls:

- **Turn auto-refresh off / on.** Off means off everywhere. Passing through a page that pauses refreshing and coming back does not resume it. Switching it on while a page is paused, or while the tab is in the background, saves the setting without refreshing anything then and there.
- **An interval** — 5s, 15s, 30s, 1m or 5m. Choosing one also switches refreshing on. The interval is remembered while refreshing is off, so switching back on returns to the one you last chose rather than to a default.

The manual refresh button works whether or not auto-refresh is on: it is an explicit request for current data.

## Pages that pause it

Some pages own their own time range and are not driven by the topbar clock at all — traces, logs, browser logs, pod logs, alarms, and the profiling tabs. These answer a question you asked, and swapping their results out from under you on a timer would lose your place. They offer their own refresh where it makes sense. The manual refresh greys out on them, but the interval menu stays available: how often to refresh is a preference that outlives the page you happen to be on.

Refreshing also pauses while a **custom absolute time range** is selected, since there is no rolling window to advance, and while the Smartscape hierarchy overlay is open, so the background stays still as you pan through it.

## When a refresh fails

A failure from the timer is not shown as an interruption — you did not ask for that round, and during an outage every cycle fails, so a message per cycle would paper the screen. Instead a warning icon appears beside the refresh control with a count of failures you have not seen. Opening it lists the last five, newest first: which screen failed, what it was trying to do, the request, and the server's answer. Opening the list clears the count; the entries stay until you clear them.

Secrets are removed before anything is displayed. Query parameters and response fields named as tokens, passwords, secrets, authorization, cookies or API keys are shown as `[redacted]`, and response bodies are truncated.

A failure from something *you* just did — expanding a node on a dependency graph, for instance — appears immediately instead, near where you are looking. It stays while your pointer or keyboard focus is on it, and can be opened for the same detail.

Maps and dashboards are **not** cleared by a failed round. The previous reading stays on screen with the failure reported beside it, which means an empty map always tells you the query genuinely found nothing rather than that a round failed on the way.

The one exception is a layer whose template an administrator has **disabled**. That is not a failure to read something — it is an authoritative answer — so the map is cleared and says so, rather than continuing to show a picture of a layer that has been turned off.

## Changing what you are looking at

Picking a different service, endpoint, depth or time range is a different question, not a refresh. The map or grid clears and says what it is loading — *Loading topology for "checkout"…* — rather than leaving the previous answer under the new heading. Zoom, pan and any nodes you placed are reset with it, because they belonged to the previous picture. A question you asked recently is still re-read from the server rather than answered from what was on screen before.

## Query cold stage

Switching **Query cold stage** re-reads the page as one round. It is not a widening of the current query but a replacement — see [Data retention](data-retention.md) — so the page is never left showing hot and cold answers side by side while it settles.
