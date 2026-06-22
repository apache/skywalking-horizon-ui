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
# AWS S3

The **AWS_S3** layer monitors Amazon S3 storage by reading CloudWatch request metrics for your buckets, so each S3 bucket appears in SkyWalking as a service with its own request, error, latency, and transfer dashboard.

In Horizon's sidebar this layer is grouped under **AWS** and its services are listed as **S3 buckets** — one entry per monitored bucket. The AWS_S3 layer is a metrics-only layer: it enables the **Service** scope alone. There is no instance, endpoint, topology, trace, or log sub-tab, because S3 monitoring is CloudWatch metric data rather than agent-instrumented traffic.

This page is the **operator reference** for the bundled AWS_S3 dashboard: what you see for each S3 bucket and what each widget means.

> The widgets and metrics below are read from the bundled AWS_S3 template; if an operator has published a customized AWS_S3 template to OAP, the live dashboard reflects that copy instead. See [Layer Dashboard Templates](../customization/layer-templates.md) for how the bundled default, your local draft, and the OAP-published copy relate.

## Service list

Before opening a bucket, the layer landing page lists every S3 bucket with four sortable columns, sorted by request volume (**Requests**) by default:

- **Requests** — total request count for the bucket (`aws_s3_all_requests`).

- **Avg Latency** — average request latency in ms (`aws_s3_request_latency`).

- **4xx** — count of 4xx (client-error) responses (`aws_s3_4xx`).

- **5xx** — count of 5xx (server-error) responses (`aws_s3_5xx`).

## Service dashboard

The drill-down for one selected S3 bucket.

- **All Request Count** — total requests against the bucket over the window (`aws_s3_all_requests`).

- **GET Request Count** — GET (read / download) requests (`aws_s3_get_requests`).

- **PUT Request Count** — PUT (write / upload) requests (`aws_s3_put_requests`).

- **DELETE Request Count** — DELETE requests (`aws_s3_delete_requests`).

- **4xx Count** — client-error responses, the 4xx family (`aws_s3_4xx`).

- **5xx Count** — server-error responses, the 5xx family (`aws_s3_5xx`).

- **Request Avg Latency** — average total request latency in ms (`aws_s3_request_latency`).

- **First Byte Avg Latency** — average time to first byte in ms, the latency before any payload starts streaming back (`aws_s3_first_latency_bytes`).

- **Downloaded (KB)** — bytes downloaded from the bucket, in KB (`aws_s3_downloaded_bytes`).

- **Uploaded (KB)** — bytes uploaded to the bucket, in KB (`aws_s3_uploaded_bytes`).

## Requirements

The AWS_S3 dashboard is a pure consumer of what OAP reports — it invents no data, and a widget with no backing data simply reads `no data`. To populate it, OAP needs the AWS S3 monitoring receiver enabled, pulling the bucket's CloudWatch request metrics, which OAP turns into the `aws_s3_*` service-scope metric family: request counts (`aws_s3_all_requests`, `aws_s3_get_requests`, `aws_s3_put_requests`, `aws_s3_delete_requests`), error counts (`aws_s3_4xx`, `aws_s3_5xx`), latency (`aws_s3_request_latency`, `aws_s3_first_latency_bytes`), and transfer volume (`aws_s3_downloaded_bytes`, `aws_s3_uploaded_bytes`).

Every metric in this dashboard is queried at the Service scope — the S3 bucket — so each bucket you have configured CloudWatch monitoring for appears as one entry in the **S3 buckets** list. For the OAP-side setup (CloudWatch credentials, the buckets to watch, and the collection interval), follow the [AWS S3 monitoring setup guide](https://skywalking.apache.org/docs/main/next/en/setup/backend/backend-aws-s3-monitoring/).
