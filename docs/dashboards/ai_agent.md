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

# AI Agents

The **AI_AGENT** layer is where the [SkyWalking AI Sessionizer](https://skywalking.apache.org/docs/skywalking-ai-sessionizer/next/readme/) lands the conversations of long-lived AI agents. The Sessionizer collects an agent runtime's transcripts on the machine where the agent runs, assembles them into conversations, and pushes them to OAP; OAP stores them under this layer and answers Horizon's reads. Nothing in Horizon talks to the agent runtime or to the Sessionizer directly.

In Horizon's sidebar this layer is named **AI Agents**. Its top-level entities are **Agent runtimes** (the service slot): one per kind of agent, `Claude Code` for the Claude Code adapter, or whatever service name the Sessionizer was configured with. Each runtime reports through one or more **Senders** (the instance slot): one Sessionizer process on one machine, named `user@host` by default, or the mailbox or machine name its operator set.

The layer has no metric dashboards yet, so it has no Service, Instance or Endpoint page; its one tab is **Conversations**. See [AI Agent Conversations](../operate/ai-agent-conversations.md) for what that tab shows and how to read it.

> The layer appears only when OAP reports it, which needs OAP 11.1.0 or later with at least one conversation pushed. The OAP side — receiving, verifying and storing the files, and its retention — is documented with the other [OAP backend setup pages](https://github.com/apache/skywalking/tree/master/docs/en/setup/backend) in the SkyWalking repository.

## Bundled template

The bundled AI_AGENT template enables the `aiConversations` component and nothing else, and names the two entity slots as above. Like every layer template it can be edited under **Dashboard setup → Layer dashboards** — for example to rename the slots for your organisation — and published to OAP; see [Layer Dashboard Templates](../customization/layer-templates.md).

When the Sessionizer starts exporting conversation metrics, this template is where their dashboards will be added.
