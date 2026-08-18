# MCP — connect your own agent

Horizon speaks the **Model Context Protocol**, so an agent you already run — Claude Code, Codex, Claude Desktop, or anything else that speaks MCP — can read your observability data directly. Point it at `POST /api/mcp` and it gets the same investigation tools the [AI Assistant](ai-assistant.md) uses: the metric catalog, figures, the five dependency maps, traces, logs, browser errors, Kubernetes pod logs, profiling results, and the seven root-cause playbooks.

It is **on by default**, and it is **read-only** in the same sense the assistant is: every tool re-checks the permission its matching screen needs, so an agent sees exactly what the operator it authenticated as sees, and nothing more.

## MCP and the AI Assistant are different features

They share their tools, and nothing else. The distinction decides which one you want:

| | AI Assistant | MCP |
|---|---|---|
| Where the model runs | the provider **you configure Horizon with** | **your agent's** side; Horizon never sees a model |
| What you configure | `ai:` — provider, model, API key | `mcp:` — one switch |
| Where the answer appears | Horizon's chat panel | your agent's window |
| Default | **off** until you give it a provider | **on** |
| Permission | `ai:read` | `mcp:read` |

Because the model stays on the caller's side, MCP needs no provider, no API key, and no outbound network access from Horizon at all. A deployment that will never enable the assistant can still serve MCP, and the reverse.

## Connecting

Every client needs two things: the URL, and a credential.

```
https://horizon.example.com/api/mcp
```

There are two ways to authenticate, and which you want depends on whether a person is present. Both produce a **bearer token** — a browser session cookie is not accepted here and is answered with a 401 saying so. That is deliberate rather than an omission: this endpoint's response is written by the MCP transport rather than by Horizon's normal reply path, so the renewal that keeps a browser session alive cannot be sent, and a session would quietly expire in the browser while the server still believed it valid. Every MCP client holds a token anyway.

### An API token — for one machine, one operator

The simplest path, and the one to start with. Your administrator issues you a token (see [Authentication](../setup/auth.md)); you configure your client to send it as `Authorization: Bearer hzn_…`.

```bash
claude mcp add --transport http horizon https://horizon.example.com/api/mcp \
  --header "Authorization: Bearer hzn_..."
```

The token names **you**. Your permissions are re-read on every request, so the agent's access shrinks when yours does and stops entirely when your account is removed.

### Browser login — for anyone who should self-serve

If your administrator has enabled Horizon's authorization server, a client can send you through a normal browser login instead. You add the server with no credential at all:

```bash
claude mcp add --transport http horizon https://horizon.example.com/api/mcp
```

A client identifies itself in one of two ways and Horizon accepts both: it registers itself (dynamic client registration), or it presents a URL that publishes its own metadata — Claude Code does the second. Either way you do nothing.

The first time the agent needs access, your browser opens **Horizon's own login page** — the same one you use for the UI, backed by whatever your organisation has configured — and then a consent screen showing who is asking, where the result is sent, and how much access it would carry. Approve it once and the client keeps its token.

The agent never sees your password.

This is the flow you already know from "Sign in with Google": an application sends you to somewhere you trust, you log in there, you approve what the application may do, and it receives a token instead of your password. The difference is which side Horizon is on. When you sign in to something with Google, Google is the authorization server. Here **Horizon is**, and the login page it shows is its own — so whichever backend your organisation uses (local accounts, LDAP, or an identity provider your login page delegates to) keeps working without the agent knowing anything about it.

## Which clients can reach an internal Horizon

This is the question that decides everything else, and it is not about MCP support — it is about **who makes the connection**.

**Clients running on your machine** connect from your machine. If your laptop can open Horizon in a browser — over the corporate network, through a VPN, on localhost — the agent can reach it too, and Horizon needs no public address, no inbound firewall rule and no exposure of any kind. Claude Code and Codex are in this group.

**Clients where the connection is made for you** — the web app, the mobile apps, a Desktop *connector* — are fetched from the vendor's cloud, which cannot see your internal network. Those need Horizon reachable from the public internet, which is a decision about your deployment rather than a setting here.

Most Horizon deployments are internal, so the on-device clients are the ones that matter, and they are also the two that render inline cards.

