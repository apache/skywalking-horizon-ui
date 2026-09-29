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
# Alarm Pages

An alarm page is a view of the alarms a reader may read: the **Active** count, one tile per pinned layer, the timeline, the incident list and the detail panel — the [Alarms](../operate/alarms.md) page, with its own tiles.

Every deployment has the **default** alarm page at `/alarms`, shown in the sidebar as **Alarms**. You can add **named pages**, for example one per team, each pinning the layers — and, within a layer, the service groups — that team watches. A named page is its own row in the sidebar, right after **Alarms**, and opens at `/alarms/<id>`.

## What a page shows

Which alarms a reader may see is decided by their `alarms:read` permission alone; no page adds to them.

- **Alarms**, the default page, shows all of them: a tile per pin, an **Other** tile for the alarms no pin covers, and a tab above the list for every other layer with an active alarm.
- A **named page** shows only the alarms its pins cover. It has no **Other** tile and no extra layer tabs, and its filter row offers only its own layers and the services its pins cover. So **Payments on-call** pinning `GENERAL[payments]` lists, and lets you filter by, the payments services only — for a reader who may read every GENERAL service too.

A named page narrows what a reader sees; it never widens it. To keep a team to its own alarms everywhere, limit its role, for example `alarms:read@GENERAL[payments]` — see [Roles and Permissions](../access-control/rbac.md).

## Pins

A pin is a layer, optionally narrowed to OAP service groups in it, written the way a role limits a permission:

| Pin | Tile | Counts an alarm when… |
|---|---|---|
| `GENERAL` | General | a service the alarm concerns is in the GENERAL layer |
| `GENERAL[payments]` | payments · General | a service it concerns is in GENERAL and in the `payments` group |
| `GENERAL[payments, risk]` | payments, risk · General | … in either group |
| `GENERAL[-]` | no group · General | … a GENERAL service that has no group |

The services an alarm concerns are the service it is raised on — for an instance or an endpoint, the service that owns it — and, for a relation, the service at either end. A service group is the part of a service's name before `::` (`payments::checkout` is in `payments`). An alarm counts under every tile it matches, so the tiles can add up to more than **Active**.

## Who sees which page

- **Alarms** (the default page) is shown to every role that holds `alarms:read`, on any layer.
- A **named page** is shown to a role that reaches at least one of its pins: `alarms:read` without a layer reaches every pin (a Platform monitoring layer also needs `cluster:read`); `alarms:read@GENERAL` reaches every `GENERAL` pin; `alarms:read@GENERAL[payments]` reaches `GENERAL` and `GENERAL[payments]`, but not `GENERAL[risk]`.
- On any page, the pins a role cannot reach are left out, and a note says how many. A pin with several groups keeps the groups the role reaches.
- An address of a page the role is not shown reads "This alarm page does not exist or is not available to you."

## Setting up pages

Alarm pages are set up at **Dashboard setup → Alarm pages** (`/admin/alert-page-setup`). Viewing it needs `alarm-setup:read`; saving, adding and deleting need `alarm-setup:write`. Named pages are stored on OAP, so they exist only with `templates.mode: live`; in `readonly` mode there is only the default page.

The page lists **Alarms (default)** first, then the named pages. Select one to edit it:

- **Page** — named pages only: the **Title** shown in the sidebar and as the page heading, and the **Order** among the named pages (lower first, then by title).
- **Pinned** — up to 8 pins, in tile order. Add a pin by choosing a layer — the layers your own role sees in the sidebar are offered, whether or not they have services now — and, optionally, one or more service groups. The groups of the layer's services your role reads are suggested; you may type another, and a group none of them has at the moment is saved with a warning. A group whose name contains `,`, `[` or `]`, or is `-`, cannot be written in a pin.
- **Default time window** — the window the page opens on: 20 minutes, 2 hours or 4 hours. A named page can also take the default page's.
- **Overview alarms widget** — default page only: the **Fetch cap**, how many alarms an overview **Alarms** widget reads.

**+ New page** asks for an id and a title. The id becomes the page's address, `/alarms/<id>`: lowercase letters, digits, `-` and `_`, and neither `default` nor `page-setup`. **Delete** removes a named page from every reader's sidebar; its id cannot be given to a new page afterwards. The default page cannot be deleted.

The default page's window also sets the window of the alarm count in the sidebar and the top bar.

## Stored format

Each page is one OAP UI template record. The admin page reads and writes these; the fields are listed here for reference and for authoring outside the UI.

The default page, `horizon.alert.default`:

```json
{
  "pinnedLayers": ["GENERAL", "MESH"],
  "defaultWindowMs": 1200000,
  "overviewAlarmsLimit": 200
}
```

A named page, `horizon.alert.<id>`:

```json
{
  "id": "payments",
  "title": "Payments on-call",
  "order": 10,
  "pinnedLayers": ["GENERAL[payments]", "MESH[payments]"],
  "defaultWindowMs": 7200000
}
```

| Field | Page | Notes |
|---|---|---|
| `id` | named | Equals the record's `<id>`. Lowercase letters, digits, `-`, `_`; at most 64 characters; not `default` or `page-setup`. |
| `title` | named | Sidebar label and page heading, shown as written. At most 64 characters. |
| `order` | named | Optional, 0 to 1000000, default 1000. Lower first; equal orders sort by title. |
| `pinnedLayers` | both | Pins as described above. At most 8; a named page needs at least one, and no pin twice. |
| `defaultWindowMs` | both | `1200000` (20 minutes), `7200000` (2 hours) or `14400000` (4 hours). Optional on a named page, which then opens on the default page's window. |
| `overviewAlarmsLimit` | default | 10 to 500: how many alarms an overview **Alarms** widget reads. |
