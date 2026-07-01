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
# Events

Events are the lifecycle records OAP has collected for a service — agent restarts, Kubernetes events, and other point-in-time facts reported by SkyWalking agents, the SkyWalking CLI, and the Kubernetes Event Exporter. Each event has a name, a type (`Normal` / `Error`), a message, and any reporter-supplied parameters. Events are distinct from alarms: an event records that something happened, not that a threshold was breached — for alerting, see [Alarms](alarms.md).

## Opening the events popout

Events are scoped to a single service and shown in a popout, so you review them without leaving the layer you're on. On any layer drill-down, pick a service in the **service banner** at the top, then click the **Events** button next to the banner's Share control. A modal opens for that service. The button appears only for users with the `events:read` permission (the built-in viewer, maintainer, and operator roles all have it).

## The swimlane — instance × time

The service is fixed (it's in the popout title), so the view has two axes: **each service instance is a row**, and time runs left to right.

- An event with a duration is a **bar** spanning its start to its end.
- An event with no end time is an **instant marker** (a small diamond).
- Each **instance row is a distinct color**, so the rows read apart at a glance.
- **Error** events carry a red ring so they stand out.
- If one instance reports overlapping events, they **stack** into sub-rows so nothing is hidden.
- A service that reports events without an instance shows a single row for the service.

A rolling restart of a large service therefore shows as many bars at the same moment — one per instance — rather than a single summarised line. When a service runs many instances, use the **search box** at the top of the popout to filter the rows to the instances whose name matches.

## Time window and scrolling

The popout owns its own window — `6h`, `1d`, `2d` presets — queried at second precision so the most recent events are never rounded out. Events are stored under OAP's record retention; a window reaching past it simply returns fewer rows.

Scrolling stays inside the popout: the time-axis header stays pinned at the top and the instance column stays pinned at the left. A long range (a multi-day window) gets a wider, horizontally-scrollable canvas so bars keep a legible spacing instead of collapsing together, and the view opens scrolled to the **newest** events — scroll left for history. The time axis marks the **date at day boundaries**, so a range that crosses midnight is unambiguous.

## How many events are shown

The popout fetches the newest events up to a cap (200 by default; configurable under the server's page-size limits). It tells you which case you're in:

- **"N events · all in range shown"** — everything in the window is on screen.
- **"Showing newest N — more available, narrow the range"** — the window holds more than the cap; tighten the time range to reach older events.

## Event detail

Click a bar to open the detail panel:

- **Header** — the event type (`Normal` / `Error`) and name.
- **Scope** — the service, the instance (or "service-scoped"), the endpoint if present, and the layer.
- **Started / Ended / Duration** — for an event with a duration; a single **Time** for an instantaneous event.
- **Message** — the human-readable text the reporter attached.
- **Parameters** — the key/value details carried with the event (for example a Java agent's startup options).

Service names, instance names, messages, and parameter values are shown exactly as OAP reported them.

## Related

- [Alarms](alarms.md) — threshold breaches from OAP's alerting engine, a separate read-only triage surface.
- [Traces](traces.md) and [Logs](logs.md) — the other per-entity triage surfaces.
