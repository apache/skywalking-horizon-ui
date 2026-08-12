# Wire Debug Log

Wire-level HTTP request/response log for troubleshooting OAP communication. **Off by default.** Very verbose — only use when actively debugging.

```yaml
debugLog:
  enabled: false
  file: ./horizon-wire.jsonl
  maxBodyChars: 8192
  redactAuthHeaders: true
```

## Fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `enabled` | boolean | `false` | no | Master switch. When `true`, every outbound OAP request and inbound response is logged to `file`. Off otherwise. |
| `file` | string | `./horizon-wire.jsonl` | no | Filesystem path to the wire log. JSON Lines, one entry per request. Append-only, no rotation. |
| `maxBodyChars` | number | `8192` | no | Maximum body size (in characters) to log per request/response. Larger bodies are truncated with a marker. Prevents unbounded log growth from large MQE responses. Non-negative integer; `0` means do not log bodies. |
| `redactAuthHeaders` | boolean | `true` | no | When `true`, `Authorization` and `Proxy-Authorization` headers (basic-auth credentials sent to OAP) are replaced with `<redacted>` in the log. **Set to `true` in production.** |

## What gets logged

One JSON line per outbound request/response pair, with these fields:

| Field | Meaning |
|---|---|
| `ts` | Request start time (ISO 8601). |
| `method` | HTTP method. |
| `url` | Full request URL. |
| `status` | Response HTTP status. Absent when the request failed before a response arrived. |
| `elapsedMs` | Wall-clock milliseconds from request start to response (or failure). |
| `requestHeaders` / `responseHeaders` | Header maps, with auth redaction per `redactAuthHeaders`. |
| `requestBody` / `responseBody` | Bodies as text, truncated at `maxBodyChars` with a `…[truncated, N chars total]` marker. Omitted entirely when `maxBodyChars: 0`. |
| `error` | Present instead of `status` / response fields when the request failed at the network level (timeout, refused connection); carries the error message. |

GraphQL queries are logged as POST bodies; admin REST endpoints (runtime-rule, inspect, etc.) appear as their underlying method.

## Use cases

- **"Why does OAP return X?"** Tail the log while you reproduce the issue:

  ```sh
  tail -f horizon-wire.jsonl | jq -c 'select(.status >= 400)'
  ```

- **MQE expression debugging.** Read the literal `execExpression` mutation Horizon sends, then run it directly against OAP with `curl` to compare.
- **Capability probing.** The introspection probes that determine which OAP features Horizon thinks are available appear as ordinary entries the first time each feature is used.

## Operational notes

- **High volume.** A busy dashboard fires dozens of requests per page load; expect hundreds of MB/day with `enabled: true`.
- **Timeout covers the body while enabled.** To log the response, Horizon buffers each OAP reply before handing it on, so `oap.timeoutMs` then bounds the full body download — a very large, slow response that normally finishes after the header timeout window can abort while the log is on. Binary payloads pass through byte-identical and are logged as a size marker.
- **No rotation.** Pair with a log shipper or a logrotate sidecar.
- **Off in production by default** unless you are actively troubleshooting a specific issue.
- **Enabling it is announced.** Starting the BFF with `enabled: true` emits a warning line in the app log as a reminder that every outbound OAP request/response is being appended (very verbose — disable after troubleshooting).
- **Auth-header redaction is on by default.** Disabling it (`redactAuthHeaders: false`) leaks basic-auth credentials into the log — running that way emits its own startup warning. Only flip off for a single-session troubleshooting run, and clear the file afterward.
- **An unwritable path drops entries, not the process.** If the target directory can't be created or written, the entry is dropped and an error is logged; OAP traffic itself is unaffected.

## Hot reload

`enabled`, `file`, `maxBodyChars`, `redactAuthHeaders` all hot-reload. Flipping `enabled: false → true` starts logging on the next outbound call.
