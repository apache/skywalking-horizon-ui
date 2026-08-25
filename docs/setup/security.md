# Security & Hardening

What Horizon does on its own, what you configure, and what remains yours to do. Nothing on this page is required to get Horizon running — the defaults are the hardened ones — but an operator putting a console in front of a production backend should know where each line is drawn.

## What is on by default

**Browser hardening.** Every response carries a Content-Security-Policy. Scripts may load only from Horizon's own origin and inline script is forbidden outright, so a hostile string that reached the page could not run. Network requests, images, fonts and workers are likewise confined to Horizon's origin — nothing is fetched from, or can be sent to, another host. Framing is refused, so Horizon cannot be embedded in another page and used for clickjacking. This needs no configuration and has no deployment-specific values; serving Horizon under a path prefix does not affect it.

Two relaxations are deliberate and worth knowing about: images may additionally come from `data:` URLs, because the topology icon set, the 3D map's baked glyphs and the editor's error underlines are built that way; and inline *styles* are permitted, because the charting and editor libraries generate them. Neither grants script execution.

**Session cookies** are `HttpOnly` and `SameSite=Strict`, so page script cannot read a session and another site cannot ride one. Set `session.cookieSecure` when you terminate TLS, which you should.

**API responses are not kept by HTTP caches.** Everything Horizon's API returns — the metrics, traces and logs read from OAP, and your own configuration — is sent `no-store`, so neither the browser's own cache nor a compliant intermediary writes a copy. On a shared workstation such a copy would otherwise outlive the session that was allowed to see it. The console's own static files are content-hashed and stay cacheable; only the API is affected.

This governs HTTP caches, and nothing else. It does not erase data the page already holds in memory, and it does not stop the application storing something deliberately — the console keeps its dashboard configuration in browser storage on purpose, so a returning operator gets an instant first paint. If you need a workstation to retain nothing at all, clear the site's data or use a private window.

**Sign-ins are recorded in the application log, and it carries no replayable credential.** A refused attempt is logged at `warn` with the username, the source address and the backend — so the production default surfaces someone guessing passwords — and the reason stays coarse on purpose, since a log that distinguishes "no such user" from "wrong password" is a way to enumerate who exists. A successful sign-in is logged at `info` with the roles it granted; the production default of `warn` hides those, so set `LOG_LEVEL=info` if you want them. Break-glass use is `warn` and always visible.

No session identifier, password or token is ever written, so the log cannot be used to resume anyone's session. That matters because logs are routinely shipped to a SIEM or attached to a ticket, where more people can read them than can read the session store.

**The application log is not an audit trail, and mutations are not attributed in it.** If you need "who changed what", OAP's own records are where template and rule changes land. Horizon does keep a **login** audit log — who signed in, when and from where — but it is an optional, off-by-default feature backed by a shared store, and it records sign-ins rather than changes. See [Login audit](login-audit.md).

**Shipped assets are self-contained.** Horizon loads no fonts, scripts, styles or images from a third-party CDN — everything is packaged in the release. An air-gapped install needs no allow-listed egress for the console itself, and there is no third party who can change what your operators' browsers execute.

## Outbound links from dashboards

A layer's dashboard template may carry a documentation link, shown as **docs ↗** in the layer header. It is the only place a template can point somewhere outside Horizon, and it is governed two ways.

**The scheme is not negotiable.** A link must be `http`, `https`, or a path on Horizon's own site. Anything else — `javascript:`, `data:`, and their variants — is refused when the template is published and again when it is read back, with the offending scheme named. A path that looks site-relative but actually resolves to another host is treated as what it is, not as what it is spelled like.

**The hosts are yours to choose:**

```yaml
security:
  trustedLinkDomains: ["skywalking.apache.org", "wiki.internal"]
```

A listed host matches itself and its subdomains, so `wiki.internal` also covers `docs.wiki.internal`. Values are bare hostnames — no scheme, port, path or wildcard; Horizon refuses to start on anything else rather than accept a value that could never match.

The default is `["skywalking.apache.org"]`, because every dashboard Horizon ships links to the project documentation. It is a default, not a built-in exemption:

```yaml
security:
  trustedLinkDomains: []
```

With an empty list no outbound link renders at all — a fully closed console. Links to a host outside the list are simply not shown, and the reason is written to the server log.

Both checks run when a template is published **and** when one is read. That second pass is not redundant: dashboard templates live in OAP, which stores them as opaque text and can be written by anything with access to it, so a template need not have passed through Horizon at all.

## Set by the environment variable

| Setting | Environment variable | Default |
|---|---|---|
| `security.trustedLinkDomains` | `HORIZON_TRUSTED_LINK_DOMAINS` | `["skywalking.apache.org"]` |

As with every list-valued setting, the environment form is a single-line JSON string:

```
HORIZON_TRUSTED_LINK_DOMAINS='["wiki.internal"]'
```

## What is still yours to do

**Terminate TLS in front of Horizon** and set `session.cookieSecure`. Horizon does not serve HTTPS itself.

**Restrict who can reach OAP.** Horizon's protections apply to Horizon. OAP's own ports — the query API and, on 11.x, the admin surface that stores dashboard templates — have no authentication of their own, and anything that can write the template store can change what your operators see. Keep those ports on a trusted network.

**Rate-limit the login endpoint at your ingress.** Horizon does not throttle failed sign-ins, so a determined client can attempt passwords as fast as it can open connections, and each attempt costs a password-hash verification or an LDAP round trip. Field lengths ARE bounded — the username and password are capped at 64 characters each, so an attempt cannot be made arbitrarily expensive or write an arbitrarily large log entry — but that bounds the size of each attempt, not their rate. If Horizon is reachable from anywhere untrusted, put a rate limit in front of it. Configure your proxy to pass the real client address so that limit applies per client rather than per proxy.

**Review who holds write permissions.** Anyone who can edit dashboards can change every metric expression an operator reads, and anyone who can edit templates can change where the documentation link points within your allow-list. See [Access Control](rbac.md).

## Reporting a vulnerability

Horizon is part of Apache SkyWalking. Report suspected vulnerabilities to the ASF security team as described at [apache.org/security](https://www.apache.org/security/) — not in a public issue.
