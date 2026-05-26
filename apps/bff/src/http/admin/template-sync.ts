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
 * Template sync surface for the admin pages.
 *
 *   GET  /api/admin/templates/sync-status           — full merged map
 *                                                     (bundled + remote +
 *                                                     status per name).
 *                                                     Pages render banners
 *                                                     and per-row diffs
 *                                                     from this body.
 *
 *   POST /api/admin/templates/:name/push-bundled    — operator wants the
 *                                                     bundled copy of this
 *                                                     template to overwrite
 *                                                     what OAP has. 409 if
 *                                                     OAP unreachable;
 *                                                     forces a resync on
 *                                                     success.
 *
 *   POST /api/admin/templates/save                  — write a template
 *                                                     (Save in the admin
 *                                                     UI). Body: { name,
 *                                                     content }. PUTs the
 *                                                     envelope to OAP. 409
 *                                                     when OAP unreachable
 *                                                     (the UI banner should
 *                                                     have prevented this
 *                                                     call, but verify
 *                                                     server-side).
 *
 *   POST /api/admin/templates/resync                — invalidate the 30s
 *                                                     cache; the next
 *                                                     bundle pull triggers
 *                                                     a fresh OAP probe.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UITemplateClient } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import type { SessionStore } from '../../user/sessions.js';
import { requireAuth } from '../../user/middleware.js';
import {
  createAndConfirm,
  updateAndConfirm,
  disableAndConfirm,
  WriteNotVisibleError,
  getSyncStatus,
  resync,
  type SyncStatus,
} from '../../logic/templates/sync.js';
import { iterateBundledTemplates } from '../../logic/templates/aggregator.js';
import {
  buildEnvelope,
  buildOverlayEnvelope,
  formatOverlayName,
  parseEnvelope,
  parseName,
  serializeEnvelope,
  type TemplateKind,
} from '../../logic/templates/names.js';
import type { LayerTemplate } from '../../logic/layers/loader.js';
import { writeLayerTemplate } from '../../logic/layers/loader.js';
import type { OverviewDashboard } from '@skywalking-horizon-ui/api-client';
import { writeOverviewDashboard } from '../../logic/overview/loader.js';
import { getLayerOverlay, getOverviewOverlay, isLocale } from '../../i18n/index.js';
import { logger } from '../../logger.js';

export interface TemplateSyncAdminDeps {
  config: ConfigSource;
  sessions: SessionStore;
  uiTemplateClient: () => UITemplateClient;
}

