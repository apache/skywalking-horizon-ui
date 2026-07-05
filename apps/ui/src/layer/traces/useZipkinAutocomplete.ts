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
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import { bffClient } from '@/api/client';

/**
 * The Zipkin Traces tab's three autocomplete subsystems, mirroring
 * Zipkin Lens's search wiring. Each owns its own fetch + watch +
 * debounce and tears the debounce timer down on unmount.
 *
 *   1. Services    — the full `/api/v2/services` list, loaded once per
 *                    layer for the Service filter dropdown.
 *   2. Span / remote — SERVICE-SCOPED (`/api/v2/spans?serviceName=` and
 *                    `/api/v2/remoteServices?serviceName=`); refresh as
 *                    the operator types a service. Blank service clears
 *                    both (Zipkin has no "all spans"/"all remotes"). The
 *                    debounce also resets the dependent `spanName` /
 *                    `remoteServiceName` inputs the caller passes so a
 *                    stale value can't run against "All services".
 *   3. Annotations — pre-configured key set (`/api/v2/autocompleteKeys`)
 *                    + per-key values (`/api/v2/autocompleteValues?key=`),
 *                    swapped by the last `key=value` token the operator
 *                    typed. Keys aren't service-scoped, so one load per
 *                    layer is enough.
 *
 * Inputs:
 *   layerKey            — drives the once-per-layer service + key loads.
 *   serviceFilter       — the Service input; span/remote options follow it.
 *   annotationQuery     — the annotations input; the key=value cursor.
 *   spanName / remote   — dependent inputs reset when the service clears.
 */
export function useZipkinAutocomplete(opts: {
  layerKey: ComputedRef<string> | Ref<string>;
  serviceFilter: Ref<string>;
  annotationQuery: Ref<string>;
  spanName: Ref<string>;
  remoteServiceName: Ref<string>;
  /** Only the interactive toolbar needs these option lists. Pass false (the
   *  embedded chat block, whose toolbar is hidden) to skip ALL autocomplete
   *  fetches — services / span names / remote services / annotation keys. */
  enabled?: boolean;
}) {
  const { layerKey, serviceFilter, annotationQuery, spanName, remoteServiceName } = opts;
  const enabled = opts.enabled ?? true;

  const serviceOptions = ref<string[]>([]);
  // Best-effort: a failed fetch leaves the input as plain text.
  async function loadServiceOptions(): Promise<void> {
    try {
      const res = await bffClient.zipkin.services();
      // De-duplicate (OAP sometimes returns the same name twice).
      serviceOptions.value = Array.from(new Set(Array.isArray(res) ? res : []));
    } catch { /* noop */ }
  }
  watch(layerKey, () => { if (enabled) void loadServiceOptions(); }, { immediate: true });

  const spanNameOptions = ref<string[]>([]);
  const remoteSvcOptions = ref<string[]>([]);
  async function loadAutocomplete(svc: string): Promise<void> {
    if (!svc) {
      spanNameOptions.value = [];
      remoteSvcOptions.value = [];
      return;
    }
    try {
      const sp = await bffClient.zipkin.spans(svc);
      spanNameOptions.value = Array.isArray(sp) ? sp : [];
    } catch { spanNameOptions.value = []; }
    try {
      const rs = await bffClient.zipkin.remoteServices(svc);
      remoteSvcOptions.value = Array.isArray(rs) ? rs : [];
    } catch { remoteSvcOptions.value = []; }
  }
  // Debounce so typing doesn't fire on every keystroke. When the
  // service is cleared we also reset the dependent fields — running a
  // query with stale span/remote values against "All services" would
  // otherwise silently filter out everything.
  let autocompleteTimer: ReturnType<typeof setTimeout> | null = null;
  watch(serviceFilter, (v) => {
    if (!enabled) return;
    if (autocompleteTimer) clearTimeout(autocompleteTimer);
    const trimmed = v.trim();
    if (!trimmed) {
      spanName.value = '';
      remoteServiceName.value = '';
    }
    autocompleteTimer = setTimeout(() => { void loadAutocomplete(trimmed); }, 250);
  }, { immediate: true });

  const annotationKeyOptions = ref<string[]>([]);
  const annotationValueOptions = ref<string[]>([]);
  const annotationValueKey = ref<string>('');
  async function loadAnnotationKeys(): Promise<void> {
    try {
      const res = await bffClient.zipkin.autocompleteKeys();
      annotationKeyOptions.value = Array.isArray(res) ? res : [];
    } catch { /* best-effort */ }
  }
  async function loadAnnotationValues(key: string): Promise<void> {
    if (!key || key === annotationValueKey.value) return;
    annotationValueKey.value = key;
    try {
      const res = await bffClient.zipkin.autocompleteValues(key);
      annotationValueOptions.value = Array.isArray(res) ? res : [];
    } catch { /* noop */ }
  }
  function onAnnotationInput(): void {
    // Operator can chain `k1=v1 k2=v2`; we look at the last token to
    // decide whether to show keys or values.
    const last = (annotationQuery.value.split(/\s+/).pop() ?? '').trim();
    const eq = last.indexOf('=');
    if (eq === -1) return; // keys datalist is active by default
    const key = last.slice(0, eq).trim();
    if (key) void loadAnnotationValues(key);
  }
  const annotationDatalistOptions = computed<string[]>(() => {
    const last = (annotationQuery.value.split(/\s+/).pop() ?? '').trim();
    const eq = last.indexOf('=');
    if (eq === -1) return annotationKeyOptions.value;
    const key = last.slice(0, eq).trim();
    return annotationValueOptions.value.map((v) => `${key}=${v}`);
  });
  // Eagerly load keys once we know the layer — keys aren't service-
  // scoped, so a single load on mount is enough.
  watch(layerKey, (k) => { if (enabled && k) void loadAnnotationKeys(); }, { immediate: true });

  onBeforeUnmount(() => {
    if (autocompleteTimer) clearTimeout(autocompleteTimer);
  });

  return {
    serviceOptions,
    spanNameOptions,
    remoteSvcOptions,
    annotationDatalistOptions,
    onAnnotationInput,
  };
}