| Client | Reaches an internal Horizon | How to add it |
|---|---|---|
| **Claude Code** | yes — runs on your machine | `claude mcp add --transport http …` as above |
| **Codex** | yes — runs on your machine | add Horizon as an HTTP MCP server in its config |
| **Claude Desktop** | yes, with a local bridge | Desktop speaks MCP over a local process; point it at Horizon through a stdio-to-HTTP bridge such as `mcp-remote` |
| **claude.ai, mobile, Desktop connectors** | only if Horizon is publicly reachable | add it as a connector, with the authorization server enabled |

Client configuration changes faster than these docs do — check your client's own MCP documentation for the exact syntax. What Horizon needs is always the same: the URL `https://<your-horizon>/api/mcp`, and either a bearer token or the browser login.

## The consent screen, and what "read-only" means there

Two scopes exist, and a client asks for one:

- **`horizon:read`** — the default, and what a client gets if it asks for nothing. Read-only.
- **`horizon:full`** — everything you can do.

What the token actually carries is the **overlap** of that scope with your own permissions, and both halves are enforced on every request:

- An **administrator** approving `horizon:read` gets a read-only agent. The scope caps them.
- A **viewer** approving `horizon:full` gets a viewer's access. Their permissions cap the scope.

Neither can be widened later. The consent screen lists the permissions the grant would actually carry — your permissions filtered by the scope — rather than everything the scope names, so it never promises access you cannot delegate.

## What the agent can do

The tool set is the assistant's, so [everything that page describes](ai-assistant.md) applies: reading alarms, browsing the per-layer metric catalog, rendering catalog metrics as figures, walking topology and the cross-layer hierarchy, reading traces / logs / browser errors, pulling Kubernetes pod logs, and reading finished profiling results.

Two things work differently because the agent is somewhere else:

**The time window is an argument, not a picker.** There is no toolbar on the other end, so every data tool takes `windowMinutes` (default 60) and `step` (`MINUTE`, `HOUR`, `DAY`). Ask for a wider window and the agent widens the parameter. Reading a week at minute precision is refused by OAP, so widen the step along with the window.

**A client that can draw gets the real widgets.** Horizon ships its card renderer as an MCP app resource, so a host that supports inline rendering (MCP Apps) mounts the same charts, dependency maps and trace lists the Horizon UI draws — not a picture of them, the components themselves. The bundle is fetched once and reused; its address carries a content hash, so a new Horizon build is a new address and there is nothing to cache-bust, while a conversation reopened later renders with the renderer it was captured against.

It makes **no network requests at all** — every card already carries the data it was captured with — so it runs under a host's default deny-all policy with no exception granted for it. A client that cannot render inline is unaffected and reads the text below.

**The data comes back as numbers the agent can reason over.** A tool that draws a chart in the assistant panel returns, over MCP, a log-scaled sparkline, twelve buckets of min / average / maximum, and the extremes with their timestamps — enough to diagnose from, and enough for a capable client to plot for you itself. Trace, log and browser-error lists come back as rows. Where a list is longer than what fits, the reply says so and says which rows it kept.

## Profiling still needs a person

An agent can *propose* a profiling task — the cause, the reasoning, what it would reveal, and the exact parameters — and it starts nothing. No MCP tool changes anything on your system or your OAP backend. Starting a proposed task is something you do in Horizon's Profiling tab.

## Root-cause playbooks

The seven investigation playbooks are offered as MCP **prompts**, so a client that lists prompts shows them as commands you can pick: `root-cause` (the master method), `latency`, `errors-sla`, `saturation`, `middleware-remote`, `k8s`, `mesh`. Each takes an optional service and layer. The same playbooks are also available to the agent as a tool, for when it reaches for one mid-answer rather than being told to.

## Configuration

MCP itself is one switch:

```yaml
mcp:
  enabled: true            # default
```

With it off, `POST /api/mcp` answers 503.

The authorization server — needed only for the browser-login path — is separate and **off** by default:

```yaml
oauth:
  enabled: true
  issuer: "https://horizon.example.com"        # the PUBLIC base URL clients reach you at
  signingKey: "${HORIZON_OAUTH_SIGNING_KEY}"   # a secret; set it from the environment
  accessTokenMinutes: 60
  refreshTokenDays: 30                         # 0 sends people back through the browser instead
```

