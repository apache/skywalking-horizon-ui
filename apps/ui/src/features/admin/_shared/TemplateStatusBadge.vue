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
<!--
  Per-row sync chip for the template admin lists. Five visual states
  match `TemplateStatus`:
    synced            quiet green tick — bundled == OAP
    diverged          amber dot — operator edited remote
    disabled          red strikethrough chip — hidden from render
    remote-only       blue chip — operator added remote with no bundled
    bundled-fallback  gray chip — remote absent (OAP unreachable or row
                                   never synced)

  `conflictIds` is orthogonal to all five: it renders an extra solid red
  DUPLICATE chip when OAP stores the same template name on more than one
  enabled record. The sync status of such a row describes only the copy
  Horizon happens to render, so the duplicate marker sits beside it
  rather than replacing it.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { TemplateStatus } from '@/api/scopes/configs';

defineProps<{
  status: TemplateStatus | null;
  /** Every enabled OAP record id for this name, when there is more than
   *  one. Omitted / empty for the normal single-record case. */
  conflictIds?: string[] | null;
}>();

const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <span v-if="status" class="tsb" :class="`tsb--${status}`" :title="title(status)">
    {{ label(status) }}
  </span>
  <span
    v-if="conflictIds && conflictIds.length > 0"
    class="tsb tsb--conflict"
    :title="t('Duplicated on OAP — {n} enabled records carry this name ({ids}). Horizon renders the lowest-id copy and changes nothing on its own.', { n: conflictIds.length, ids: conflictIds.join(', ') })"
  >{{ t('duplicate') }}</span>
</template>

<script lang="ts">
function label(s: TemplateStatus): string {
  switch (s) {
    case 'synced': return 'synced';
    case 'diverged': return 'diverged';
    case 'disabled': return 'disabled';
    case 'remote-only': return 'remote-only';
    case 'bundled-fallback': return 'bundled';
    default: return '?';
  }
}
function title(s: TemplateStatus): string {
  switch (s) {
    case 'synced': return 'Bundled and OAP-stored copy are byte-identical.';
    case 'diverged': return 'OAP-stored copy differs from bundled. OAP wins at render time.';
    case 'disabled': return 'Template is disabled on OAP. Hidden from render until re-enabled.';
    case 'remote-only': return 'OAP has this template but bundled does not. OAP is the only source.';
    case 'bundled-fallback': return 'Shipped with Horizon but not synced to OAP yet. It is NOT rendered as-is — push it (or let boot-seed run) to publish; until then the page uses built-in defaults, and blocks if OAP’s template store is unreachable.';
    default: return '';
  }
}
export default { label, title };
</script>

<style scoped>
.tsb {
  display: inline-block;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 8px;
  text-transform: uppercase;
  border: 1px solid var(--sw-border, #2a2f38);
  background: rgba(255, 255, 255, 0.03);
  color: var(--sw-text-muted, #8a93a0);
}
.tsb--synced {
  color: var(--sw-ok, #2e7d4e);
  border-color: rgba(46, 125, 78, 0.4);
  background: rgba(46, 125, 78, 0.08);
}
.tsb--diverged {
  color: var(--sw-warn, #b88500);
  border-color: rgba(184, 133, 0, 0.5);
  background: rgba(184, 133, 0, 0.12);
}
.tsb--disabled {
  color: var(--sw-danger, #c0392b);
  border-color: rgba(192, 57, 43, 0.5);
  background: rgba(192, 57, 43, 0.08);
  text-decoration: line-through;
}
.tsb--remote-only {
  color: var(--sw-info, #3a8ed0);
  border-color: rgba(58, 142, 208, 0.5);
  background: rgba(58, 142, 208, 0.08);
}
.tsb--bundled-fallback {
  color: var(--sw-text-muted, #8a93a0);
}
/* Solid, not outlined — the other five chips report a state the operator
 * chose; this one reports an ambiguity they have to go fix on OAP, and
 * has to win the row at a glance. Same fill as the CONFLICT banner chip. */
.tsb--conflict {
  color: #fff;
  background: var(--sw-danger, #c0392b);
  border-color: var(--sw-danger, #c0392b);
  font-weight: 700;
}
</style>
