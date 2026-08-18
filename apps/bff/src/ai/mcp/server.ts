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
 * The MCP server: Horizon's tools and playbooks, spoken as Model Context
 * Protocol.
 *
 * Built per request and thrown away — the transport runs STATELESS, so there is
 * no server-side session to pin a client to a BFF replica. That matters more
 * than it sounds: Horizon is routinely run behind a load balancer with several
 * replicas, and a session-bearing MCP server would need sticky routing to work
 * at all. Every request instead carries its own auth (the Bearer token or the
 * session cookie), which is the same thing every other Horizon route requires.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PLAYBOOKS } from '../lib/tools/rca/playbooks.js';
import { bundledSystemPrompt, type Surface } from '../lib/skills/prompt.js';
import type { HorizonConfig } from '../../config/schema.js';
import type { CaptureDeps } from './capture.js';
import { callTool, listToolDefs } from './tools.js';
import { mcpAppBundle, MCP_APP_MIME } from './resource.js';

export type McpDeps = Omit<CaptureDeps, 'windowMinutes' | 'step'>;

const SERVER_NAME = 'skywalking-horizon';

/**
 * How this deployment introduces itself. `mcp.name`, else the host of
 * `server.publicUrl`, else nothing — see the config comment for why an
 * unnamed deployment is a problem once an operator connects two.
 */
export function deploymentLabel(config: HorizonConfig): string {
  if (config.mcp.name) return config.mcp.name;
  try {
    return config.server.publicUrl ? new URL(config.server.publicUrl).host : '';
  } catch {
    return '';
  }
}

/**
 * Which presentation section the instructions carry.
 *
 * A client that can DRAW a card gets `inline`; one that cannot gets `terminal`,
 * where the agent is told to read the numbers itself and plot for the operator
 * in whatever it has. Guessing wrong is not cosmetic — telling a terminal agent
 * that calling a show_* tool renders a chart makes it announce charts nobody
 * can see.
 *
 * The signal is the SEP-1724 extensions mechanism — `capabilities.extensions`
 * carrying `io.modelcontextprotocol/ui`, which is verbatim what Codex sends.
 * An earlier version tested `capabilities.ui`, a key that appears nowhere in
 * the specification, so EVERY MCP-Apps host was classified `terminal` and told
 * that calling a tool draws nothing — while its widget was mounting.
 *
 * Absence still means terminal, which is the safe default: an inline client
 * told "you have no renderer" gets correct analysis anyway, while the reverse
 * produces a confident lie about a picture nobody can see.
 *
 * This shapes the INSTRUCTIONS only. A stateless server sees capabilities on
 * the `initialize` exchange and nowhere else, so nothing decided per tool call
 * may depend on it.
 */
export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';

export function surfaceFor(capabilities: unknown): Surface {
  const caps = (capabilities ?? {}) as Record<string, unknown>;
  const ext = (caps.extensions ?? {}) as Record<string, unknown>;
  const experimental = (caps.experimental ?? {}) as Record<string, unknown>;
  // The spec key first; the older shapes kept because a host predating the
  // extensions mechanism should not be misread as text-only.
  return ext[UI_EXTENSION_ID] || caps.ui || experimental.ui ? 'inline' : 'terminal';
}

export function createMcpServer(deps: McpDeps, surface: Surface, version: string): Server {
  const label = deploymentLabel(deps.config.current);
  const server = new Server(
    { name: label ? `${SERVER_NAME} (${label})` : SERVER_NAME, version },
    {
      capabilities: { tools: {}, prompts: {}, ...(mcpAppBundle() ? { resources: {} } : {}) },
      // The host prepends this to its own system prompt, so it is the only
      // place Horizon can teach an agent it does not control. Same core the
      // chat assistant reads — capability must not diverge between consumers.
      //
      // Deliberately the BUNDLED prompt, never `ai.systemPrompt`: that override
      // belongs to the assistant panel, and `ai` configures the model Horizon
      // talks to, which has nothing to do with an agent that brings its own.
      instructions: label
        ? // Prepended, not appended: with two deployments connected the model
          // must know WHICH system every tool result describes, and the last
          // line of a 30 KB prompt is not where that belongs.
          `You are reading the SkyWalking deployment "${label}". Every tool here queries THAT deployment — if another Horizon is also connected, do not attribute one's data to the other, and name the deployment when you report a finding.\n\n${bundledSystemPrompt(surface)}`
        : bundledSystemPrompt(surface),
    },
  );

  const bundle = mcpAppBundle();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDefs(deps).map((t) =>
      bundle && t.emitsCard
        ? {
            ...t,
            // The spec locates the pointer on the TOOL, and hosts prefetch the
            // resource from tools/list — Codex reads it only from here
            // (`tool_info.tool.meta`). It was previously set on the call
            // RESULT alone, which Codex tolerated and a stricter host would
            // not have mounted at all. Flat key alongside nested because the
            // reference SDK ships both for host compatibility.
            _meta: { ui: { resourceUri: bundle.uri }, 'ui/resourceUri': bundle.uri },
          }
        : t,
    ),
  }));

  // The card renderer. Declared only when the bundle was built — a resource
  // listed but unreadable is worse than one absent, because a host mounts an
  // empty frame instead of falling back to the text it already has.
  if (bundle) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: bundle.uri,
          name: 'Horizon cards',
          description: 'Renders Horizon figures, dependency maps and triage lists inline.',
          mimeType: MCP_APP_MIME,
        },
      ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      if (req.params.uri !== bundle.uri) throw new Error(`No resource ${req.params.uri}.`);
      return { contents: [{ uri: bundle.uri, mimeType: MCP_APP_MIME, text: bundle.html }] };
    });
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await callTool(deps, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    // Point a rendering host at the bundle whenever this result produced a
    // card. Deliberately NOT gated on `surface`: the transport is stateless, so
    // only the `initialize` exchange carries the client's capabilities and
    // every other request would compute `terminal` regardless of who is asking.
    // Unconditional is also the right shape — the pointer is advisory, a host
    // with no renderer ignores an unknown `_meta` key, and the guard that
    // matters is the one below: no card, no pointer, so nothing is ever asked
    // to mount a frame with nothing to draw.
    if (bundle && result._meta) {
      result._meta = { ...result._meta, ui: { resourceUri: bundle.uri } };
    }
    return result;
  });

  // The playbooks are exposed BOTH as prompts and as the `get_playbook` tool.
  // Not redundant: a prompt is something the operator picks from a menu ("/mcp
  // horizon:latency"), a tool is something the model reaches for mid-answer.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PLAYBOOKS.map((p) => ({
      name: p.id,
      title: p.title,
      description: p.whenToUse,
      arguments: [
        { name: 'service', description: 'Service to investigate. Optional — omit to start from the alarms.', required: false },
        { name: 'layer', description: 'Layer the service lives in, e.g. GENERAL, MESH, K8S_SERVICE.', required: false },
      ],
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = PLAYBOOKS.find((x) => x.id === req.params.name);
    if (!p) throw new Error(`No playbook "${req.params.name}".`);
    const service = req.params.arguments?.service;
    const layer = req.params.arguments?.layer;
    const focus = service
      ? `\n\nInvestigate: ${service}${layer ? ` (layer ${layer})` : ''}.`
      : '\n\nNo service was named — start from the current alarms and pick the affected one.';
    return {
      description: p.whenToUse,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${p.body}${focus}` } }],
    };
  });

  return server;
}
