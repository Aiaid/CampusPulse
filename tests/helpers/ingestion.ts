import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../../worker/types';
import { sha256 } from '../../worker/ingest';
import type { CaptureConfig } from '../../worker/ingest-validation';

export const DEVICE_TOKEN = 'synthetic-device-token-only-for-tests';
export function sqliteD1(db: DatabaseSync): D1Database {
  const statements = new WeakMap<object, () => unknown>();
  return {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const run = () => { const result = db.prepare(sql).run(...bindings as []); return { success: true, results: [], meta: { changes: Number(result.changes) } }; };
      const statement = {
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first() { return db.prepare(sql).get(...bindings as []) ?? null; },
        async all() { return { results: db.prepare(sql).all(...bindings as []), success: true, meta: {} }; },
        async run() { return run(); },
      };
      statements.set(statement, run);
      return statement;
    },
    async batch(items: object[]) {
      db.exec('BEGIN');
      try { const result = items.map(item => statements.get(item)!()); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
}
export function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../../docs/specs/examples/${name}.json`, import.meta.url), 'utf8'));
}
export function memoryR2() {
  const objects = new Map<string, Uint8Array>();
  let failPut = false;
  return {
    objects,
    set failPut(value: boolean) { failPut = value; },
    bucket: {
      async put(key: string, bytes: Uint8Array, options: R2PutOptions) {
        if (failPut) throw new Error('Synthetic R2 failure');
        if (options.onlyIf && objects.has(key)) return null;
        objects.set(key, bytes.slice());
        return { key, size: bytes.byteLength };
      },
      async get(key: string) {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer } : null;
      },
      async delete(key: string) { objects.delete(key); },
    } as unknown as R2Bucket,
  };
}
export async function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const migration of readdirSync(new URL('../../migrations/', import.meta.url)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) db.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  const config = fixture('capture-config.fixture') as CaptureConfig;
  config.accept_until = new Date(Date.now() + 86_400_000).toISOString();
  db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES (?,?)').run(config.node_id, await sha256(new TextEncoder().encode(DEVICE_TOKEN)));
  db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES (?,?,?,?)').run(config.placement_id, config.node_id, 'library', 0);
  seedConfig(db, config);
  const raw = memoryR2();
  const env: Env = { DB: sqliteD1(db), RAW_BUCKET: raw.bucket, RESEARCH_TOKEN: 'synthetic-research-token', OPERATOR_TOKEN: 'synthetic-operator-token' };
  return { db, env, config, raw };
}
export function seedConfig(db: DatabaseSync, config: CaptureConfig, maxBytes?: number) {
  if (maxBytes) config.upload_policy.max_body_bytes = maxBytes;
  db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES (?,?,?,?,?,?)')
    .run(config.capture_config_id, config.node_id, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until));
}
