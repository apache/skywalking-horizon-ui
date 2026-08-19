# Runtime State Files

The BFF writes one runtime state file, managed automatically — it never needs hand-editing.

## `debugLog.file`

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `debugLog.file` | string | `./horizon-wire.jsonl` | no | Filesystem path to the OAP wire debug log. Only written when `debugLog.enabled` is set. |

The OAP request/response wire trace, off by default. See [Debug Log](debug-log.md).

## Env-var fallback

When `horizon.yaml` does not supply `debugLog.file`, the default is seeded from an env var:

| YAML key | Env-var fallback | Default |
|---|---|---|
| `debugLog.file` | `HORIZON_WIRE_LOG_FILE` | `./horizon-wire.jsonl` |

The published Docker image sets this env var to a `/data/...` path so an operator who runs the image without a `horizon.yaml` override gets writes routed to the declared `/data` volume — see [Container Image → Persisting the wire debug log](container-image.md#persisting-the-wire-debug-log). An explicit value in `horizon.yaml` always wins over the env-var fallback.

## Operational notes

- **This is mutable runtime state.** It should be on durable storage, not a container tmpfs, if you want it to survive a restart.
- **It is gitignored by default** (see `.gitignore`). It is not source-controlled; it is operational state.
- **Appends are atomic.** The log is append-only, so a crash mid-write cannot corrupt earlier records.
- **It is a debugging aid, not a security record.** It captures OAP request and response payloads when switched on, and it is off by default because those payloads are large and can carry data you would not want at rest. For a record of who signed in, read the application log; Horizon keeps no record of who changed what.
