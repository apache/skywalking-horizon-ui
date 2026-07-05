# Runtime State Files

The BFF writes a small amount of runtime state to files, managed automatically — neither needs hand-editing.

## `audit.file`

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `audit.enabled` | boolean | `true` | no | Whether to record the audit trail. On by default; set `false` to disable audit logging entirely. Env: `HORIZON_AUDIT_ENABLED`. |
| `audit.file` | string | `./horizon-audit.jsonl` | no | Filesystem path to the append-only audit log. |

The append-only audit trail — one JSON line per mutating admin action. On by default; disable with `audit.enabled: false`. See [Audit Log](../access-control/audit-log.md).

## `debugLog.file`

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `debugLog.file` | string | `./horizon-wire.jsonl` | no | Filesystem path to the OAP wire debug log. Only written when `debugLog.enabled` is set. |

The OAP request/response wire trace, off by default. See [Debug Log](debug-log.md).

## Env-var fallbacks

When `horizon.yaml` does not supply `audit.file` or `debugLog.file`, the default is seeded from an env var:

| YAML key | Env-var fallback | Default |
|---|---|---|
| `audit.file` | `HORIZON_AUDIT_FILE` | `./horizon-audit.jsonl` |
| `debugLog.file` | `HORIZON_WIRE_LOG_FILE` | `./horizon-wire.jsonl` |

The published Docker image sets both env vars to `/data/...` paths so an operator who runs the image without a `horizon.yaml` override gets writes routed to the declared `/data` volume — see [Container Image → Persisting state files](container-image.md#persisting-state-files-audit-debuglog). An explicit value in `horizon.yaml` always wins over the env-var fallback.

## Operational notes

- **Both are mutable runtime state.** They should be on durable storage, not a container tmpfs.
- **Both are gitignored by default** (see `.gitignore`). They are not source-controlled; they are operational state.
- **Atomic appends.** The audit log is append-only, so a crash mid-write cannot corrupt earlier records.