export function registerTemplateSyncAdminRoutes(
  app: FastifyInstance,
  deps: TemplateSyncAdminDeps,
): void {
  const auth = requireAuth(deps);

  app.get(
    '/api/admin/templates/sync-status',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // `?force=true` bypasses the 30s sync cache and re-reads OAP
      // before responding. Admin views pass this so the operator sees
      // their own writes reflected without having to hit the explicit
      // "refresh from remote" button — config edits should always see
      // fresh state. The render-side bundle endpoint stays cached.
      const force = (req.query as { force?: string })?.force === 'true';
      if (force) resync();
      const status = await loadStatus(deps);
      return reply.send(status);
    },
  );

  app.post(
    '/api/admin/templates/resync',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      resync();
      const status = await loadStatus(deps);
      return reply.send(status);
    },
  );

  /* GET /api/admin/templates/:name/i18n/:locale — fetch translation
   * overlays for a template + locale. Returns both:
   *   - `disk`: sibling `*.i18n.<lang>.json` shipped with the BFF (seed
   *     translations the codebase carries).
   *   - `oap`:  per-locale overlay row on OAP at `<name>.i18n.<locale>`
   *     (translations the operator has pushed).
   * The Translations editor merges these to populate its draft (OAP
   * wins per-leaf, disk fills the gaps). Both are `null` for English
   * or when the relevant source is missing. */
  app.get<{ Params: { name: string; locale: string } }>(
    '/api/admin/templates/:name/i18n/:locale',
    { preHandler: auth },
    async (req, reply) => {
      const { name, locale } = req.params;
      if (!isLocale(locale)) {
        return reply.code(400).send({
          code: 'invalid_locale',
          message: `unsupported locale: ${locale}`,
        });
      }
      const parsed = parseName(name);
      if (!parsed || parsed.locale !== undefined) {
        return reply.code(400).send({
          code: 'invalid_template_name',
          message: `expected source-row name horizon.<overview|layer|alert>.<key>, got ${JSON.stringify(name)}`,
        });
      }
      let disk: unknown = null;
      if (parsed.kind === 'layer') disk = getLayerOverlay(parsed.key, locale);
      else if (parsed.kind === 'overview') disk = getOverviewOverlay(parsed.key, locale);

      // OAP overlay row — look it up via fresh sync. We don't resync()
      // unconditionally; the bundle's 30s cache is usually warm and the
      // operator can hit the refresh button if they need fresher state.
      let oap: unknown = null;
      try {
        const status = await loadStatus(deps);
        const overlayName = formatOverlayName(parsed.kind as TemplateKind, parsed.key, locale);
        const row = status.rows.find(
          (r) => r.name === overlayName && r.remote && !r.remote.disabled,
        );
        if (row?.remote) {
          const env = parseEnvelope(row.remote.configuration);
          if (env) oap = env.content;
        }
      } catch (err) {
        logger.warn({ err: errMsg(err), name, locale }, 'failed to read OAP overlay row');
      }

      return reply.send({ disk, oap });
    },
  );

  /* POST /api/admin/templates/save-translation — push the operator's
   * translation overlay for ONE locale, as a sibling row on OAP. The
   * body's `content` is the overlay map (source-shape mirror). The
   * source row at `<name>` is not touched.
   *
   * Body: { name: '<source row name>', locale: '<bcp-47>', content: <overlay> }
   */
  app.post<{
    Body: { name?: string; locale?: string; content?: unknown };
  }>('/api/admin/templates/save-translation', { preHandler: auth }, async (req, reply) => {
    const { name, locale, content } = req.body ?? {};
    if (typeof name !== 'string' || typeof locale !== 'string' || content === undefined) {
      return reply.code(400).send({
        code: 'invalid_save_body',
        message: 'body must be { name: string, locale: string, content: object }',
      });
    }
    if (!isLocale(locale)) {
      return reply.code(400).send({
        code: 'invalid_locale',
        message: `unsupported locale: ${locale}`,
      });
    }
    if (locale === 'en') {
      return reply.code(400).send({
        code: 'invalid_locale',
        message: 'English has no overlay row; edit the source template directly',
      });
    }
    const parsed = parseName(name);
    if (!parsed || parsed.locale !== undefined) {
      return reply.code(400).send({
        code: 'invalid_template_name',
        message: `expected source-row name horizon.<overview|layer|alert>.<key>, got ${JSON.stringify(name)}`,
      });
    }
    resync(); // fresh OAP read before deciding create-vs-update
    const status = await loadStatus(deps);
    if (status.unreachable) {
      return reply.code(409).send({
        code: 'oap_unreachable',
        message: 'OAP admin port unreachable — translations are read-only',
      });
    }
    const envelope = buildOverlayEnvelope(parsed.kind as TemplateKind, parsed.key, locale, content);
    const configuration = serializeEnvelope(envelope);
    const existing = status.rows.find((r) => r.name === envelope.name);
    try {
      if (existing?.remote) {
        await updateAndConfirm(deps.uiTemplateClient(), existing.remote.id, configuration, logger);
      } else {
        await createAndConfirm(deps.uiTemplateClient(), configuration, logger);
      }
      resync();
      const fresh = await loadStatus(deps);
      return reply.send(fresh);
    } catch (err) {
      if (err instanceof WriteNotVisibleError) {
        logger.warn({ name: envelope.name, id: err.id }, 'save-translation propagation timeout');
        return reply.code(504).send({
          code: 'oap_propagation_timeout',
          message: err.message,
          id: err.id,
        });
      }
      logger.warn({ err: errMsg(err), name: envelope.name }, 'save-translation to OAP failed');
      return reply.code(502).send({
        code: 'oap_write_failed',
        message: errMsg(err),
      });
    }
  });

  /* POST /api/admin/templates/delete-translation — soft-delete a
   * per-locale overlay row so the locale falls back to the disk
   * catalog. OAP has no hard delete; we disable the row. */
  app.post<{
    Body: { name?: string; locale?: string };
  }>('/api/admin/templates/delete-translation', { preHandler: auth }, async (req, reply) => {
    const { name, locale } = req.body ?? {};
    if (typeof name !== 'string' || typeof locale !== 'string') {
      return reply.code(400).send({
        code: 'invalid_body',
        message: 'body must be { name: string, locale: string }',
      });
    }
    const parsed = parseName(name);
    if (!parsed || parsed.locale !== undefined) {
      return reply.code(400).send({
        code: 'invalid_template_name',
        message: `expected source-row name horizon.<overview|layer|alert>.<key>, got ${JSON.stringify(name)}`,
      });
    }
    if (!isLocale(locale) || locale === 'en') {
      return reply.code(400).send({
        code: 'invalid_locale',
        message: `unsupported locale: ${locale}`,
      });
    }
    resync();
    const status = await loadStatus(deps);
    if (status.unreachable) {
      return reply.code(409).send({
        code: 'oap_unreachable',
        message: 'OAP admin port unreachable — translations are read-only',
      });
    }
    const overlayName = formatOverlayName(parsed.kind as TemplateKind, parsed.key, locale);
    const existing = status.rows.find((r) => r.name === overlayName);
    if (!existing?.remote || existing.remote.disabled) {
      // Nothing to do — disk fallback already in effect.
      return reply.send(status);
    }
    try {
      await disableAndConfirm(deps.uiTemplateClient(), existing.remote.id, logger);
      resync();
      const fresh = await loadStatus(deps);
      return reply.send(fresh);
    } catch (err) {
      if (err instanceof WriteNotVisibleError) {
        return reply.code(504).send({
          code: 'oap_propagation_timeout',
          message: err.message,
          id: err.id,
        });
      }
      logger.warn({ err: errMsg(err), name: overlayName }, 'delete-translation failed');
      return reply.code(502).send({
        code: 'oap_write_failed',
        message: errMsg(err),
      });
    }
  });

  /* POST /api/admin/templates/resolve-conflicts — for every envelope
   * name that currently has >1 ENABLED OAP row, disable all but the
   * lowest-UUID winner. Same deterministic tie-break the render-side
   * parseRemoteRows uses, so the operator-visible "live" row doesn't
   * change after the resolve. Already-disabled losers (tombstones)
   * are left alone — OAP can't free them and re-disabling them is a
   * no-op. */
  app.post(
    '/api/admin/templates/resolve-conflicts',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      resync();
      const status = await loadStatus(deps);
      if (status.unreachable) {
        return reply.code(409).send({
          code: 'oap_unreachable',
          message: 'OAP admin port unreachable — cannot resolve conflicts',
        });
      }
      if (status.conflicts.length === 0) {
        return reply.send({ ...status, disabled: [] as string[] });
      }
      const client = deps.uiTemplateClient();
      const disabled: string[] = [];
      const failed: Array<{ name: string; id: string; error: string }> = [];
      for (const c of status.conflicts) {
        const ids = [...c.enabledIds].sort((a, b) => a.localeCompare(b));
        const [, ...losers] = ids;
        for (const id of losers) {
          try {
            await disableAndConfirm(client, id, logger);
            disabled.push(id);
            logger.info({ name: c.name, droppedId: id, keptId: ids[0] }, 'resolved duplicate UI-template via /resolve-conflicts');
          } catch (err) {
            failed.push({ name: c.name, id, error: errMsg(err) });
            logger.warn({ name: c.name, id, err: errMsg(err) }, 'resolve-conflicts: failed to disable loser');
          }
        }
      }
      resync();
      const fresh = await loadStatus(deps);
      return reply.send({ ...fresh, disabled, failed });
    },
  );

  app.post<{
    Params: { name: string };
  }>(
    '/api/admin/templates/:name/push-bundled',
    { preHandler: auth },
    async (req, reply) => {
      const { name } = req.params;
      const parsed = parseName(name);
      if (!parsed) {
        return reply.code(400).send({
          code: 'invalid_template_name',
          message: `expected horizon.<overview|layer|alert>.<key>, got ${JSON.stringify(name)}`,
        });
      }
      resync(); // bypass the 30 s sync cache so create/update is decided on fresh OAP state
      const status = await loadStatus(deps);
      if (status.unreachable) {
        return reply.code(409).send({
          code: 'oap_unreachable',
          message: 'OAP admin port unreachable — templates are read-only',
        });
      }
      const row = status.rows.find((r) => r.name === name);
      if (!row?.bundled) {
        return reply.code(404).send({
          code: 'no_bundled',
          message: `no bundled template for ${name} — nothing to push`,
        });
      }
      try {
        if (row.remote) {
          await updateAndConfirm(deps.uiTemplateClient(), row.remote.id, row.bundled.configuration, logger);
        } else {
          await createAndConfirm(deps.uiTemplateClient(), row.bundled.configuration, logger);
        }
        resync();
        const fresh = await loadStatus(deps);
        return reply.send(fresh);
      } catch (err) {
        if (err instanceof WriteNotVisibleError) {
          logger.warn({ name, id: err.id }, 'push-bundled propagation timeout');
          return reply.code(504).send({
            code: 'oap_propagation_timeout',
            message: err.message,
            id: err.id,
          });
        }
        logger.warn({ err: errMsg(err), name }, 'push-bundled to OAP failed');
        return reply.code(502).send({
          code: 'oap_write_failed',
          message: errMsg(err),
        });
      }
    },
  );

  // Sync-all: push the bundled copy of every template that differs from
  // OAP (status `diverged`) or is absent from OAP (status
  // `bundled-fallback`) in one batch. Optionally scoped to a single
  // `kind` so the layer / overview admin pages each sync only their own
  // family. The caller is expected to have confirmed the operation (the
  // UI shows the affected list first); this route re-derives the diff
  // set server-side so a stale UI can't push something already in sync.
  app.post<{
    Body: { kind?: TemplateKind };
  }>('/api/admin/templates/sync-all', { preHandler: auth }, async (req, reply) => {
    const kind = req.body?.kind;
    resync(); // ensure the diff set comes from a fresh OAP read
    const status = await loadStatus(deps);
    if (status.unreachable) {
      return reply.code(409).send({
        code: 'oap_unreachable',
        message: 'OAP admin port unreachable — templates are read-only',
      });
    }
    const targets = status.rows.filter(
      (r) =>
        (!kind || r.kind === kind) &&
        !!r.bundled &&
        (r.status === 'diverged' || r.status === 'bundled-fallback'),
    );
    const synced: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const row of targets) {
      try {
        if (row.remote) {
          await updateAndConfirm(deps.uiTemplateClient(), row.remote.id, row.bundled!.configuration, logger);
        } else {
          await createAndConfirm(deps.uiTemplateClient(), row.bundled!.configuration, logger);
        }
        synced.push(row.name);
      } catch (err) {
        logger.warn({ err: errMsg(err), name: row.name }, 'sync-all push failed');
        failed.push({ name: row.name, error: errMsg(err) });
      }
    }
    resync();
    const fresh = await loadStatus(deps);
    return reply.send({ ...fresh, synced, failed });
  });

  // Revert-local: discard local edits by overwriting the BUNDLED file
  // with the REMOTE (live) version for every diverged template — the
  // "use live, override local" reconciliation when OAP holds the newer
  // copy. Optionally scoped by `kind`. Requires OAP reachable (we need
  // the remote content).
  app.post<{
    Body: { kind?: TemplateKind };
  }>('/api/admin/templates/revert-local', { preHandler: auth }, async (req, reply) => {
    const kind = req.body?.kind;
    const status = await loadStatus(deps);
    if (status.unreachable) {
      return reply.code(409).send({
        code: 'oap_unreachable',
        message: 'OAP admin port unreachable — cannot fetch the remote version',
      });
    }
    const targets = status.rows.filter(
      (r) => (!kind || r.kind === kind) && r.status === 'diverged' && !!r.remote,
    );
    const reverted: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const row of targets) {
      try {
        const env = parseEnvelope(row.remote!.configuration);
        if (!env) throw new Error('remote envelope not parseable');
        if (row.kind === 'layer') {
          writeLayerTemplate(env.content as LayerTemplate);
        } else if (row.kind === 'overview') {
          writeOverviewDashboard(row.key, env.content as OverviewDashboard);
        } else {
          throw new Error(`revert supports layer + overview, not ${row.kind}`);
        }
        reverted.push(row.name);
      } catch (err) {
        logger.warn({ err: errMsg(err), name: row.name }, 'revert-local failed');
        failed.push({ name: row.name, error: errMsg(err) });
      }
    }
    resync();
    const fresh = await loadStatus(deps);
    return reply.send({ ...fresh, reverted, failed });
  });

  // Save-local: write the edited template to the BUNDLED file on disk
  // (the local seed), NOT to OAP. The in-memory cache is refreshed so
  // the local instance immediately renders the edit; the template then
  // shows as `diverged` until the operator manually pushes it to OAP
  // via sync-all. This is the "edit locally → preview → publish" flow.
  app.post<{
    Body: { name?: string; content?: unknown };
  }>('/api/admin/templates/save-local', { preHandler: auth }, async (req, reply) => {
    const { name, content } = req.body ?? {};
    if (typeof name !== 'string' || content === undefined || content === null || typeof content !== 'object') {
      return reply.code(400).send({
        code: 'invalid_save_body',
        message: 'body must be { name: string, content: object }',
      });
    }
    const parsed = parseName(name);
    if (!parsed) {
      return reply.code(400).send({
        code: 'invalid_template_name',
        message: `expected horizon.<overview|layer|alert>.<key>, got ${JSON.stringify(name)}`,
      });
    }
    try {
      if (parsed.kind === 'layer') {
        writeLayerTemplate(content as Parameters<typeof writeLayerTemplate>[0]);
      } else if (parsed.kind === 'overview') {
        writeOverviewDashboard(parsed.key, content as Parameters<typeof writeOverviewDashboard>[1]);
      } else {
        return reply.code(400).send({
          code: 'unsupported_kind',
          message: `local save supports layer + overview templates, not ${parsed.kind}`,
        });
      }
    } catch (err) {
      logger.warn({ err: errMsg(err), name }, 'save-local (bundled write) failed');
      return reply.code(500).send({ code: 'local_write_failed', message: errMsg(err) });
    }
    resync();
    const fresh = await loadStatus(deps);
    return reply.send(fresh);
  });

  app.post<{
    Body: {
      name?: string;
      content?: unknown;
    };
  }>('/api/admin/templates/save', { preHandler: auth }, async (req, reply) => {
    const { name, content } = req.body ?? {};
    if (typeof name !== 'string' || content === undefined) {
      return reply.code(400).send({
        code: 'invalid_save_body',
        message: 'body must be { name: string, content: object }',
      });
    }
    const parsed = parseName(name);
    if (!parsed) {
      return reply.code(400).send({
        code: 'invalid_template_name',
        message: `expected horizon.<overview|layer|alert>.<key>, got ${JSON.stringify(name)}`,
      });
    }
    resync(); // fresh OAP read before deciding create-vs-update — peers / past races shouldn't leave us writing duplicates
    const status = await loadStatus(deps);
    if (status.unreachable) {
      return reply.code(409).send({
        code: 'oap_unreachable',
        message: 'OAP admin port unreachable — templates are read-only',
      });
    }
    const envelope = buildEnvelope(parsed.kind as TemplateKind, parsed.key, content);
    const configuration = serializeEnvelope(envelope);
    const existing = status.rows.find((r) => r.name === name);
    try {
      if (existing?.remote) {
        await updateAndConfirm(deps.uiTemplateClient(), existing.remote.id, configuration, logger);
      } else {
        await createAndConfirm(deps.uiTemplateClient(), configuration, logger);
      }
      resync();
      const fresh = await loadStatus(deps);
      return reply.send(fresh);
    } catch (err) {
      if (err instanceof WriteNotVisibleError) {
        logger.warn({ name, id: err.id }, 'save propagation timeout');
        return reply.code(504).send({
          code: 'oap_propagation_timeout',
          message: err.message,
          id: err.id,
        });
      }
      logger.warn({ err: errMsg(err), name }, 'save to OAP failed');
      return reply.code(502).send({
        code: 'oap_write_failed',
        message: errMsg(err),
      });
    }
  });

  /* POST /api/admin/templates/disable — "delete" a template. OAP has no
   * hard DELETE, so deletion is a soft `disable` of the remote UI-template
   * (a disabled row is dropped from the bundle, so the template vanishes
   * from the UI). Irreversible from the UI by design — there is no
   * re-enable entrance.
   *
   *   - remote present       → disable that row.
   *   - bundled, no remote    → create a remote from the bundled config
   *     first (so OAP has a row to flag), then disable it; otherwise a
   *     bundled-fallback has no id to disable and the bundle keeps serving.
   *   - neither               → nothing on OAP (a local-only browser draft
   *     is removed client-side); no-op.
   *
   * Local-only drafts never reach here — the SPA removes them from the
   * browser directly (a true hard delete; they were never on OAP). */
  app.post<{ Body: { name?: string } }>(
    '/api/admin/templates/disable',
    { preHandler: auth },
    async (req, reply) => {
      const { name } = req.body ?? {};
      if (typeof name !== 'string') {
        return reply.code(400).send({
          code: 'invalid_disable_body',
          message: 'body must be { name: string }',
        });
      }
      if (!parseName(name)) {
        return reply.code(400).send({
          code: 'invalid_template_name',
          message: `expected horizon.<overview|layer|alert>.<key>, got ${JSON.stringify(name)}`,
        });
      }
      resync(); // disable picks bundled-fallback vs remote based on status — must be fresh, or we create a duplicate
      const status = await loadStatus(deps);
      if (status.unreachable) {
        return reply.code(409).send({
          code: 'oap_unreachable',
          message: 'OAP admin port unreachable — templates are read-only',
        });
      }
      const row = status.rows.find((r) => r.name === name);
      if (!row?.remote && !row?.bundled) {
        // Nothing on OAP and no bundle — already gone.
        return reply.send(await loadStatus(deps));
      }
      try {
        if (row.remote) {
          await disableAndConfirm(deps.uiTemplateClient(), row.remote.id, logger);
        } else if (row.bundled) {
          // Bundled-fallback (no remote yet): materialise a remote from the
          // bundled config so there's a row to flag disabled.
          const id = await createAndConfirm(deps.uiTemplateClient(), row.bundled.configuration, logger);
          await disableAndConfirm(deps.uiTemplateClient(), id, logger);
        }
        resync();
        return reply.send(await loadStatus(deps));
      } catch (err) {
        if (err instanceof WriteNotVisibleError) {
          logger.warn({ name, id: err.id }, 'disable bundled-fallback create propagation timeout');
          return reply.code(504).send({
            code: 'oap_propagation_timeout',
            message: err.message,
            id: err.id,
          });
        }
        logger.warn({ err: errMsg(err), name }, 'disable on OAP failed');
        return reply.code(502).send({ code: 'oap_write_failed', message: errMsg(err) });
      }
    },
  );
}

async function loadStatus(deps: TemplateSyncAdminDeps): Promise<SyncStatus> {
  return getSyncStatus({
    client: deps.uiTemplateClient(),
    bundled: () => iterateBundledTemplates(),
    logger,
  });
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
