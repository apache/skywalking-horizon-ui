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
 * Which alarm rows a reader may see.
 *
 * An alarm is the service's that owns its entity. A relation concerns both of
 * its ends, so a reader of either sees the whole of it: of its source, or of
 * every service its destination could be. A row no service owns (an `All` or
 * a process alarm) belongs to no layer a grant can name, so only a reader
 * holding `alarms:read` without a layer sees it.
 *
 * Every service is decided through {@link RequestAccess}, once per id or name
 * per request: it answers from the catalog while the catalog is fresh and
 * asks OAP for a service the catalog misses, or holds only from before a
 * failed refresh. A destination is known by name alone, and a name means
 * both its normal and its conjectural id, so each is looked up — a namesake
 * registered since the catalog was read still counts.
 */

import type { RequestAccess, ServiceRef } from '../../rbac/request-access.js';
import { ServiceLookupUnavailable, type ResolvedService } from '../services/service-identity.js';
import { alarmDestinationNames, alarmSourceId, isRelationAlarm, type AlarmEntity } from './owners.js';

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

  constructor(private readonly access: RequestAccess) {}

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

  /** Whether the caller sees a row. */
  async keeps(m: AlarmEntity): Promise<boolean> {
    if (readsEveryAlarm(this.access)) return true;
    const source = alarmSourceId(m);
    if (!source) return !this.access.layerLimited(VERBS);
    if (await this.readable(source)) return true;
    if (!isRelationAlarm(m)) return false;
    const dests: ResolvedService[] = [];
    for (const name of alarmDestinationNames(m)) {
      const r = await this.access.resolve({ name });
      if (r.kind === 'unavailable') throw new ServiceLookupUnavailable('OAP did not answer which service an alarm concerns');
      if (r.kind === 'found') dests.push(...r.services);
    }
    return dests.length > 0 && dests.every((d) => this.access.allowsResolved(VERBS, d));
  }

  /** Every row with whether it is kept — decided before a page filter, which
   *  cannot wait, runs over them. A row the read does not list is not kept,
   *  and whose it is is not asked. */
  async decide<T extends AlarmEntity>(rows: readonly T[], listed: (row: T) => boolean = () => true): Promise<Array<DecidedRow<T>>> {
    if (!readsEveryAlarm(this.access)) await this.prefetch(rows.filter(listed));
    const out: Array<DecidedRow<T>> = [];
    for (const row of rows) out.push({ row, kept: listed(row) && (await this.keeps(row)) });
    return out;
  }

  /** Asks OAP at once for what deciding `rows` needs: the sources first, then
   *  the destinations of only the relations whose source does not already
   *  decide them. */
  private async prefetch(rows: readonly AlarmEntity[]): Promise<void> {
    const sources = new Set<string>();
    for (const m of rows) {
      const source = alarmSourceId(m);
      if (source) sources.add(source);
    }
    await this.access.prefetch([...sources].map((id): ServiceRef => ({ id })));
    const names = new Set<string>();
    for (const m of rows) {
      const source = alarmSourceId(m);
      if (!source || !isRelationAlarm(m) || (await this.readable(source))) continue;
      for (const name of alarmDestinationNames(m)) names.add(name);
    }
    await this.access.prefetch([...names].map((name): ServiceRef => ({ name })));
  }
}
