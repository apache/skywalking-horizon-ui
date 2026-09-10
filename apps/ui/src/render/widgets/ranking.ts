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

/** One row of a `ranking` widget: a service and its value over the picked range. */
export interface RankingRow {
  serviceId: string;
  name: string;
  value: number | null;
}

/** Past this many rows the list runs in at least two columns, read down
 *  then across. */
export const RANKING_SINGLE_COLUMN_MAX = 5;
/** Never more columns than this; rows past what they hold are cut. */
export const RANKING_MAX_COLUMNS = 4;

export interface RankingLayout {
  columns: number;
  /** Rows in each column but the last. */
  perColumn: number;
}

/** How `rows` rows lay out when a column has room for `fit` of them: as many
 *  columns as the height needs, at least two past five rows, balanced. */
export function rankingLayout(rows: number, fit: number): RankingLayout {
  if (rows <= 0) return { columns: 1, perColumn: 0 };
  const needed = Math.ceil(rows / Math.max(1, fit));
  const columns = Math.min(RANKING_MAX_COLUMNS, Math.max(needed, rows > RANKING_SINGLE_COLUMN_MAX ? 2 : 1));
  return { columns, perColumn: Math.ceil(rows / columns) };
}
