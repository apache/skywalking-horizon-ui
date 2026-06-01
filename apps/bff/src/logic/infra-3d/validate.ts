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
 * Zod-validated shape for `Infra3dConfig`. Used in two places: the
 * generic template save route validates 3D-map content before it reaches
 * OAP, and `resolveEffectiveConfig` re-validates the remote envelope on
 * read so a row hand-edited on OAP into the wrong shape falls back to
 * bundled instead of breaking the map. The schema is deliberately strict
 * (`.strict()` everywhere) — unknown keys are an error, not a forward-compat
 * hint, because saves are full-doc replacements: an extra key is almost
 * always a typo or a stale field from a UI bug.
 *
 * Returns a tagged-union result rather than throwing — the validation
 * paths above all want issue lists to render in the admin UI / logs.
 */

import { z } from 'zod';
import type { Infra3dConfig } from './types.js';

const mqeSchema = z
  .object({
    mqe: z.string().min(1),
    label: z.string().min(1),
    unit: z.string(),
  })
  .strict();

const layerSpecSchema = z
  .object({
    color: z.string().min(1),
    // Canonical single metric for the cube ring.
    metric: mqeSchema.optional(),
    // Deprecated pre-single-metric shapes — still accepted so older saved
    // rows validate; the renderer folds them into `metric` (server ??
    // client ?? load). New saves write `metric` only.
    topology: z
      .object({
        server: mqeSchema.optional(),
        client: mqeSchema.optional(),
      })
      .strict()
      .optional(),
    load: mqeSchema.optional(),
  })
  .strict();

const edgeStyleSchema = z
  .object({
    color: z.string().min(1),
    style: z.enum(['solid', 'dashed']),
    arrow: z.boolean(),
  })
  .strict();

const groupSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, {
      message: 'group id must be lower-kebab (a-z, 0-9, -; start with a letter)',
    }),
    label: z.string().min(1),
    level: z.string().min(1),
    color: z.string().min(1),
    icon: z.string().min(1),
    layers: z.array(z.string().min(1)).min(1),
  })
  .strict();

const levelSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, {
      message: 'level id must be lower-kebab (a-z, 0-9, -; start with a letter)',
    }),
    order: z.number().int().nonnegative(),
    label: z.string().min(1),
    layers: z.array(z.string().min(1)),
  })
  .strict();

const configSchema = z
  .object({
    filter: z
      .object({
        layer: z.string().refine(isValidRegex, { message: 'invalid regex' }),
      })
      .strict(),
    edges: z
      .object({
        hierarchy: edgeStyleSchema,
        crossLevelCall: edgeStyleSchema,
        intraCall: edgeStyleSchema,
      })
      .strict(),
    pipeline: z
      .object({
        // Cap matches the metrics route's MAX_SERVICES (infra-3d-metrics.ts):
        // each metric chunk is one GraphQL request, and OAP's complexity
        // ceiling 5xx's beyond 12 services. A larger chunk size makes every
        // oversized request fail, so reject it at config-save time.
        metricChunkSize: z.number().int().min(1).max(12),
        topologyConcurrency: z.number().int().min(1).max(16),
        templateConcurrency: z.number().int().min(1).max(32),
      })
      .strict(),
    unknownLayer: z
      .object({
        level: z.string().min(1),
        badge: z.string(),
      })
      .strict(),
    levels: z.array(levelSpecSchema).min(1),
    // Optional — older saved configs predate groups; default to none.
    groups: z.array(groupSpecSchema).default([]),
    layers: z.record(z.string().min(1), layerSpecSchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Cross-field invariants the per-field schemas can't see.
    const levelIds = new Set<string>();
    for (const lvl of cfg.levels) {
      if (levelIds.has(lvl.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate level id: ${lvl.id}`,
          path: ['levels'],
        });
      }
      levelIds.add(lvl.id);
    }
    if (!levelIds.has(cfg.unknownLayer.level)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknownLayer.level "${cfg.unknownLayer.level}" must be one of: ${Array.from(levelIds).join(', ')}`,
        path: ['unknownLayer', 'level'],
      });
    }
    // Each group must sit on a real level (a dangling `level` silently
    // drops the group block + scatters its members at render time), and
    // group ids must be unique (placement + side panel key on the id).
    const groupIds = new Set<string>();
    for (const g of cfg.groups) {
      if (groupIds.has(g.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate group id: ${g.id}`,
          path: ['groups'],
        });
      }
      groupIds.add(g.id);
      if (!levelIds.has(g.level)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `group "${g.id}" level "${g.level}" must be one of: ${Array.from(levelIds).join(', ')}`,
          path: ['groups'],
        });
      }
    }
    // A layer belongs to at most ONE logic group — multiple memberships make
    // the group/tier lookup ambiguous (different render passes pick different
    // groups). Same single-claim rule as the per-level `layers` lists below.
    const groupClaimed = new Map<string, string>();
    for (const g of cfg.groups) {
      for (const key of g.layers) {
        const k = key.toUpperCase();
        const prev = groupClaimed.get(k);
        if (prev && prev !== g.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `layer ${k} claimed by both groups: ${prev}, ${g.id}`,
            path: ['groups'],
          });
        }
        groupClaimed.set(k, g.id);
      }
    }
    // A layer can be referenced by an explicit list only once across all
    // levels — otherwise the level membership is ambiguous.
    const claimed = new Map<string, string>();
    for (const lvl of cfg.levels) {
      for (const key of lvl.layers) {
        const k = key.toUpperCase();
        const prev = claimed.get(k);
        if (prev && prev !== lvl.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `layer ${k} claimed by both levels: ${prev}, ${lvl.id}`,
            path: ['levels'],
          });
        }
        claimed.set(k, lvl.id);
      }
    }
  });

function isValidRegex(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

export type ValidationResult =
  | { ok: true; value: Infra3dConfig }
  | { ok: false; issues: string[] };

export function validateInfra3dConfig(input: unknown): ValidationResult {
  const parsed = configSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data as Infra3dConfig };
  const issues = parsed.error.issues.map(
    (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
  );
  return { ok: false, issues };
}
