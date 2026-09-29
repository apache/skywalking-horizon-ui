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
 * The BFF's refusal of a data read: HTTP 403 `{ error: 'permission_denied',
 * verb, reason?, layer? }`. A `reason` comes with a refusal decided by which
 * layer or service the request reached for, rather than by the verb alone; it
 * is turned into a sentence here so a page says why, not "failed (403)".
 */

import { i18n } from '@/i18n';

export interface PermissionDenied {
  verb?: string;
  reason?: string;
  layer?: string;
  group?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function permissionDeniedOf(status: number, body: unknown): PermissionDenied | null {
  if (status !== 403 || !body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (o.error !== 'permission_denied') return null;
  return { verb: str(o.verb), reason: str(o.reason), layer: str(o.layer), group: str(o.group) };
}

/** Null for a refusal without a reason — the plain missing-verb 403, whose
 *  wording callers already have. */
export function describeRefusal(d: PermissionDenied): string | null {
  if (!d.reason) return null;
  const t = i18n.global.t;
  switch (d.reason) {
    case 'service_required':
      return t('Pick a service: you can read only some services of this layer, so a query across all of them is refused.');
    case 'service_not_granted':
      return t('You do not have access to this service.');
    case 'layer_not_granted':
      return d.layer
        ? t('You do not have access to the {layer} layer.', { layer: d.layer.toUpperCase() })
        : t('You do not have access to this layer.');
    case 'group_not_granted':
      return t('You do not have access to the {group} services of the {layer} layer.', {
        group: d.group ?? '',
        layer: (d.layer ?? '').toUpperCase(),
      });
    case 'id_names_no_service':
    case 'segment_ids_name_no_service':
    case 'schedule_ids_name_no_service':
    case 'task_id_names_no_service':
    case 'expression_names_no_service':
    case 'not_attributable_to_a_service':
      return t('This read does not name a service, and you can read only some services.');
    case 'alarm_filter_unsupported':
      return t('This OAP cannot filter alarms by service, and you can read only some services.');
    case 'preview_needs_template_write':
      return t('Previewing a draft template needs the layer-template:write permission.');
    default:
      return t('Access denied ({reason}).', { reason: d.reason });
  }
}

function refusalOf(err: unknown): PermissionDenied | null {
  if (!err || typeof err !== 'object' || !('status' in err) || !('body' in err)) return null;
  const { status, body } = err as { status: unknown; body: unknown };
  return typeof status === 'number' ? permissionDeniedOf(status, body) : null;
}

/** Any refusal, with or without a reason. */
export function isPermissionDenied(err: unknown): boolean {
  return refusalOf(err) !== null;
}

/** The sentence for a refused BFF read, or null when `err` is anything else. */
export function permissionDeniedText(err: unknown): string | null {
  const d = refusalOf(err);
  return d ? describeRefusal(d) : null;
}

/** The sentence for any refused BFF read — with a reason, its own; without
 *  one, a general one — or null when `err` is anything else. A refusal is an
 *  answer, so a screen showing it offers no Retry. */
export function refusalText(err: unknown): string | null {
  if (!isPermissionDenied(err)) return null;
  return permissionDeniedText(err) ?? i18n.global.t('Your role does not allow this read.');
}

/** `String(err)` for everything but a refusal with a reason, which reads as
 *  its sentence instead of `BffApiError: …`. */
export function errorText(err: unknown): string {
  return permissionDeniedText(err) ?? String(err);
}
