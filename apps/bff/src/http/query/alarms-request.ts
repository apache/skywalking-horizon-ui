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
 * The query parameters `GET /api/alarms` accepts, and the one rule that binds
 * them: a picked service travels as its NAME plus the roster row's `normal`
 * flag, both or neither.
 *
 * The schema lives beside the route rather than inside it so BOTH sides of the
 * wire can test against the same object — the UI's alarms api-scope test parses
 * the URL its client builds with this schema. A parameter the route starts
 * demanding that no caller sends then fails a test, instead of 400-ing every
 * service-filtered query while both suites stay green.
 */

import { z } from 'zod';

/** `pageSize` cap for the list route, so the header KPIs + frontend pager can
 *  work from a single fetch. */
const LIST_PAGE_SIZE_CAP = 500;

export const alarmsQuerySchema = z
  .object({
    startTime: z.coerce.number().int().positive(),
    endTime: z.coerce.number().int().positive(),
    /** Legacy-mode only. Ignored in new mode (use `layer` + entity
     *  fields instead). */
    scope: z.string().optional(),
    keyword: z.string().optional(),
    pageNum: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(LIST_PAGE_SIZE_CAP).default(LIST_PAGE_SIZE_CAP),
    /** New-mode only. Maps to `condition.layer` (a single String on the
     *  OAP side — an alarm record is persisted with one layer). */
    layer: z.string().optional(),
    /** New-mode only. The picked service's NAME, which is the half OAP's alarm
     *  entity filter takes — `alarm.graphqls` has no id form. Combined with
     *  `instance` / `endpoint`; absent ⇒ no entity narrowing. */
    service: z.string().optional(),
    /** True for an agent-reporting service, false for a conjectural (virtual)
     *  one. Part of the OAP entity id, so it is required WITH the service and
     *  strictly `true` / `false`: anything looser would coerce a typo into
     *  "normal" and quietly filter a virtual service down to no rows. */
    normal: z
      .union([z.literal('true'), z.literal('false')])
      .transform((v) => v === 'true')
      .optional(),
    instance: z.string().optional(),
    endpoint: z.string().optional(),
  })
  .superRefine((q, ctx) => {
    if (q.service && q.normal === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['normal'],
        message: 'normal must accompany service, as the layer roster returned it',
      });
    }
  });
