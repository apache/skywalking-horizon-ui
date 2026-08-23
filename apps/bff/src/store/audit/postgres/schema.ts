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
     -- Which SSO protocol proved the identity, stored for the same reason the
     -- granted roles are: a provider can be reconfigured or removed, and the
     -- row has to keep saying what was true at sign-in. It is also what lets
     -- the list agree with the chart, which draws OIDC and OAuth apart.
     protocol           text,
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
     horizon_node       text        NOT NULL
   )`,

  // `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so it can
  // create a schema but never advance one: a column added above reaches a
  // fresh database and no other, and every existing deployment wedges on
  // `schema_error` with nothing that repairs it. Column additions therefore
  // need their own idempotent statement here. Ordinal position differs
  // between a fresh table and an altered one; nothing reads columns by
  // position, so that difference is immaterial.
  `ALTER TABLE horizon_audit ADD COLUMN IF NOT EXISTS protocol text`,

  `CREATE INDEX IF NOT EXISTS horizon_audit_at_idx
     ON horizon_audit (at DESC, id DESC)`,

  `CREATE INDEX IF NOT EXISTS horizon_audit_username_idx
     ON horizon_audit (username, at DESC)`,

  // No `text_pattern_ops` companion: that operator class exists to serve
  // `LIKE 'x%'`, and the filter is an exact match. The plain index above
  // serves equality on any collation.
  //
  // The index is not dropped here for a database that already has it — this
  // list only creates. It is harmless, and dropping an index an operator may
  // have come to rely on is not something a boot path should decide.

  // No index on outcome, provider or roles: the page filters by time, kind
  // and username only, and an index nothing queries is write cost for
  // nothing. Those columns are still recorded and still shown on a row.


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
     rejected          int NOT NULL DEFAULT 0,
     over_budget       int NOT NULL DEFAULT 0
   )`,

  // Token usage. A STATISTIC, not an audit record: presenting a token is not
  // a sign-in, so it has no place in `horizon_audit` and no row per request.
  //
  // One row per credential per hour PER NODE, and the node is in the KEY.
  // Each process writes only its own running total, so no node can overwrite
  // another's share and no read is needed before a write; the deployment's
  // count for the hour is the SUM across these rows, taken when the page asks.
  // The node id carries a boot id, so a restart starts a fresh row rather than
  // replacing a real total with a partial one.
  `CREATE TABLE IF NOT EXISTS horizon_token_usage (
     hour_bucket   bigint NOT NULL,
     token_id      text   NOT NULL,
     username      text   NOT NULL,
     count         bigint NOT NULL,
     horizon_node  text   NOT NULL,
     PRIMARY KEY (hour_bucket, token_id, horizon_node)
   )`,

  `CREATE INDEX IF NOT EXISTS horizon_audit_stat_hour_idx
     ON horizon_audit_stat (hour_bucket)`,
];

/** The token-usage write's column list, beside the DDL that creates them. An
 *  ARRAY so the bind width is counted rather than restated. */
export const USAGE_COLUMNS = ['hour_bucket', 'token_id', 'username', 'count', 'horizon_node'] as const;
