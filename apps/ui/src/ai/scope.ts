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

// The assistant's own time window (triage surfaces own their range, not the topbar).
// Held here for M1; the M2 stream will scope its queries to this window.
import { ref } from 'vue';

export interface AiTimePreset {
  id: string;
  minutes: number;
  labelKey: string;
}

export const AI_TIME_PRESETS: AiTimePreset[] = [
  { id: '15m', minutes: 15, labelKey: 'Last 15 minutes' },
  { id: '1h', minutes: 60, labelKey: 'Last 1 hour' },
  { id: '6h', minutes: 360, labelKey: 'Last 6 hours' },
  { id: '24h', minutes: 1440, labelKey: 'Last 24 hours' },
  { id: '3d', minutes: 4320, labelKey: 'Last 3 days' },
  { id: '7d', minutes: 10080, labelKey: 'Last 7 days' },
];

export const aiTimePresetId = ref<string>('1h');
