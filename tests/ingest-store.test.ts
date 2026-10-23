import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitBatch, findReceipt, IngestStoreError } from '../worker/ingest-store';
import type { IngestBatch } from '../worker/ingest-validation';

function sqliteD1(db: DatabaseSync): D1Database {
  // Match D1's documented transactional batch behavior, including rollback
  // when a later window/status statement violates a SQLite constraint.
  return {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first() { return db.prepare(sql).get(...bindings as []) ?? null; },
        async all() { return { results: db.prepare(sql).all(...bindings as []), success: true, meta: {} }; },
        async run() {
          const result = db.prepare(sql).run(...bindings as []);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

const fixture = (name: string): IngestBatch => JSON.parse(readFileSync(new URL(`../docs/specs/examples/${name}`, import.meta.url), 'utf8')) as IngestBatch;
const windows = () => fixture('ble-windows.request.json') as Extract<IngestBatch, { stream: 'ble_windows' }>;
const reports = () => fixture('ble-reports.request.json') as Extract<IngestBatch, { stream: 'ble_reports' }>;
const status = () => fixture('node-status.request.json') as Extract<IngestBatch, { stream: 'node_status' }>;
const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
let db: DatabaseSync;
let d1: D1Database;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_ingestion.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO device_nodes (id,credential_sha256) VALUES (?,?)').run('cp-demo-01', 'c'.repeat(64));
  db.prepare('INSERT INTO placements (id,node_id,place_id,valid_from_ms) VALUES (?,?,?,?)')
    .run('demo-placement-01', 'cp-demo-01', 'library', NOW - 1000);
  db.prepare('INSERT INTO capture_configs (id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES (?,?,?,?,?,?)')
    .run('demo-capture-raw-v1', 'cp-demo-01', 'demo-placement-01', 'demo',
      readFileSync(new URL('../docs/specs/examples/capture-config.fixture.json', import.meta.url), 'utf8'),
      NOW + 7 * 86400000);
  d1 = sqliteD1(db);
});
afterEach(() => db.close());

describe('durable ingestion receipts', () => {
  it('commits the receipt and all window records and returns the same ACK on retry', async () => {
    const batch = windows();
    const first = await commitBatch(d1, batch, HASH_A, null, NOW);
    expect(first.duplicate).toBe(false);
    expect(first.ack).toMatchObject({ node_id: batch.node_id, stream: 'ble_windows', body_sha256: HASH_A, accepted_count: 1, durability: 'committed' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sensor_windows').get()).toMatchObject({ n: 1 });
    const saved = db.prepare('SELECT item_json,expires_at_ms FROM sensor_windows').get() as { item_json: string; expires_at_ms: number };
    expect(JSON.parse(saved.item_json)).toEqual(batch.items[0]);
    expect(saved.expires_at_ms).toBe(NOW + 7 * 86400000);
    const retry = await commitBatch(d1, batch, HASH_A, null, NOW + 9000000);
    expect(retry).toEqual({ ack: first.ack, duplicate: true });
    expect((await findReceipt(d1, batch.node_id, batch.batch_id))?.retain_until_ms).toBe(NOW + 14 * 86400000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ingestion_batches').get()).toMatchObject({ n: 1 });
  });

  it('rejects changed bytes and overlapping inclusive ranges, including skipped seq gaps', async () => {
    const batch = windows();
    await commitBatch(d1, batch, HASH_A, null, NOW);
    await expect(commitBatch(d1, batch, HASH_B, null, NOW)).rejects.toMatchObject({ status: 409, code: 'batch_conflict' });
    const second = { ...batch, batch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    await expect(commitBatch(d1, second, HASH_B, null, NOW)).rejects.toMatchObject({ status: 409, code: 'seq_range_overlap' });
    const opaqueD1 = {
      ...d1,
      async batch(statements: D1PreparedStatement[]) {
        try { return await d1.batch(statements); }
        catch { throw new Error('D1 batch failed'); }
      },
    } as D1Database;
    await expect(commitBatch(opaqueD1, second, HASH_B, null, NOW))
      .rejects.toMatchObject({ status: 409, code: 'seq_range_overlap' });

    const gapBatch = { ...batch, batch_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', items: [
      { ...batch.items[0], seq: 10 }, { ...batch.items[0], seq: 12 },
    ] };
    await commitBatch(d1, gapBatch, HASH_B, null, NOW);
    const insideGap = { ...batch, batch_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', items: [{ ...batch.items[0], seq: 11 }] };
    await expect(commitBatch(d1, insideGap, HASH_B, null, NOW)).rejects.toMatchObject({ code: 'seq_range_overlap' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ingestion_batches').get()).toMatchObject({ n: 2 });
  });

  it('stores a raw batch index without creating per-report D1 rows', async () => {
    const batch = reports();
    const key = `raw/${batch.node_id}/${batch.batch_id}/${HASH_A}.json`;
    const result = await commitBatch(d1, batch, HASH_A, key, NOW);
    expect(result.ack.accepted_count).toBe(1);
    expect(db.prepare('SELECT raw_object_key,expires_at_ms FROM ingestion_batches WHERE batch_id = ?').get(batch.batch_id))
      .toMatchObject({ raw_object_key: key, expires_at_ms: NOW + 86400000 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sensor_windows').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM node_status').get()).toMatchObject({ n: 0 });
    await expect(commitBatch(d1, { ...batch, batch_id: crypto.randomUUID() }, HASH_B, key, NOW))
      .rejects.toMatchObject({ code: 'seq_range_overlap' });
  });

  it('rolls back the receipt if a later record insert fails', async () => {
    const batch = windows();
    const invalid = { ...batch, items: [{ ...batch.items[0], duration_ms: 0 }] } as IngestBatch;
    await expect(commitBatch(d1, invalid, HASH_A, null, NOW)).rejects.toThrow();
    expect(await findReceipt(d1, batch.node_id, batch.batch_id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sensor_windows').get()).toMatchObject({ n: 0 });
  });

  it('preserves config and placement history and accepts status independently', async () => {
    db.prepare('UPDATE device_nodes SET credential_sha256 = ? WHERE id = ?').run('d'.repeat(64), 'cp-demo-01');
    expect(db.prepare('SELECT credential_sha256 FROM device_nodes WHERE id = ?').get('cp-demo-01'))
      .toMatchObject({ credential_sha256: 'd'.repeat(64) });
    expect(() => db.prepare('UPDATE device_nodes SET id = ? WHERE id = ?').run('renamed', 'cp-demo-01'))
      .toThrow(/node_id_immutable/);
    expect(() => db.prepare('UPDATE placements SET place_id = ? WHERE id = ?').run(null, 'demo-placement-01'))
      .toThrow(/placement_immutable/);
    expect(() => db.prepare('UPDATE capture_configs SET dataset = ? WHERE id = ?').run('field', 'demo-capture-raw-v1'))
      .toThrow(/capture_config_immutable/);
    expect(() => db.prepare('INSERT INTO capture_configs (id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES (?,?,?,?,?,?)')
      .run('mismatched', 'cp-demo-01', 'demo-placement-01', 'demo',
        readFileSync(new URL('../docs/specs/examples/capture-config.fixture.json', import.meta.url), 'utf8'), NOW + 7 * 86400000))
      .toThrow();
    const batch = status();
    await commitBatch(d1, batch, HASH_A, null, NOW);
    expect(db.prepare('SELECT COUNT(*) AS n FROM node_status').get()).toMatchObject({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sensor_windows').get()).toMatchObject({ n: 0 });
    await expect(commitBatch(d1, { ...batch, batch_id: crypto.randomUUID() }, HASH_B, null, NOW + 8 * 86400000))
      .rejects.toMatchObject({ status: 410, code: 'capture_config_expired' });
  });

  it('closes a placement without rewriting queued data or allowing reopening', async () => {
    const end = NOW + 60000;
    expect(() => db.prepare('INSERT INTO placements (id,node_id,place_id,valid_from_ms) VALUES (?,?,?,?)')
      .run('next-placement', 'cp-demo-01', 'library', end))
      .toThrow(/placement_interval_overlap/);
    expect(() => db.prepare('INSERT INTO placement_closures (placement_id,node_id,valid_until_ms,recorded_at) VALUES (?,?,?,?)')
      .run('demo-placement-01', 'cp-demo-01', NOW - 1000, new Date(NOW).toISOString()))
      .toThrow(/placement_closure_invalid/);
    db.prepare('INSERT INTO placement_closures (placement_id,node_id,valid_until_ms,recorded_at) VALUES (?,?,?,?)')
      .run('demo-placement-01', 'cp-demo-01', end, new Date(NOW + 120000).toISOString());
    db.prepare('INSERT INTO placements (id,node_id,place_id,valid_from_ms) VALUES (?,?,?,?)')
      .run('next-placement', 'cp-demo-01', 'library', end);
    expect(() => db.prepare('UPDATE placement_closures SET valid_until_ms = ? WHERE placement_id = ?')
      .run(end + 1000, 'demo-placement-01')).toThrow(/placement_closure_immutable/);
    expect(() => db.prepare('DELETE FROM placement_closures WHERE placement_id = ?')
      .run('demo-placement-01')).toThrow(/placement_closure_immutable/);
    const batch = windows();
    const queued = { ...batch, items: [{ ...batch.items[0], time: { ...batch.items[0].time, utc_ms: NOW + 30000 } }] };
    await commitBatch(d1, queued, HASH_A, null, NOW + 120000);
    const publicEligible = db.prepare(`SELECT COUNT(*) AS n FROM sensor_windows w
      JOIN placements p ON p.id = w.placement_id AND p.node_id = w.node_id
      LEFT JOIN placement_closures c ON c.placement_id = p.id AND c.node_id = p.node_id
      WHERE w.utc_ms - w.duration_ms >= p.valid_from_ms
        AND w.utc_ms <= COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)`).get();
    expect(publicEligible).toMatchObject({ n: 1 });
    expect(() => db.prepare('INSERT INTO placement_closures (placement_id,node_id,valid_until_ms,recorded_at) VALUES (?,?,?,?)')
      .run('demo-placement-01', 'cp-demo-01', end + 1000, new Date(NOW + 130000).toISOString())).toThrow();
  });
});
