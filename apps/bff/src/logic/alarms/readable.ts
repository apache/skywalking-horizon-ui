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
 * Which alarm rows a reader may see, for an alarm read that names no service.
 *
 * An alarm is the service's that owns its entity. A relation concerns both of
 * its ends, so a reader of either sees the whole of it: of its source, or of
 * every service its destination could be. A row no service owns (an `All` or
 * a process alarm) belongs to no layer a grant can name, so only a reader
 * holding `alarms:read` without a layer sees it.
 *
 * Every service is decided through {@link RequestAccess.decide}, once per id
 * per request: it answers from the catalog while the catalog is fresh and
 * asks OAP for a service the catalog misses, or holds only from before a
 * failed refresh.
 */

import type { RequestAccess } from '../../rbac/request-access.js';
import { ServiceLookupUnavailable, type Index } from '../services/service-identity.js';
import { alarmDestinations, alarmSourceId, isRelationAlarm, type AlarmEntity } from './owners.js';

const VERBS = ['alarms:read'] as const;

export interface DecidedRow<T> {
  row: T;
  kept: boolean;
}

/** Every row kept, as it is: the reader of every alarm. */
export function keepAll<T>(rows: readonly T[]): Array<DecidedRow<T>> {
  return rows.map((row) => ({ row, kept: true }));
}

/** Holds `alarms:read` on every layer, operate layers included: every row is
 *  the caller's, whole. No access object means no restriction (unit tests). */
export function readsEveryAlarm(access: RequestAccess | undefined): boolean {
  return !access || access.readsEveryLayer(VERBS);
}

export class AlarmRowAccess {
  private readonly decided = new Map<string, Promise<'allow' | 'deny' | 'unavailable'>>();

  constructor(
    private readonly access: RequestAccess,
    private readonly index: Index,
  ) {}

  /** Throws {@link ServiceLookupUnavailable} when OAP could not say whose a
   *  service is: dropping the row would pass a partial answer off as whole. */
  private async readable(id: string): Promise<boolean> {
    let d = this.decided.get(id);
    if (!d) {
      d = this.access.decide(VERBS, { id });
      this.decided.set(id, d);
    }
    const answer = await d;
    if (answer === 'unavailable') throw new ServiceLookupUnavailable('OAP did not answer which service an alarm belongs to');
    return answer === 'allow';
  }

  /** Whether the caller sees a row from a read that named no service. */
  async keeps(m: AlarmEntity): Promise<boolean> {
    if (readsEveryAlarm(this.access)) return true;
    const source = alarmSourceId(m);
    if (!source) return !this.access.layerLimited(VERBS);
    if (await this.readable(source)) return true;
    if (!isRelationAlarm(m)) return false;
    const dests = alarmDestinations(m, this.index);
    if (dests.length === 0) return false;
    for (const d of dests) if (!(await this.readable(d.id))) return false;
    return true;
  }

  /** Every row with whether it is kept — decided before a page filter, which
   *  cannot wait, runs over them. */
  async decide<T extends AlarmEntity>(rows: readonly T[]): Promise<Array<DecidedRow<T>>> {
    const out: Array<DecidedRow<T>> = [];
    for (const row of rows) out.push({ row, kept: await this.keeps(row) });
    return out;
  }
}
