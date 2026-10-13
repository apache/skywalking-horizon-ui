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
# Invalid Stored Templates

Horizon reads every dashboard template from OAP's template store: the layer dashboards, the overview dashboards, the alarm pages, the 3D map configuration, the theme and default time window, and the per-language translations. Horizon checks everything it publishes there, but the store can also be written without going through Horizon — by another tool, by hand, or by a Horizon that did not check as much. A stored template can therefore hold content that would break the pages built from it: a missing section every page relies on, a list where an object belongs, a widget the dashboard grid cannot run.

Horizon checks each stored template when it reads it. One that would break its pages is **invalid**, and an invalid template is never served.

## What happens to an invalid template

- **Nobody is served it.** The rest of Horizon is unaffected: other layers, overviews and pages render normally, and nothing reports OAP as unreachable because of it.
- **Viewers see nothing of it.** An invalid layer, overview dashboard or alarm page is left out of every menu and listing, as a disabled one is, and opening its address directly shows the usual "not found" page. For a layer, a user who can read layer templates is told instead that its template is invalid, with a link to Layer dashboards.
- **Settings fall back to the built-in defaults.** An invalid theme or default time window is replaced by the shipped default, an invalid default alarm page by the built-in alarm page layout, and an invalid translation by English for that language. The 3D map says its configuration is invalid instead of drawing.
- **The record is kept exactly as stored.** Horizon never repairs, replaces or removes it on its own.

## Where invalid templates are reported

Only on the **Dashboard setup** pages, and only to users who can read that kind of template:

- **The sidebar** shows a red warning icon with a count on the row that owns the template — Layer dashboards, Overview templates, Translations, Alarm pages, 3D Infra Map or Global defaults.
- **The page** opens with a red banner listing each invalid template it owns, with its OAP record id and the number of problems.
- **The picker** marks the template with an **INVALID** chip, and the **Invalid** filter narrows the list to them.

Each entry in the banner offers three actions:

- **Show problems** opens the stored template with every problem underlined in red where it sits, beside a list of the problems and what is wrong with each. Click a problem to jump to it.
- **Download** saves the stored template as a JSON file, in the same format as **Export**.
- **Disable** turns the record off on OAP, after asking you to confirm. See [Disabled templates](#disabled-templates).

## Valid or invalid, enabled or disabled

Two separate facts describe every template stored on OAP, and each page shows both:

- **Valid or invalid** is about the content: whether the pages can be built from it.
- **Enabled or disabled** is about the record: whether it is switched on.

| | Enabled | Disabled |
|---|---|---|
| **Valid** | Served to everyone, and editable. | Served to nobody. **Enable** brings it back as it was. |
| **Invalid** | Served to nobody, and reported in the red banner. Locked: only **Show problems**, **Download** and **Disable**. | Served to nobody. **Enable** brings it back as it was — invalid, and reported again. |

A record nobody has looked at is never written over: an enabled invalid template has to be disabled before the template can be configured again.

## Disabled templates

OAP has no hard delete. **Disable** — and **Delete** on the pages that offer it — switches the record off: it stays in OAP's store with its content, and nobody is served it. A disabled template can always be turned back on.

Each Dashboard setup page lists the disabled templates it owns under the banner, collapsed to a count until you open it. Each entry shows its OAP record id and, when its content is invalid, an **invalid** marker with **Show problems** and **Download**. **Enable** turns the record back on with the content it holds, after asking you to confirm. Enabling an invalid record brings it back invalid: it is reported in the red banner again, and served to nobody.

A disabled template can also be configured again without enabling the old record first. A new one written from the page — published with **Check diff & push**, chosen and saved on Global defaults, or an alarm page created under the same id — goes into the same record and turns it on. Invalid content is never used as a starting point: the editor starts from the shipped default, or a blank where Horizon ships none.

## Import is checked before anything is staged

**Import** on every Dashboard setup page runs the same checks **Check diff & push** runs, before the file becomes a local draft. A file that fails them is not imported: the same problems dialog opens on the file itself, with each problem underlined, and nothing is staged. A file that is not valid JSON is shown with the point where it stops being JSON.

## What counts as invalid

A stored template is refused only for what would break the pages built from it:

- a field of the wrong type, or a required section that is missing, anywhere in the template;
- any defect in a layer's dashboard widgets or service-list columns — these are sent to OAP queries as they are, so one bad widget would fail its whole dashboard;
- for alarm pages and the 3D map, anything their own editors would refuse to publish;
- for a translation, a value it is not allowed to change — anything other than the translatable text, such as a layer key, a widget type or a query;
- for any of them, a record that is not valid JSON or is not a Horizon template at all.

Fields Horizon does not know are not refused. A newer Horizon may write fields an older one does not recognize; both read the same store, so those fields are ignored rather than taking the template away from the older one. Limits the pages already cope with — a widget wider than the grid, a menu order naming a page that no longer exists — are not refused either.

## Troubleshooting

- **A template turned invalid after an upgrade or a script ran.** Something wrote it outside Horizon. **Show problems** names each field; fix the file you downloaded and import it after disabling the stored record, or start again from the shipped default.
- **The warning count stays after you disabled one.** The sidebar count follows the template store, which Horizon reads at least every 30 seconds; reload the page to see it at once.
- **A translation shows in English.** Its stored translation is invalid, or disabled. Enable it from the disabled templates on the Translations page, or translate that language again.
- **A fixed file cannot be imported over an invalid template.** Disable the stored record first; the page then accepts the import, and publishing it turns the record back on with the new content.

See [Layer Dashboard Templates](layer-templates.md), [Overview Templates](overview-templates.md), [Alarm Pages](alarm-pages.md), [Languages and Translations](i18n.md) and [Themes and Global Defaults](global-defaults.md) for the pages themselves.
