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

import type { FastifyReply } from 'fastify';

/**
 * A signal that fires when the client has stopped listening.
 *
 * Read routes hand this to `buildOapOpts` so an abandoned request stops costing
 * OAP work. Without it the BFF ran every read to completion regardless: a
 * refresh round that gave up after its cap cancelled the browser's socket while
 * the queries it started carried on upstream, and a page abandoned mid-load
 * left its whole fan-out running. On a cluster fan-out that is one abandoned
 * request multiplied by the node count.
 *
 * **Reads only.** A request that MUTATES — creating a profiling task, pushing a
 * template — must run to completion even if the operator navigates away, or a
 * closed tab could leave a half-applied change with nobody watching. Those
 * routes deliberately pass nothing.
 *
 * The reply's `close` is what says the client went away, and only when the
 * response had not finished: `close` also fires on every successful reply, and
 * aborting then would cancel work that had already succeeded.
 */
export function clientGone(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  // Already gone. A route that awaits something before reaching here — a
  // template resolution on a cold cache, say — can be called after the client
  // has hung up, and `close` has then already fired with nobody listening. The
  // work would run to completion for a socket that no longer exists.
  //
  // Asked of the RESPONSE only. The request's readable is destroyed as soon as
  // its body has been read — Node auto-destroys it on `end` — so it reads as
  // destroyed in every handler, for a GET as much as a POST, and says nothing
  // about whether anyone is still listening.
  if (reply.raw.destroyed && !reply.raw.writableFinished) {
    ac.abort();
    return ac.signal;
  }
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  return ac.signal;
}
