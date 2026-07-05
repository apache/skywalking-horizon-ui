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
<script setup lang="ts">
defineProps<{ name: IconName; size?: number }>();

export type IconName =
  | 'dash'
  | 'topo'
  | 'metric'
  | 'trace'
  | 'log'
  | 'alert'
  | 'prof'
  | 'svc'
  | 'ep'
  | 'event'
  | 'set'
  | 'search'
  | 'chev'
  | 'caret'
  | 'bell'
  | 'plus'
  | 'share'
  | 'refresh'
  | 'more'
  | 'clock'
  | 'filter'
  | 'expand'
  | 'download'
  | 'star'
  | 'flame'
  | 'sky'
  | 'user'
  | 'mesh'
  | 'db'
  | 'cluster'
  | 'web'
  | 'fn'
  | 'cache'
  | 'topic'
  | 'snowflake'
  | 'pin'
  | 'ai'
  | 'external'
  | 'close'
  | 'trash';
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    :width="size ?? 14"
    :height="size ?? 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
  >
    <template v-if="name === 'dash'">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </template>
    <template v-else-if="name === 'topo'">
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="14" r="2" />
      <circle cx="5" cy="20" r="2" />
      <circle cx="19" cy="20" r="2" />
      <path d="M6.5 7.5L10.5 13M17.5 7.5L13.5 13M10.5 15L6.5 19M13.5 15L17.5 19" />
    </template>
    <template v-else-if="name === 'metric'">
      <path d="M3 17l5-7 4 4 4-8 5 11" />
    </template>
    <template v-else-if="name === 'trace'">
      <path d="M3 6h10M3 10h14M3 14h7M3 18h12" />
    </template>
    <template v-else-if="name === 'log'">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </template>
    <template v-else-if="name === 'alert'">
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4M12 17v.5" />
    </template>
    <template v-else-if="name === 'prof'">
      <path d="M3 20h18M5 20v-6M9 20v-9M13 20v-4M17 20v-12M21 20v-7" />
    </template>
    <template v-else-if="name === 'svc'">
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <circle cx="7" cy="7" r="0.8" fill="currentColor" />
      <circle cx="7" cy="17" r="0.8" fill="currentColor" />
    </template>
    <template v-else-if="name === 'ep'">
      <path d="M4 12h6M14 12h6" />
      <circle cx="12" cy="12" r="2" />
      <path d="M4 12a8 8 0 0116 0M4 12a8 8 0 0016 0" opacity=".4" />
    </template>
    <template v-else-if="name === 'event'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </template>
    <template v-else-if="name === 'set'">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
      />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-3.5-3.5" />
    </template>
    <template v-else-if="name === 'chev'">
      <path stroke-width="2" d="M9 6l6 6-6 6" />
    </template>
    <template v-else-if="name === 'caret'">
      <path stroke-width="2" d="M6 9l6 6 6-6" />
    </template>
    <template v-else-if="name === 'bell'">
      <path d="M6 8a6 6 0 0112 0v5l1.5 3H4.5L6 13z" />
      <path d="M10 19a2 2 0 004 0" />
    </template>
    <template v-else-if="name === 'plus'">
      <path stroke-width="2" d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'share'">
      <path d="M4 12v6a2 2 0 002 2h12a2 2 0 002-2v-6M16 6l-4-4-4 4M12 2v13" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M20 11A8 8 0 006 5l-2 2M4 13a8 8 0 0014 6l2-2M4 4v5h5M20 20v-5h-5" />
    </template>
    <template v-else-if="name === 'more'">
      <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </template>
    <template v-else-if="name === 'filter'">
      <path d="M3 5h18l-7 9v6l-4-2v-4z" />
    </template>
    <template v-else-if="name === 'expand'">
      <path d="M9 3H3v6M21 9V3h-6M15 21h6v-6M3 15v6h6" />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
    </template>
    <template v-else-if="name === 'star'">
      <path d="M12 3l2.8 6 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.7 3 1.1-6.5L2.7 9.9 9.2 9z" />
    </template>
    <template v-else-if="name === 'flame'">
      <path d="M12 3c1 4 6 5 6 11a6 6 0 11-12 0c0-3 2-4 2-7 2 2 3 3 4 0z" />
    </template>
    <template v-else-if="name === 'sky'">
      <path
        fill="currentColor"
        stroke="none"
        d="M3 14c4-3 8-3 12-1 3 1.4 5 .5 6-1-1 5-4 8-9 8-4 0-7-2-9-6z"
        opacity=".95"
      />
      <path
        fill="#fff"
        stroke="none"
        d="M5 10c3-2 7-2 11 0 3 1.3 5 .6 6-1-1 3.6-4 6-8 6-4 0-7-1.6-9-5z"
        opacity=".22"
      />
    </template>
    <template v-else-if="name === 'user'">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </template>
    <template v-else-if="name === 'mesh'">
      <!-- Istio mark — true two-sail composition rendered as FILLED
           shapes (the only filled icon in the set). Matches the
           project's mark: a tall right main sail, a smaller left
           jib, a narrow vertical mast gap between them, and a
           trapezoidal hull below. The brand colour is blue; per
           user request we paint it in a neutral gray. Drawn with
           right-triangle geometry so the mast edges are exactly
           vertical (matches the canonical mark). -->
      <polygon points="13,1 13,19 21.5,19" fill="#8a8f96" stroke="none" />
      <polygon points="11,7 11,19 3,19" fill="#8a8f96" stroke="none" />
      <polygon points="2.5,20 21.5,20 18.5,22.5 5.5,22.5" fill="#8a8f96" stroke="none" />
    </template>
    <template v-else-if="name === 'db'">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </template>
    <template v-else-if="name === 'cluster'">
      <!-- Kubernetes helm wheel — 7-pointed outline + spokes + hub.
           Heptagon vertices computed from a circle of r≈9 around
           (12,12). The brand color is project blue; we render only
           the outline so the icon style stays consistent. -->
      <path d="M12 3 L19.6 7 L20.7 15.6 L15 21 L9 21 L3.3 15.6 L4.4 7 Z" />
      <path d="M12 3 L12 9 M19.6 7 L14.5 10 M20.7 15.6 L14.5 13.5 M15 21 L13 13.5 M9 21 L11 13.5 M3.3 15.6 L9.5 13.5 M4.4 7 L9.5 10" />
      <circle cx="12" cy="12" r="2.4" />
    </template>
    <template v-else-if="name === 'web'">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
    </template>
    <template v-else-if="name === 'fn'">
      <path d="M6 4h8l4 4v12H6z" />
      <path d="M14 4v4h4" />
    </template>
    <template v-else-if="name === 'cache'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </template>
    <template v-else-if="name === 'topic'">
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4v16" opacity="0.6" />
    </template>
    <template v-else-if="name === 'snowflake'">
      <path d="M12 3v18M3 12h18M5 5l14 14M19 5L5 19" />
      <path d="M9 6l3-3 3 3M15 18l-3 3-3-3M6 9L3 12l3 3M18 9l3 3-3 3" />
    </template>
    <template v-else-if="name === 'pin'">
      <!-- Pushpin — "lock this entity into the comparison set". -->
      <path d="M9 3h6l-1 5 3 3v2H7v-2l3-3z" />
      <path d="M12 13v8" />
    </template>
    <template v-else-if="name === 'ai'">
      <!-- AI-assistant mark — a large four-point sparkle plus a small one. -->
      <path fill="currentColor" stroke="none" d="M10 4 Q11.7 9.3 17 11 Q11.7 12.7 10 18 Q8.3 12.7 3 11 Q8.3 9.3 10 4 Z" />
      <path fill="currentColor" stroke="none" d="M18.5 3.2 Q19.3 5.5 21.6 6.3 Q19.3 7.1 18.5 9.4 Q17.7 7.1 15.4 6.3 Q17.7 5.5 18.5 3.2 Z" />
    </template>
    <template v-else-if="name === 'external'">
      <!-- Open in a new tab / external link. -->
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h5" />
    </template>
    <template v-else-if="name === 'close'">
      <path stroke-width="2" d="M6 6l12 12M18 6L6 18" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M5 7h14M10 7V5h4v2M8 7l1 13h6l1-13" />
      <path d="M10.5 11v5M13.5 11v5" />
    </template>
  </svg>
</template>
