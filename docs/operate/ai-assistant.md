# AI Assistant

The AI Assistant is an in-app chat that answers questions about your system in plain language. It reads **live data from your OAP backend** through the same query path the dashboards use, and streams back an ordered narrative with **inline figures — line charts, single-value cards, top-N lists, tables and record lists — drawn by the same widgets** you see across the UI (grouped into tabs, a stack or a grid when an answer needs several). It can also embed the real feature views inline — not just text: the dependency graphs (**topology, hierarchy, deployment, instance map, API dependency**) and the **trace, log and browser-error** explorers. It is **read-only** and **off by default**.

## What it can do

- Answer investigative questions — "what's unhealthy right now?", "investigate latency for a service", "which services have the most errors?", "break a service down by its slowest endpoints".
- Read active **alarms** (the health signal), list layers and services (naming a service is enough — it searches every layer to find it), browse the per-layer **metric catalog** (the curated MQE behind each metric), drill a service down to its instances or endpoints, and render any of those metrics as a figure. Kubernetes layers — **K8S** (cluster / node) and **K8S_SERVICE** (service / pod) — read through this same catalog like any other layer.
- Draw a service's dependencies inline — a focused **one-hop topology** graph (direct upstream callers and downstream dependencies, not the whole-layer map) you can zoom, fit and filter in place, and its **cross-layer hierarchy** (the same Smartscape fan as the topology page, projecting the service up and down into its mesh / infra / database layers). Both need your `topology:read` permission.
- Draw the deeper topology views inline too, each the real page focused for you (all `topology:read`): the **Deployment** graph — one service's own instances and how they call each other; the **Instance map** for a **source → destination** service pair — the instances of each and the calls between them (name both services in your question); and the **API dependency** chain — a service's busiest endpoint and its upstream/downstream callers/callees, where you can expand any node. Each keeps its pan/zoom and its node/edge detail, exactly as on the layer tab.
- Open the real **Traces** explorer inline — focused on a service, it embeds the trace list read-only and, on a row click, the span **waterfall**, the same view as the Traces tab. It hands you the traces to read; it does not read span contents itself, so trace exploration stays your call. It follows the layer's trace configuration and supports **both** trace modes: a **native** SkyWalking-tracing layer embeds directly by service; a **Zipkin**-tracing layer (mesh / Kubernetes — Envoy ALS, rover) is also embedded inline — because Zipkin keys traces on its *own* service names, the assistant first lists the Zipkin services and matches yours to a Zipkin-side name, then embeds that Zipkin trace view. A layer with no traces component says so. Requires your `traces:read` permission.
- Open the real **Logs** view inline — the service's stored log stream with row → detail, the same view as the layer Logs tab; distinct from the Kubernetes live tail below (these are **stored** logs), gated by your `logs:read` permission. For a **browser** app it can likewise embed the **Browser errors** list — the client-side JS error stream with a row → stack-trace detail, gated by your `browser-errors:read` permission.
- Read a Kubernetes pod's **on-demand logs** — pull a container's recent logs (the error stack) and show the fetched lines inline as a read-only result. This is the same on-demand-log path as the Pod Logs tab: logs are streamed live from the cluster and never stored, and it requires your `logs:read` permission. The block is a result, not a console — it doesn't refresh on its own; ask again to fetch a newer window, or open the **Pod Logs** tab to keep a live tail running. When a content filter was applied, the block shows it, so an empty result reads as "nothing matched this filter" rather than a silent pod. On-demand logs must be **enabled on OAP** (off by default) — if they're disabled, the assistant tells you so rather than failing.
- Surface a layer's **service list** as a card — with an **Open in a new tab** button to the real page.
- Run a **guided root-cause investigation** — it loads a matching playbook (a master **root-cause** method plus focused variants for latency, error-rate/SLA, saturation, middleware, Kubernetes-workload and service-mesh) and works root service → calling chain → error stack, walking the topology upstream and following the layer hierarchy down into backing infra/database layers. A middleware dependency (database / cache / MQ) is a topology leaf with nothing downstream, so the investigation bottoms out there and pivots to its **logs, its Kubernetes hierarchy** (the pods' memory / disk / connection pressure) **and the network edge**.
- Narrate an ordered answer: a sentence or two, then a numbered figure, then interpretation, then the next figure — referencing the figures in the prose. A single running **Figure N** counter numbers *every* inline block — figure, topology, hierarchy, deployment, instance map, API dependency, traces, logs, browser errors, pod-logs, sub-page or proposal — so the prose can point at any of them.

It is **read-only by default**: it observes and explains, and never changes configuration, rules, or dashboards. Every data action it takes checks the **same read permission you already hold**, so the assistant can never see more than you can. The one exception is **profiling**: when metrics and traces can't localise a cause, the assistant may *propose* a profiling task as a decision card (what it found, why profiling, what it expects) — nothing runs until **you approve it** in the popout, and only if you hold the `profile:enable` permission.

## How it stays grounded

The assistant does not free-associate over raw numbers. It answers by combining three sources, and it is the interplay between them — not any one alone — that lets it relate metrics, traces, logs and topology into one coherent picture instead of a pile of disconnected data:

- **Live GraphQL data** — it reads through the **same OAP query-protocol the dashboards use**, so it sees exactly what your dashboards see (metrics, traces, logs, topology, alarms), scoped to your permissions and to its own time window. This is *what is happening right now*.
- **Your layer configuration, used as a skill** — the bundled and stored **layer** and **overview** templates are the assistant's catalog of *what each layer measures and how*: the curated metrics and their **MQE** expressions, each metric's entity **scope** (Service / ServiceInstance / Endpoint), its widget type and unit, and which components a layer carries (traces / logs / deployment / topology / …). This is more than a lookup table — it is effectively a **skill the assistant investigates with**, and its whole troubleshooting path is **driven by** it: the assistant can only reach for a metric, scope, or component the layer actually defines, it renders those metrics **verbatim** rather than inventing them (so a chat figure matches the dashboard), and a layer with no trace component simply says so instead of guessing.
- **SkyWalking's concepts** — the domain model is the connective tissue: layers, entity scopes, the metric catalog and MQE, the service **topology** and the cross-layer **hierarchy**. These are what let the assistant tie a metric to the entity it belongs to, walk a dependency edge, or follow a service down into its backing infrastructure layer.

Because the layer configuration is the **same metadata your dashboards are built from**, what the assistant tells you is always consistent with what you can open and verify yourself — the live data supplies the values, the configuration supplies the meaning, and the SkyWalking model supplies the relationships between sources.

Crucially, that skill is **not immutable** — it is *your* configuration, edited in the **Layer dashboards** admin, so it is a lever you control. Add a metric to a layer, enable a component (traces / logs / deployment), or tune its topology / hierarchy config, and the assistant picks it up and uses it in its next investigation; rescope or remove one and it stops reaching for it. The assistant's investigative reach on a layer **tracks whatever you have configured that layer to measure** — so configuring the layers well is, in effect, how you teach and extend it. (This is separate from the built-in **skill guides and root-cause playbooks** — the fixed investigation *method*; the layer configuration is the per-layer *knowledge* that method operates on.)

## Enabling it

The assistant is disabled until you turn it on and point it at a model. The launcher (a floating **AI Assistant** button on the right edge, after login) stays hidden until the feature is enabled *and* a usable provider is configured.

Configure it under the `ai:` block of `horizon.yaml`, or entirely via `HORIZON_AI_*` environment variables:

| Field | Env var | Meaning |
|---|---|---|
| `enabled` | `HORIZON_AI_ENABLED` | Master switch. Default `false`. |
| `provider` | `HORIZON_AI_PROVIDER` | Transport: `openai-compatible` (default) or `bedrock`. Only set it for a non-OpenAI-shaped service. |
| `model` | `HORIZON_AI_MODEL` | Model id to use. |
| `baseUrl` | `HORIZON_AI_BASE_URL` | Endpoint URL for `openai-compatible`. |
| `region` | `HORIZON_AI_REGION` | AWS region for `bedrock`. Optional — falls back to `AWS_REGION` / `AWS_DEFAULT_REGION`. |
| `apiKey` | `HORIZON_AI_API_KEY` | **Secret.** Set via env only — never commit it to the file. Redacted from logs and excluded from the audit trail. |
| `systemPrompt` | `HORIZON_AI_SYSTEM_PROMPT` | Override the bundled system prompt. Blank → bundled default. |
| `starters` | `HORIZON_AI_STARTERS` | Override the starter example chips (JSON array of strings). Blank → bundled defaults. |

The chat replies over **Server-Sent Events**. If you front Horizon with a reverse proxy, disable response buffering for `/api/ai/chat` (the route already sends `X-Accel-Buffering: no` and a periodic heartbeat) so tokens arrive live rather than in one burst at the end.

## Choosing a provider

The assistant is **vendor-neutral** — it speaks to your model through a pluggable transport, so no specific vendor is required.

**OpenAI-compatible (default)** — any endpoint that speaks the OpenAI chat API: a hosted model, a self-hosted / local model, an AI gateway, or a proxy. Set `model`, `baseUrl`, and `apiKey`:

```yaml
ai:
  enabled: true
  provider: openai-compatible
  model: "your-model-id"
  baseUrl: "https://your-endpoint/v1"
  apiKey: "${HORIZON_AI_API_KEY}"
```

**Amazon Bedrock** — set `provider: bedrock`, use a Bedrock model / inference-profile id as `model`, and a Bedrock bearer API key as `apiKey`. `region` comes from config or the standard AWS environment:

```yaml
ai:
  enabled: true
  provider: bedrock
  model: "your-bedrock-model-id"
  region: "us-west-2"
  apiKey: "${HORIZON_AI_API_KEY}"
```

`model` must be a full Bedrock model or inference-profile id (for example `us.anthropic.claude-3-7-sonnet-20250219-v1:0`) — a bare vendor model id is not auto-prefixed. `apiKey` is a Bedrock bearer key (`ABSK…`). Leave `region` blank and Horizon reads it from the `AWS_REGION` / `AWS_DEFAULT_REGION` environment variables, or set it to pin one. (A region set only in `~/.aws/config` is not picked up — supply it via config or one of those env vars.)

Inference parameters (temperature, output-token caps) are **not** Horizon settings — they are owned by your model/gateway. The assistant fixes temperature at 0 for reliable tool use.

When something upstream fails, production builds show only a generic *internal error* with a request id in the chat — match that id in the server logs for the real cause (the raw upstream message, which can carry your endpoint or a response snippet, is kept out of the browser). Development builds (`NODE_ENV=development`) surface the raw provider error instead.

## Customizing the prompts

Both prompts ship with sensible bundled defaults and can be replaced entirely on the server, for everyone:

- **System prompt** (`ai.systemPrompt`) — the assistant's operating instructions. For a multi-line override in `horizon.yaml`, use a YAML block scalar.
- **Starter prompts** (`ai.starters`) — the example chips shown in an empty chat. Provide your own list to tailor the suggestions to your environment. A starter may embed a `<service>` or `<layer>` placeholder: on click it opens a free-text fill-in (with a live preview) where the user types an approximate name that the model resolves at query time — a quick way to ship parameterized suggestions without hard-coding entity names.

## Permissions

Reaching the assistant requires the `ai:read` permission, granted to the viewer / maintainer / operator / admin roles by default and enforced on every chat request by the server. `ai:read` alone only opens the chat — it grants no data access. Each data tool independently re-checks its **own** read verb before it runs: `metrics:read` (layers, services, the metric catalog and every figure), `alarms:read` (alarms), `topology:read` (the topology graph, the cross-layer hierarchy, and the deployment / instance-map / API-dependency views), `traces:read` (the inline Traces view), `logs:read` (the inline Logs view and pod logs), `browser-errors:read` (the inline Browser errors view), and `profile:enable` (the profiling proposal). So the assistant never sees more than you can: a tool you lack the verb for is refused and shows as a **denied** chip in the transcript instead of a result. When you scope a custom role for the assistant, grant `ai:read` for entry plus whichever read verbs you want it to be able to use.

## Conversations

Open the assistant as a **side drawer** from the launcher (drag its left edge to resize it — the width is remembered), **expand it to a full page** (`/ai`) for more room, or open it in a new browser tab. Answers render as formatted markdown.

The assistant keeps its **own time window** — a clock dropdown in the chat header (Last 15m / 1h / 6h / 24h / 3d / 7d, default 1h), separate from the dashboard topbar picker — and scopes every question to it. There is no layer or service picker: name the service or layer in your question (or fill in a starter), and the assistant resolves it.

Each send starts or continues a conversation titled from its first question. The full-page `/ai` view carries a **History** sidebar of past conversations (title + time; click to switch, hover the × to delete) and a **New chat** button; history lives in your browser's local storage (capped at 30 conversations, pruned to ~4 MB) and syncs live across tabs.

While an answer is streaming, **Send** becomes **Stop** — Stop, or **Esc** with the drawer open, aborts it and marks the turn *Interrupted* (Esc does not close the drawer; the × does, and closing also stops the stream).
