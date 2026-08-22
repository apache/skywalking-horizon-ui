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
 * The audit schema.
 *
 * `text` rather than enums for `kind`, `provider` and `reason`, so a new value
 * never fails an insert against an older table during a rolling upgrade. The
 * closed unions are validated in TypeScript; the database stays permissive.
 *
 * PostgreSQL 10 or newer — `GENERATED ALWAYS AS IDENTITY` is a 10 feature.
 * Nothing here needs more: every column in the unique index is non-null on the
 * rows it covers, so there is no `NULLS NOT DISTINCT`, which would have meant
 * 15+.
 */

/** Serialises replicas that start together so they queue on DDL rather than
 *  racing it. Arbitrary, but must not collide with another advisory lock in
 *  the same database. */
export const SCHEMA_LOCK_ID = 0x53574155; // "SWAU"

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS horizon_audit (
     id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     at                 timestamptz NOT NULL,
     kind               text        NOT NULL,
     provider           text,
     outcome            smallint    NOT NULL,
     reason             text,
     username           text        NOT NULL,
     mail               text,
     -- What the sign-in GRANTED, comma-separated. What someone was given at
     -- sign-in is the part a browser session then carries until they sign in
     -- again, so it belongs on the row rather than being re-derived later
     -- from a role table that has since changed.
     roles              text,
     client_ip          inet,
     horizon_ip         inet,
     horizon_node       text        NOT NULL,
     hour_bucket        bigint,
     count              int         NOT NULL DEFAULT 1
   )`,

  `CREATE INDEX IF NOT EXISTS horizon_audit_at_idx
     ON horizon_audit (at DESC, id DESC)`,

  `CREATE INDEX IF NOT EXISTS horizon_audit_username_idx
     ON horizon_audit (username, at DESC)`,

  // PREFIX search needs its own operator class: a default-collation B-tree
  // does NOT serve `LIKE 'x%'` on any collation but C, so without this the
  // filter silently degrades to a sequential scan of the whole table.
  `CREATE INDEX IF NOT EXISTS horizon_audit_username_prefix_idx
     ON horizon_audit (username text_pattern_ops)`,

  // No index on outcome, provider or roles: the page filters by time, kind
  // and username only, and an index nothing queries is write cost for
  // nothing. Those columns are still recorded and still shown on a row.

  // One row per credential-hour per writing process.
  `CREATE UNIQUE INDEX IF NOT EXISTS horizon_audit_bucket_idx
     ON horizon_audit (hour_bucket, kind, username, horizon_node)
     WHERE hour_bucket IS NOT NULL`,

  // Statistics. A SURROGATE key, and rows that are per-interval deltas:
  // `horizon_node` is best-effort attribution, so keying on it would make two
  // pods reporting the same host silently overwrite each other's counts.
  `CREATE TABLE IF NOT EXISTS horizon_audit_stat (
     id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     hour_bucket       bigint NOT NULL,
     horizon_node      text   NOT NULL,
     login_local       int NOT NULL DEFAULT 0,
     login_ldap        int NOT NULL DEFAULT 0,
     login_oidc        int NOT NULL DEFAULT 0,
     login_oauth       int NOT NULL DEFAULT 0,
     login_token       int NOT NULL DEFAULT 0,
     rejected          int NOT NULL DEFAULT 0,
     over_budget       int NOT NULL DEFAULT 0
   )`,

  `CREATE INDEX IF NOT EXISTS horizon_audit_stat_hour_idx
     ON horizon_audit_stat (hour_bucket)`,
];
