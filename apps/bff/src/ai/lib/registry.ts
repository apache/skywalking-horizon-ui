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
 * The tool registry — the one place that says which tools exist.
 *
 * Every consumer builds from here, so capability cannot drift between them:
 * a tool the chat panel has, an MCP client has, and vice versa. What differs
 * per consumer is presentation (where output lands) and transport, never the
 * tool set. Each tool closes over a {@link ToolContext}, which is the
 * seam consumers vary — the panel streams blocks to SSE, a captured run
 * collects them into an array.
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ToolContext } from './tool-context.js';
import { contextTools } from './tools/context/tools.js';
import { metricCatalogTools } from './tools/metric-catalog/tools.js';
import { telemetryTools } from './tools/telemetry/tools.js';
import { visualizationTools } from './tools/visualization/tools.js';
import { kubernetesTools } from './tools/kubernetes/tools.js';
import { rcaTools } from './tools/rca/tools.js';
import { triggerTools } from './tools/triggers/tools.js';

export function buildTools(ctx: ToolContext): StructuredToolInterface[] {
  return [
    ...rcaTools(),
    ...contextTools(ctx),
    ...telemetryTools(ctx),
    ...metricCatalogTools(ctx),
    ...kubernetesTools(ctx),
    ...visualizationTools(ctx),
    ...triggerTools(ctx),
  ];
}
