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
# AWS DynamoDB

The **AWS_DYNAMODB** layer monitors Amazon DynamoDB through CloudWatch metrics that OAP pulls in and aggregates. It is an agentless layer — there is no SkyWalking agent inside DynamoDB — so the dashboard is a read-only view of the throttling, error, capacity, and latency metrics CloudWatch exposes for your DynamoDB usage.

In Horizon's sidebar this layer is named **AWS DynamoDB**. A service here represents one DynamoDB account, so services are listed as **DynamoDB accounts**; each account's endpoints are its **Tables**. The layer enables only two scopes — the account-level **Service** dashboard and the per-table **Endpoint** dashboard. It has no instance scope, no topology / map, and no traces or logs tabs.

This page is the **operator reference** for the bundled AWS_DYNAMODB dashboard: what you see at the account level and per table, and what each widget means.

> The widgets and metrics below are read from the bundled AWS_DYNAMODB template; if an operator has published a customized AWS_DYNAMODB template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening an account, the layer landing page lists every DynamoDB account with four sortable columns, sorted by **Read Throttled** by default. All four are window sums (`aggregation: "sum"`), so they surface the accounts taking the most throttling and system-error pressure over the selected range:

- **Read Throttled** — throttled read requests across the account (`aws_dynamodb_read_throttled_requests`).

- **Write Throttled** — throttled write requests across the account (`aws_dynamodb_write_throttled_requests`).

- **Read Sys Err** — read requests that failed with a DynamoDB system error (`aws_dynamodb_read_system_errors`).

- **Write Sys Err** — write requests that failed with a DynamoDB system error (`aws_dynamodb_write_system_errors`).

## Service dashboard

The account-level drill-down for one selected DynamoDB account. All widgets are time-series lines over the selected window.

- **Throttled Requests** — throttled read vs write requests for the account (`aws_dynamodb_read_throttled_requests`, `aws_dynamodb_write_throttled_requests`).

- **Throttle Events** — throttle events on read vs write, counted independently of throttled request volume (`aws_dynamodb_read_throttle_events`, `aws_dynamodb_write_throttle_events`).

- **System Errors** — read vs write requests that hit a DynamoDB-side system error (`aws_dynamodb_read_system_errors`, `aws_dynamodb_write_system_errors`).

- **User Errors** — requests rejected for a client-side / user error such as a bad request (`aws_dynamodb_user_errors`).

- **Conditional Check Failed** — write requests rejected because a conditional expression evaluated to false (`aws_dynamodb_conditional_check_failed_requests`).

- **Transaction Conflict** — transactional requests rejected due to a conflict with another in-flight transaction (`aws_dynamodb_transaction_conflict`).

- **Read Capacity (unit/s)** — provisioned read capacity vs consumed write capacity for the account (as the bundled template plots them), in capacity units per second (`aws_dynamodb_provisioned_read_capacity_units`, `aws_dynamodb_consumed_write_capacity_units`).

- **Write Capacity (unit/s)** — provisioned vs consumed write capacity for the account, in capacity units per second (`aws_dynamodb_provisioned_write_capacity_units`, `aws_dynamodb_consumed_write_capacity_units`).

- **Successful Request Latency (ms)** — latency of successful operations, broken out by operation type — get / put / query / scan — in ms (`aws_dynamodb_get_successful_request_latency`, `aws_dynamodb_put_successful_request_latency`, `aws_dynamodb_query_successful_request_latency`, `aws_dynamodb_scan_successful_request_latency`).

- **TTL Deleted Items** — items removed by DynamoDB's time-to-live expiry process (`aws_dynamodb_time_to_live_deleted_item_count`).

- **Scan Returned Items** — items returned by Scan operations (`aws_dynamodb_scan_returned_item_count`).

- **Query Returned Items** — items returned by Query operations (`aws_dynamodb_query_returned_item_count`).

