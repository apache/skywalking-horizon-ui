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
 * Log tag autocomplete — the keys, and a key's values, the log Tags field
 * suggests.
 *
 * An OAP with the `TagType` enum keeps the tags of OTLP logs (`OTLP_LOG`) apart
 * from those of every other log (`LOG`); the layer's log type picks which list
 * is read. An older OAP rejects a document naming `TagType`, so it gets the
 * untyped request, which reads its only list.
 */

import type { FetchLike, LogType } from '@skywalking-horizon-ui/api-client';
import type { HorizonConfig } from '../../config/schema.js';
import { graphqlPost, type GraphqlOptions } from '../../client/graphql.js';
import { getOapCapabilities } from './capabilities.js';

const KEYS_QUERY = /* GraphQL */ `
  query LogTagKeys($duration: Duration!) {
    keys: queryLogTagAutocompleteKeys(duration: $duration)
  }
`;
const VALUES_QUERY = /* GraphQL */ `
  query LogTagValues($tagKey: String!, $duration: Duration!) {
    values: queryLogTagAutocompleteValues(tagKey: $tagKey, duration: $duration)
  }
`;
const KEYS_BY_TYPE_QUERY = /* GraphQL */ `
  query LogTagKeysByType($duration: Duration!, $type: TagType!) {
    keys: queryLogTagAutocompleteKeys(duration: $duration, type: $type)
  }
`;
const VALUES_BY_TYPE_QUERY = /* GraphQL */ `
  query LogTagValuesByType($tagKey: String!, $duration: Duration!, $type: TagType!) {
    values: queryLogTagAutocompleteValues(tagKey: $tagKey, duration: $duration, type: $type)
  }
`;
const TAG_TYPE: Record<LogType, 'LOG' | 'OTLP_LOG'> = { native: 'LOG', otlp: 'OTLP_LOG' };

export interface LogTagRead {
  config: HorizonConfig;
  fetch?: FetchLike;
  /** Carries the caller's cancellation. */
  opts: GraphqlOptions;
  duration: { start: string; end: string; step: string };
  logType: LogType;
}

export function readLogTagKeys(read: LogTagRead): Promise<string[]> {
  return readTags(read, 'keys', KEYS_QUERY, KEYS_BY_TYPE_QUERY, { duration: read.duration });
}

export function readLogTagValues(read: LogTagRead, tagKey: string): Promise<string[]> {
  return readTags(read, 'values', VALUES_QUERY, VALUES_BY_TYPE_QUERY, { tagKey, duration: read.duration });
}

async function readTags<F extends 'keys' | 'values'>(
  read: LogTagRead,
  field: F,
  untypedQuery: string,
  byTypeQuery: string,
  variables: Record<string, unknown>,
): Promise<string[]> {
  const caps = await getOapCapabilities(read.config, read.fetch, read.opts.signal);
  const [query, vars] = caps.logTagType
    ? [byTypeQuery, { ...variables, type: TAG_TYPE[read.logType] }]
    : [untypedQuery, variables];
  return (await graphqlPost<Partial<Record<F, string[] | null>>>(read.opts, query, vars))[field] ?? [];
}
