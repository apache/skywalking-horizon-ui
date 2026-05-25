import { loadConfig } from './config/loader.js';
import { buildOapClients } from './client/index.js';
import { parseEnvelope } from './logic/templates/names.js';
import { createHash } from 'node:crypto';
const cfg = loadConfig(process.env.HORIZON_CONFIG!);
const client = buildOapClients(cfg.current).uiTemplate();
const rows = await client.list();
const byName = new Map<string, Array<{ id: string; disabled: boolean; configHash: string; configLen: number }>>();
for (const r of rows) {
  const env = parseEnvelope(r.configuration);
  if (!env) continue;
  const list = byName.get(env.name) ?? [];
  list.push({
    id: r.id,
    disabled: r.disabled,
    configHash: createHash('sha256').update(r.configuration).digest('hex').slice(0, 16),
    configLen: r.configuration.length,
  });
  byName.set(env.name, list);
}
const dupes = Array.from(byName.entries()).filter(([, v]) => v.length > 1);
console.log(`OAP total rows: ${rows.length}, distinct names: ${byName.size}, names with duplicates: ${dupes.length}`);
console.log();
for (const [name, list] of dupes) {
  const uniqueHashes = new Set(list.map((r) => r.configHash));
  console.log(`■ ${name}  (${list.length} rows, ${uniqueHashes.size} distinct configurations)`);
  for (const r of list) {
    console.log(`    ${r.disabled ? 'DISABLED' : 'enabled '}  id=${r.id}  hash=${r.configHash}  bytes=${r.configLen}`);
  }
  console.log();
}
