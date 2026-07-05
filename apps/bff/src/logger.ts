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

import pino, { type LoggerOptions } from 'pino';

// Production unless explicitly opted into dev. Matters because the
// "production target" includes both `node dist/server.js` (local
// binary) and the Docker image — both should be quiet by default and
// emit machine-readable JSON for log aggregators. Only `pnpm dev` /
// `tsx watch` flips into dev mode (its `dev` script sets
// NODE_ENV=development).
const isDev = process.env.NODE_ENV === 'development';

/**
 * Default log level:
 *   - dev (`NODE_ENV=development`, e.g. `pnpm --filter bff dev`):
 *     `debug` — verbose lifecycle + per-request access logs, pretty-
 *     printed via `pino-pretty` for human reading.
 *   - prod (anything else, incl. local `node dist/server.js` and the
 *     Docker image): `error` — quiet by default. Fastify's per-request
 *     `info` access logs are suppressed; only warnings, errors, and
 *     fatals reach stdout as JSON.
 *
 * Operators turn it up explicitly when triaging: `LOG_LEVEL=info` for
 * access logs, `LOG_LEVEL=debug` for the lifecycle chatter, `trace`
 * for everything pino-instrumented code emits.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'error'),
  // Backstop redaction for LLM-provider secrets. The AI api key is env-only and
  // never intentionally logged, but a stray `logger.info({ config })` must not
  // leak it. Paths cover the config shape, any `*.apiKey`, and the raw SDK field.
  redact: {
    paths: [
      'ai.apiKey',
      'config.ai.apiKey',
      '*.apiKey',
      '*.bedrockBearerToken',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
};

export const logger = pino(loggerOptions);
