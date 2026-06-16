# Runtime Rules (DSL Management)

Path: `/operate/dsl`. Verbs: `rule:read` to browse, `rule:write` / `rule:write:structural` / `rule:delete` to change (granted by maintainer, operator, admin).

DSL Management lets you edit a connected OAP's analysis rules — MAL (`otel-rules`, `telegraf-rules`, `log-mal-rules`) and LAL (`lal`) — at runtime, without restarting the backend. You browse a catalog, open a rule in the editor, and save; OAP applies the change live across the cluster. Bundled rules shipped with OAP can be overridden, inactivated, or reverted to their bundled version.

## The two kinds of edit

When you save, OAP classifies the change and one of two things happens:

| Edit | What happens | What you see |
|---|---|---|
| Body / filter / tag only | Applied instantly on this node and picked up by every other node on its next scan. No schema change, no collection gap. | A brief "saved" confirmation. |
| Structural — moves a metric's storage shape (scope, downsampling, or the metric set added/removed) | OAP changes the backend schema and rolls it out across the cluster. This runs in the background and can take from seconds to a few minutes. | A live progress stepper (below). |

A structural save is accepted immediately but is **not durable yet** — the editor tracks it to completion so you know when the change is truly live. You can leave the page while it runs; reopening the editor resumes the progress.

## Structural apply progress

The stepper walks through:

`Compiled & schema applied → Confirming across the cluster → Committing → Done`

`Confirming across the cluster` is the step that can take a while — OAP waits for every storage node to pick up the new schema before committing. This is expected; it is not stuck.

The apply ends in one of three states:

| State | Meaning | What to do |
|---|---|---|
| **Done (applied)** | Committed, durable, and confirmed across the cluster. | Nothing — the change is live. |
| **Applied — cluster propagation unconfirmed** (warning) | The change is committed and durable, but one or more nodes hadn't confirmed the new schema within OAP's fence budget. The editor lists those nodes. | Nothing required — the listed nodes catch up automatically on their next scan. If a node stays behind, check its health, then optionally **Force re-apply** (below). Reopening the editor later shows the rule as applied. |
| **Apply failed — rolled back** (error) | A pre-commit error stopped the apply. The cluster stays on the previous rule and your edit is kept in the editor. The failure reason is shown inline. | Read the reason. A compile error appears as an inline diagnostic — fix the YAML and save again. For a transient failure (e.g. storage briefly unavailable), retry once healthy, or use **Force re-apply**. |

A reload of the editor while an apply is still running resumes the live progress; a reload after it finished shows the rule's stored state (a propagation-unconfirmed apply then reads simply as applied, because the change is durable).

## Force re-apply (recover)

When an apply is degraded or transiently failed, the editor offers **Force re-apply (recover)**. It re-runs the apply across the cluster to re-confirm the schema and un-stick any node still waiting — even when the rule content is unchanged.

Because it runs the full apply pipeline, a force re-apply **briefly pauses collection for that rule's metrics**, so the editor asks you to confirm first. Use it to clear a stuck apply or to coax a lagging node into re-confirming. It does **not** help a compile error — fix the rule content for those.

Force re-apply requires the `rule:write:structural` permission.

## Inactivate, delete, revert

- **Inactivate** stops a rule without removing it. Applies instantly.
- **Delete** removes an operator-pushed rule that has no bundled version. A rule must be inactivated before it can be deleted.
- **Revert to bundled** discards an override and reinstalls the bundled version. This is a schema change, so it shows the same structural-apply progress stepper as a save (and the same Done / propagation-unconfirmed / failed outcomes); metrics defined only by the override are dropped. Reverting an ACTIVE rule inactivates it first automatically, so it takes one action.

## Requirements

- OAP admin port reachable from Horizon.
- The `receiver-runtime-rule` module enabled on the connected OAP. The editor shows a warning when it is not.
