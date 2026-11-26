<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements.  See the NOTICE file distributed with
this work for additional information regarding copyright ownership.
The ASF licenses this file to You under the Apache License, Version 2.0
(the "License"); you may not use this file except in compliance with
the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# OTLP Pairing

**OTLP pairing** (`/operate/otlp-pairing`, in the sidebar after Trace inspect) shows how OAP turns an OpenTelemetry call into a network alias, so the edge from a caller to the peer it dialed lands on the service that answered. It needs Apache SkyWalking 11.2 or later, with its `trace-pairing-debugging` module, which Cluster status checks as it does the other admin modules; against an older OAP, the module's row reads unreachable and the page shows a banner that it needs SkyWalking 11.2 or higher.

This is not a TAL rule's run. A rule only asks for its pairing of a call, the caller or the callee side, with `prepareNetworkAlias` (the caller: its service and the peer it dialed) or `buildNetworkAlias` (the callee: its service), and the [Live Debugger's TAL tab](live-debugger.md#the-tal-debugger-view) shows that request and whether the pairing was sent. What happens next is OAP's own work:

1. The pairing goes, routed by trace id, to the OAP node that owns the trace.
2. That node keeps the pairings for 60 seconds, and matches a callee to the caller span that is its parent.
3. On a match, the callee rule's `buildNetworkAlias` expression composes the alias address, and the alias is pushed.
4. Every OAP node reloads the stored aliases every 10 seconds, and a later run reads them with `resolveNetworkAlias`.

## The capture

There are no sessions. Each OAP node has one capture, shared by everyone, as each node owns a share of the traces. Press **start capture** to turn it on on every node; it runs as long as it is read, and this page reads it every two seconds while it is open, so it stops a minute after the last reader closes the page, or when anyone presses **stop**. A page opened while a capture runs shows it and keeps it running. A stop, or that expiry, releases what OAP found: OAP keeps nothing between two captures.

OAP pairs only a sample of the calls: those of the traces in its `pairingSamplePercent` share, picked by trace id, 25 percent by default (`SW_TRACE_TAL_PAIRING_SAMPLE_PERCENT`, in the `trace-analyzer` module). The capture sees the pairings OAP makes, so its counts, and the peers and servers it lists, cover the sampled traces only: a call whose traces all fall outside the share is not listed.

## Live capture and History

The page has two tabs. Each capture, from its start to its stop, is a round, under the id OAP gives it: a node that is off joins the round of the node that took the start, a node already capturing keeps its own, and a read sums only the nodes in its round; the summary marks a node outside it, not answering, off or in another round. While a round runs, the page saves what it reads in this browser, every time it changes and once more just before a **stop**, as the Live Debugger saves its captures; it keeps the latest 10 rounds. A read that covers fewer of the round's nodes than the saved one, as when a node does not answer, does not replace it; the line beside the controls names the nodes the latest read found outside the round, not answering or in another round. When the read just before a stop fails, the page says so, and the round keeps its earlier read.

**Live capture** holds the controls and shows the running round, its summary reading **capturing round, since** its start. Once it stops, the tab keeps showing that round, as saved, until the next start, so a stop loses nothing on screen. A page just opened shows no round until one runs: the rounds captured before are in History. **History** stays open to the saved rounds even when OAP does not serve the capture.

**History** lists the saved rounds, the newest first, each with its start and its last read, its count of calls matched, and how many OAP nodes its saved read covered; one that may still run, here or in another tab, says so. Rounds start folded. Click a round to open it in a panel right under its row, in the same view as the live capture, its summary reading **captured round** with its start and its last read; click it again to fold it. One round is open at a time. ✕ deletes a round, and **clear saved rounds** the rounds that have ended, each once you confirm, as deleted rounds cannot be brought back; the clear is off while none has ended. One browser tab is meant to hold a round: tabs see each other's saves and deletes, but two tabs saving one round at once may keep either's latest read.

A round's summary bar counts, over the nodes in the round, since it started:

- **pairings received** — the caller and the callee pairings the nodes received;
- **calls matched** — the calls whose two pairings met;
- **unmatched** — pairings that left the buffer without their other side: `expired` after 60 seconds, `evicted` from a full buffer, or `replaced` by a later pairing of the same span;
- **OAP nodes** — how many of the nodes the read asked are in the round; hover or click it for each node, by its admin address as OAP's cluster lists it, with the calls it matched, or why it is not counted: `unreachable`, `off`, or in `another round`.

## What the round found

One list holds what the round found, the most recent first, each row of a kind:

- **matched** — a peer a caller dialed, with the server it was matched to: the callee service of its latest match.
- **unmatched caller** — a peer whose caller pairings left the buffer without meeting a callee pairing.
- **unmatched callee** — a server whose callee pairings left the buffer without meeting a caller pairing.

Each row shows the callers that dialed the peer, the latest five, or `—` for an unmatched callee, whose caller never reported; its count, of calls for a match and of pairings otherwise; its detail; and the OAP nodes that hold it, by their admin address, one a line. Hovering its kind shows when it was last seen. The detail depends on the kind:

- for a match, beside an `alias` tag, the alias its latest match composed: the peer address, which now represents the matched server, `e2e-tal-backend:8080 represents e2e-tal-backend`. The alias is keyed by the caller as well as the address, so the address the rule composed, `e2e-tal-frontend->e2e-tal-backend:8080`, shows on hover; an address composed in another form reads whole; and, in yellow, the server it was matched to before when a later match, or another node, matched it to another server;
- for a match none of whose calls registered its alias, beside a yellow `alias` tag, the address as composed and why OAP did not register it, by OAP's outcome counts: `tooLong` when the address is longer than the alias column's 200 characters, `noService` when the callee names no service, `composed` when the node has no alias registrar; `not registered: tooLong 3`. A match any of whose calls registered reads as above.
- for an unmatched callee, beside a `rule` tag, the rules whose `buildNetworkAlias` sent its pairings, the latest five: a callee pairing carries its rule, which composes the address when the caller's pairing meets it;
- for an unmatched row, why its pairings left, and a list of its latest five trace ids: picking one opens the trace through TraceQL over the OTLP spans OAP stores as they arrived (`otlpTraceStorage: otlp`, the default).

The chips above the list narrow it to one kind, each with its count, and the filter searches all of it by peer, service, caller, rule, trace id, OAP node, or why pairings left (`expired`, `evicted`, `replaced`); the list reads 50 rows a page, the pages cutting what the chips and the filter leave. Each node keeps the 1000 entries of each kind it saw most recently. Counts read compact as a capture grows, `12k` or `7.8m`, the exact number on hover. Times read in the browser's local time.

## Access

Watching the capture needs `live-debug:read`, and starting or stopping it `live-debug:write`, as for the Live Debugger; the Roles matrix lists the page in the **Live debugger · Capture history · OTLP pairing** row. OAP serves it from its `trace-pairing-debugging` admin module, on by default from 11.2; see [Required OAP Modules](../compatibility/required-modules.md).