Both `issuer` and `signingKey` are required. With either missing the authorization server stays off, its endpoints answer 404, and a warning at boot names what is missing.

**`signingKey` must be at least 32 characters, and a shorter one is treated as no key at all** — the authorization server stays off and says why. It is not a password anyone types; it is the single secret behind every credential this server issues, and because nothing is stored there is no issued-token list to check a forgery against. Anyone who can guess it can mint a working token for any user, including an administrator, and the server cannot tell that token from one it issued itself. Generate one and keep it out of the config file:

```bash
openssl rand -base64 32
```

Set it through the environment (`HORIZON_OAUTH_SIGNING_KEY`), give each deployment its own, and treat a leak as a reason to rotate — which invalidates every outstanding token at once, as below. `issuer` is deliberately **not** derived from the request — discovery metadata tells a client where to send its user to log in, so a guessed value would be somewhere to point that.

**Rotating `signingKey` invalidates every outstanding token at once**, and is the way to revoke in bulk. Individual tokens cannot be revoked before they expire — they are signed rather than stored — which is why `accessTokenMinutes` is short by default and why permissions are re-read from your directory on every single request.

**A refresh token is a long-lived secret on the operator's own machine, and protecting it is theirs to do.** Every client writes it to a file — Claude Code, Codex and `mcp-remote` all keep it in the user's config directory — where it stays valid for `refreshTokenDays`, and redeeming it issues a fresh one for the same period again. Horizon stores nothing, so there is no list to strike a single token from and no way to notice one being used twice. Treat a leaked refresh token the way you would a leaked SSH key: it is good until it expires, and the levers are rotating `signingKey` (which logs out every agent), removing the user (which is immediate, because roles are re-read per request), or setting `refreshTokenDays: 0` so people re-authorize through the browser instead. That is the trade the stateless design makes deliberately — no database, and therefore no per-credential revocation.

Serve Horizon over HTTPS when the authorization server is on. Authorization codes and tokens travel in URLs and headers; over plain HTTP they travel in the clear, and Horizon warns at boot if `issuer` is `http://` outside local development.

## Permissions

| Permission | What it allows |
|---|---|
| `mcp:read` | Connect an agent at all. Granted to viewer, maintainer, operator and admin by default. |

`mcp:read` opens the connection and grants no data access by itself — the per-screen permissions (`metrics:read`, `traces:read`, `logs:read`, `topology:read`, `profile:read`, …) are what the tools check. Revoke `mcp:read` from a role to stop that role connecting agents while leaving their browser access untouched.

## Troubleshooting

**"MCP is disabled on this Horizon server" (503)** — `mcp.enabled` is false.

**401, and the client does not offer to log in** — the client has no credential and the authorization server is off, so there is nothing for it to discover. Either configure a token, or ask your administrator to enable `oauth`.

**"Unknown or malformed client_id"** — the client neither registered nor presented a metadata URL Horizon would fetch. If it uses a metadata URL, check `oauth.clientMetadataHosts`: an empty list allows any public host, a non-empty one confines it.

**The browser opens, you log in, and the client reports a failure** — most often `oauth.issuer` does not match the URL the client actually reached, so the callback goes somewhere the client is not listening. It must be the public base URL, with no trailing path.

**"This authorization request has expired"** — the consent screen was left open too long (ten minutes). Start again from the client.

**A tool answers "you do not have permission"** — the agent inherited your permissions and yours do not include that screen. The fix is a role change, not a client setting.

**A tool answers that a layer has no such view, or that no profiling task was found** — that is the data, not a fault. A layer only carries what its template configures, and a profiling result only exists once someone has run a task. Both say so in words rather than returning an empty picture.

**The agent reports it cannot reach Horizon at all** — check the client is one that connects from your machine (see the table above). A connector added on the web or a phone is fetched from the vendor's cloud and cannot see an internal address, however correct the URL is.

**Cards render as text in a client that should draw them** — the renderer ships only in a packaged build. A source checkout serves MCP text-only until `pnpm build:mcp-app` has run. The container image and the binary release tarball both carry it; the source release tarball does not, because it ships only what is in version control.

**Metric tools report the template store is unreachable** — that is an OAP health problem, not an MCP one, and it affects the UI equally. See [Template source](../setup/horizon-yaml.md#template-source-mode).
