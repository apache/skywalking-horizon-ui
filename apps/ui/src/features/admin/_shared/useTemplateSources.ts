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
 * Fetches the BFF sync rows for one template kind and exposes, per
 * template name, the BUNDLED and REMOTE content objects — the two
 * server-side versions of a template. The admin pages combine these
 * with the browser LOCAL draft (controls/localTemplateEdits) to drive
 * the Local / Bundled / Remote source selector in the editor.
 *
 * The row's `configuration` is the canonical envelope
 * `{ name, kind, version, content }`; we return `content` (the actual
 * template object).
 */

import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { bff } from '@/api/client';
import type { TemplateKind } from '@/api/scopes/configs';

function envelopeContent<T>(configuration: string | undefined | null): T | null {
  if (!configuration) return null;
  try {
    const env = JSON.parse(configuration) as { content?: unknown };
    return (env?.content ?? null) as T | null;
  } catch {
    return null;
  }
}

export function useTemplateSources(kind: TemplateKind) {
  const q = useQuery({
    queryKey: ['admin/template-sources', kind],
    queryFn: () => bff.templateSync.syncStatus(),
    staleTime: 30_000,
  });

  const rowsByName = computed(() => {
    const m = new Map<string, { bundled: string | null; remote: string | null }>();
    for (const r of q.data.value?.rows ?? []) {
      if (r.kind !== kind) continue;
      m.set(r.name, {
        bundled: r.bundled?.configuration ?? null,
        remote: r.remote?.configuration ?? null,
      });
    }
    return m;
  });

  return {
    isLoading: q.isLoading,
    refetch: q.refetch,
    /** Bundled (shipped) content for a template name, or null. */
    bundled<T>(name: string): T | null {
      return envelopeContent<T>(rowsByName.value.get(name)?.bundled);
    },
    /** Remote (OAP live) content for a template name, or null. */
    remote<T>(name: string): T | null {
      return envelopeContent<T>(rowsByName.value.get(name)?.remote);
    },
    /** True when OAP currently serves this template. */
    hasRemote(name: string): boolean {
      return !!rowsByName.value.get(name)?.remote;
    },
    /** Names of every template OAP currently serves (this kind). Lets an
     *  admin page surface remote-only templates — ones that exist on OAP
     *  with no bundled/disk base, e.g. a dashboard created + pushed here. */
    remoteNames(): string[] {
      const out: string[] = [];
      for (const [name, row] of rowsByName.value) if (row.remote) out.push(name);
      return out;
    },
    /** True when this template ships a bundled (built-in) default. Such a
     *  template can't be deleted — removing the OAP copy just falls back
     *  to the bundle, so the row would reappear. */
    hasBundled(name: string): boolean {
      return !!rowsByName.value.get(name)?.bundled;
    },
  };
}
