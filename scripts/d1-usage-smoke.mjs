// Reproducible synthetic workload on ephemeral workerd/D1, never production.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = name => JSON.parse(readFileSync(`docs/specs/examples/${name}.json`, 'utf8'));
const migrations = readdirSync('migrations').filter(name => /^\d+.*\.sql$/.test(name)).sort();
const upgrade = migrations.filter(name => Number(name.slice(0, 4)) >= 9);
const compiled = await build({ stdin: { contents: "export { commitBatchV2 } from './worker/device-v2-store'; export { validateEnvelopeV2, validateConfigBatchV2, validateCaptureConfigV2 } from './worker/device-v2-validation';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true,
  write: false, format: 'esm', platform: 'node', target: 'es2022' });
const { commitBatchV2, validateEnvelopeV2, validateConfigBatchV2, validateCaptureConfigV2 } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'd1-usage-smoke', modules: true,
  script: 'export default {fetch(){return new Response("synthetic usage smoke")}}',
  compatibilityDate: '2026-10-23', d1Databases: ['BEFORE', 'AFTER'] }] }));
const now = Date.now();
const config = fixture('capture-config-v2.fixture');
// The field label exercises partial public indexes only in this local fixture.
config.dataset = 'field'; config.accept_until = new Date(now + 86400000).toISOString();
config.summary.max_addresses = 16;
validateCaptureConfigV2(config);
const boot = randomUUID(), batches = [];
let summarySeq = 0;
for (let window = 1; window <= 40; window++) {
  const time = { utc_ms: now - (41 - window) * 30000, mono_ms: window * 30000,
    clock_epoch: 1, uncertainty_ms: 20 };
  const envelope = (source, stream, items) => ({ ...source, protocol: 'campuspulse/2', batch_id: randomUUID(),
    boot_id: boot, node_id: config.node_id, capture_config_id: config.capture_config_id,
    placement_id: config.placement_id, dataset: config.dataset, stream, items });
  const w = fixture('ble-windows-v2.request');
  batches.push(envelope(w, 'ble_windows', [{ ...w.items[0], seq: window, time,
    unique_table_capacity: 16, visible_identifiers: 16, reports_seen: 96,
    reports_aggregated: 96, adv_reports: 96, rssi: { ...w.items[0].rssi, samples: 96 } }]));
  const summary = fixture('address-summaries-v2.request');
  const items = Array.from({ length: 16 }, (_, address) => ({ ...structuredClone(summary.items[0]),
    seq: ++summarySeq, window_seq: window, time,
    address: `02:00:00:00:00:${(address + 1).toString(16).padStart(2, '0')}` }));
  for (let first = 0; first < items.length; first += 6)
    batches.push(envelope(summary, 'address_summaries', items.slice(first, first + 6)));
  const status = fixture('node-status-v2.request');
  batches.push(envelope(status, 'node_status', [{ ...status.items[0], seq: window, time, uptime_ms: time.mono_ms }]));
}
try {
  for (const batch of batches) validateConfigBatchV2(validateEnvelopeV2(batch), config);
} catch (error) {
  console.error('Invalid synthetic usage fixture:', error.message);
  await mf.dispose(); process.exit(1);
}
const apply = async (db, names) => {
  for (const name of names) await db.exec(readFileSync(`migrations/${name}`, 'utf8')
    .replace(/^[\t ]*--.*$/gm, '').replace(/\n/g, ' '));
};
const fingerprint = async db => {
  const items = await db.prepare('SELECT * FROM ingestion_items_v2 ORDER BY node_id,boot_id,stream,seq').all();
  const receipts = await db.prepare('SELECT * FROM ingestion_batches_v2 ORDER BY node_id,batch_id').all();
  const budgets = await db.prepare('SELECT * FROM ingestion_window_budgets_v2 ORDER BY node_id,boot_id,stream,window_seq').all();
  return hash(JSON.stringify([items.results, receipts.results, budgets.results]));
};
const seed = async db => {
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(config.node_id, hash('synthetic-cost-device-token')).run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)')
    .bind(config.placement_id, config.node_id, 'library', 0).run();
  await db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
    .bind(config.capture_config_id, config.node_id, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until)).run();
};
const run = async db => {
  const totals = { rows_read: 0, rows_written: 0 }, streams = {};
  let activeStream;
  const tracked = { prepare: db.prepare.bind(db), async batch(statements) {
    const results = await db.batch(statements);
    for (const result of results) for (const key of ['rows_read', 'rows_written']) {
      totals[key] += result.meta[key];
      streams[activeStream][key] += result.meta[key];
    }
    return results;
  } };
  const commit = async (batch, digest = hash(JSON.stringify(batch))) => commitBatchV2(tracked, batch,
    digest, null, 24, 30, Date.parse(config.accept_until), now);
  for (const batch of batches) {
    activeStream = batch.stream;
    streams[activeStream] ??= { batches: 0, items: 0, rows_read: 0, rows_written: 0 };
    await commit(batch); streams[activeStream].batches++; streams[activeStream].items += batch.items.length;
  }
  const frozen = batches.find(batch => batch.stream === 'address_summaries');
  const beforeRetry = structuredClone(totals), ack = await commit(frozen);
  assert.deepEqual(await commit(frozen), ack);
  assert.deepEqual(totals, beforeRetry, 'exact retries must not issue writes');
  await assert.rejects(commit(frozen, '0'.repeat(64)), error => error.code === 'batch_conflict');
  const beforeRejected = await fingerprint(db);
  const overBudget = structuredClone(frozen); overBudget.batch_id = randomUUID();
  overBudget.items = [{ ...overBudget.items[0], seq: summarySeq + 1, address: '02:00:00:00:00:ff' }];
  await assert.rejects(commit(overBudget), error => error.code === 'window_evidence_conflict');
  assert.equal(await fingerprint(db), beforeRejected, 'budget rejection must roll back receipt and items');
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  const research = await db.prepare('SELECT item_json FROM ingestion_items_v2 WHERE node_id=? AND batch_id=? ORDER BY seq')
    .bind(frozen.node_id, frozen.batch_id).all();
  assert.deepEqual(research.results.map(row => JSON.parse(row.item_json)), frozen.items);
  return { ...totals, streams, exact_retry_additional_writes: 0, budget_rejection_atomic: true,
    private_batch_values_preserved: true };
};
try {
  const before = await mf.getD1Database('BEFORE'), after = await mf.getD1Database('AFTER');
  await apply(before, migrations.filter(name => Number(name.slice(0, 4)) < 9));
  await apply(after, migrations); await seed(before); await seed(after);
  const baseline = await run(before), optimized = await run(after);
  const prior = await fingerprint(before); await apply(before, upgrade);
  assert.equal(await fingerprint(before), prior, 'upgrade must preserve every receipt, item and budget byte');
  assert(optimized.rows_written < baseline.rows_written, 'index changes must reduce actual D1 write rows');
  const report = { runtime: 'workerd', storage: 'real ephemeral D1', workload: 'synthetic 40 windows / 16 addresses / raw off',
    migration_preserves_all_v2_rows: true, baseline, optimized,
    rows_written_reduction_percent: Math.round((1 - optimized.rows_written / baseline.rows_written) * 10000) / 100 };
  console.log(JSON.stringify(report));
} finally { await mf.dispose(); }