- **Account Max Reads / Writes** — the account-level capacity ceilings CloudWatch reports: table-level read / write maxima and account-wide read / write maxima (`aws_dynamodb_account_max_table_level_reads`, `aws_dynamodb_account_max_table_level_writes`, `aws_dynamodb_account_max_reads`, `aws_dynamodb_account_max_writes`).

- **Account Capacity Utilization** — provisioned read vs write capacity utilization for the account, in percent (`aws_dynamodb_account_provisioned_read_capacity_utilization`, `aws_dynamodb_account_provisioned_write_capacity_utilization`).

## Endpoint dashboard

For one selected **Table** under the account. These are the per-table counterparts of the account-level widgets, evaluated at endpoint scope (`aws_dynamodb_endpoint_*`), so you can see which individual table is responsible for the account's throttling, errors, or capacity draw.

- **Throttled Requests** — throttled read vs write requests against the table (`aws_dynamodb_endpoint_read_throttled_requests`, `aws_dynamodb_endpoint_write_throttled_requests`).

- **Throttle Events** — read vs write throttle events on the table (`aws_dynamodb_endpoint_read_throttle_events`, `aws_dynamodb_endpoint_write_throttle_events`).

- **System Errors** — read vs write DynamoDB system errors on the table (`aws_dynamodb_endpoint_read_system_errors`, `aws_dynamodb_endpoint_write_system_errors`).

- **Conditional Check Failed** — write requests on the table rejected by a failed conditional expression (`aws_dynamodb_endpoint_conditional_check_failed_requests`).

- **Transaction Conflict** — transactional requests on the table rejected due to a conflict (`aws_dynamodb_endpoint_transaction_conflict`).

- **TTL Deleted Items** — items removed from the table by time-to-live expiry (`aws_dynamodb_endpoint_time_to_live_deleted_item_count`).

- **Read Capacity** — provisioned vs consumed read capacity for the table (`aws_dynamodb_endpoint_provisioned_read_capacity_units`, `aws_dynamodb_endpoint_consumed_read_capacity_units`).

- **Write Capacity** — provisioned vs consumed write capacity for the table (`aws_dynamodb_endpoint_provisioned_write_capacity_units`, `aws_dynamodb_endpoint_consumed_write_capacity_units`).

- **Successful Request Latency (ms)** — latency of successful operations on the table by operation type — get / put / query / scan — in ms (`aws_dynamodb_endpoint_get_successful_request_latency`, `aws_dynamodb_endpoint_put_successful_request_latency`, `aws_dynamodb_endpoint_query_successful_request_latency`, `aws_dynamodb_endpoint_scan_successful_request_latency`).

- **Scan Returned Items** — items returned by Scan operations on the table (`aws_dynamodb_endpoint_scan_returned_item_count`).

- **Query Returned Items** — items returned by Query operations on the table (`aws_dynamodb_endpoint_query_returned_item_count`).

## Requirements

The AWS_DYNAMODB dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the DynamoDB metric families collected from CloudWatch and aggregated under this layer:

- **Account (service) metrics** — the `aws_dynamodb_*` family: throttled requests and throttle events, read / write system errors, user errors, conditional-check failures, transaction conflicts, provisioned vs consumed read / write capacity, per-operation successful request latency (get / put / query / scan), TTL-deleted items, scan / query returned items, the account-level max read / write ceilings, and provisioned capacity utilization.

- **Table (endpoint) metrics** — the matching `aws_dynamodb_endpoint_*` family for the same throttling, error, capacity, latency, and returned-item metrics resolved per table.

Each metric is queried at its own OAP scope; OAP does not roll a metric up across scopes, so the table-scope `aws_dynamodb_endpoint_*` metrics are empty until per-table data is reported, independently of the account-scope metrics. For how to collect these metrics into OAP, see the [DynamoDB monitoring setup](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-aws-dynamodb-monitoring/) in the SkyWalking backend docs.
