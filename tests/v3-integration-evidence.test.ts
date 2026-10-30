import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectIntegrationEvidence, ISOLATED_ROOT, saveIntegrationEvidence, summarizeIntegrationEvidence } from '../scripts/v3-integration-evidence.mjs';

let dir: string, dbFile: string;
const synthetic = 'v3-synthetic-evidence-test', device = 'controlled-evidence-test';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stamp = '2026-10-30T05:00:00.000Z', privateValue = 'PRIVATE-ADDRESS-TOKEN-CREDENTIAL-EVIDENCE';
const bodyHash = 'a'.repeat(64);
let receiptText: string;

beforeEach(async () => {
  await mkdir(ISOLATED_ROOT, { recursive: true, mode: 0o700 });
  dir = await mkdtemp(join(ISOLATED_ROOT, '.evidence-test-'));
  const dbDir = join(dir, 'storage/d1/miniflare-D1DatabaseObject');
  await mkdir(dbDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'private-config.json'), JSON.stringify({ schema: 'cp-v3-integration/1',
    isolation: 'synthetic-controlled-test', operator_confirmed_isolated: true, adminSigningSecret: privateValue,
    synthetic: { nodeId: synthetic }, device: { nodeId: device } }), { mode: 0o600 });
  // This is a decoy: even a metadata DB with all the same tables is excluded.
  dbFile = join(dbDir, 'actual.sqlite');
  const database = new DatabaseSync(dbFile);
  database.exec(`CREATE TABLE v3_integration_migrations(name TEXT,sha256 TEXT);
    CREATE TABLE v3_integration_state(id TEXT);
    INSERT INTO v3_integration_state VALUES('ready');
    CREATE TABLE device_capabilities_v3(node_id TEXT,capability_sha256 TEXT,registered_at TEXT,issued_at_ms INTEGER,expires_at_ms INTEGER);
    CREATE TABLE device_assignments_v3(node_id TEXT,generation INTEGER,policy_sha256 TEXT,assigned_at TEXT);
    CREATE TABLE device_control_v3(node_id TEXT,desired_generation INTEGER,applied_generation INTEGER,registration_seq INTEGER,apply_seq INTEGER,registered_at TEXT);
    CREATE TABLE device_acknowledgements_v3(node_id TEXT,generation INTEGER,apply_seq INTEGER,state TEXT,body_sha256 TEXT,received_at TEXT);
    CREATE TABLE ingestion_batches_v3(node_id TEXT,boot_id TEXT,batch_id TEXT,stream TEXT,generation INTEGER,body_sha256 TEXT,seq_first INTEGER,seq_last INTEGER,receipt_json TEXT,expires_at_ms INTEGER,retain_until_ms INTEGER);
    CREATE TABLE ingestion_items_v3(node_id TEXT,stream TEXT,item_json TEXT);`);
  for (const [node, seq] of [[device, 21], [synthetic, 1]] as const) {
    database.prepare('INSERT INTO device_capabilities_v3 VALUES(?,?,?,?,?)').run(node, bodyHash, stamp, Date.parse(stamp), Date.parse(stamp) + 1000);
    database.prepare('INSERT INTO device_assignments_v3 VALUES(?,?,?,?)').run(node, 1, bodyHash, stamp);
    database.prepare('INSERT INTO device_control_v3 VALUES(?,?,?,?,?,?)').run(node, 1, node === synthetic ? 1 : null, 1, node === synthetic ? 1 : 0, stamp);
    if (node === synthetic) database.prepare('INSERT INTO device_acknowledgements_v3 VALUES(?,?,?,?,?,?)').run(node, 1, 1, 'applied', bodyHash, stamp);
    for (const stream of ['feature_summaries', 'node_status']) {
      const receipt = { node_id: node, boot_id: privateValue, batch_id: privateValue, stream, body_sha256: bodyHash,
        seq_first: seq, seq_last: seq, assignment_generation: 1, accepted_count: 1, received_at: stamp, durability: 'committed', privateValue };
      const text = JSON.stringify(receipt); if (node === device) receiptText = text;
      database.prepare('INSERT INTO ingestion_batches_v3 VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(node, privateValue, privateValue, stream, 1, bodyHash, seq, seq, text, Date.parse(stamp) + 1000, Date.parse(stamp) + 2000);
      database.prepare('INSERT INTO ingestion_items_v3 VALUES(?,?,?)').run(node, stream, JSON.stringify({ evidence: privateValue, token: privateValue }));
    }
  }
  database.close();
  await chmod(dbFile, 0o600);
  await writeFile(join(dbDir, 'metadata.sqlite'), await readFile(dbFile), { mode: 0o600 });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('reads the actual D1 file, separates cohorts, and never invents a device ACK', async () => {
  const before = hash(await readFile(dbFile));
  const actual = await collectIntegrationEvidence({ dataDir: dir });
  expect(actual.cohort).toBe('device');
  expect(actual.counts).toEqual({ capabilities: 1, assignments: 1, applied: 0, failed: 0 });
  expect(actual.control?.applied_generation).toBeNull(); expect(actual.acknowledgements).toEqual([]);
  expect(actual.streams.node_status.batches).toHaveLength(1);
  expect(actual.streams.node_status).toMatchObject({ batches: [{ seq_first: 21, seq_last: 21, accepted_count: 1,
    body_sha256: bodyHash, receipt_sha256: hash(receiptText), received_at: stamp, receipt_metadata_matches: true }], retained_items: 1 });
  const simulated = await collectIntegrationEvidence({ dataDir: dir, cohort: 'synthetic' });
  expect(simulated.counts.applied).toBe(1); expect(simulated.streams.feature_summaries.batches[0].seq_first).toBe(1);
  const serialized = JSON.stringify(actual);
  for (const value of [device, synthetic, privateValue, 'item_json', 'receipt_json']) expect(serialized).not.toContain(value);
  expect(actual.physical_validation).toBe('not_established');
  const summary = summarizeIntegrationEvidence(actual);
  expect(summary.streams.node_status).toEqual({ batches: 1, retained_items: 1 });
  expect(JSON.stringify(summary)).not.toContain(bodyHash);
  expect(hash(await readFile(dbFile))).toBe(before);
});

it('accepts only a private matching profile and parameterizes identity selection', async () => {
  const profile = join(dir, 'profile.json');
  const config = { isolation: 'synthetic-controlled-test', operator_confirmed_isolated: true, actor: 'existing_device', nodeId: device };
  await writeFile(profile, JSON.stringify(config), { mode: 0o600 });
  expect((await collectIntegrationEvidence({ dataDir: dir, profile })).counts.applied).toBe(0);
  await expect(collectIntegrationEvidence({ dataDir: dir, profile, cohort: 'synthetic' })).rejects.toThrow('profile_cohort_mismatch');
  await writeFile(profile, JSON.stringify({ ...config, nodeId: "' OR 1=1 --" }));
  await expect(collectIntegrationEvidence({ dataDir: dir, profile })).rejects.toThrow('invalid_private_config');
  await chmod(profile, 0o644);
  await expect(collectIntegrationEvidence({ dataDir: dir, profile })).rejects.toThrow('unsafe_private_path');
});

it('rejects production paths, symlinks, ambiguous or unready databases', async () => {
  await expect(collectIntegrationEvidence({ dataDir: '.wrangler/state' })).rejects.toThrow('outside_isolated_root');
  const link = join(dir, 'private-link.json'); await symlink(join(dir, 'private-config.json'), link);
  await expect(collectIntegrationEvidence({ dataDir: dir, config: link })).rejects.toThrow('unsafe_private_path');
  const copy = join(dir, 'storage/d1/second.sqlite'); await writeFile(copy, await readFile(dbFile), { mode: 0o600 });
  await expect(collectIntegrationEvidence({ dataDir: dir })).rejects.toThrow('ambiguous_integration_database');
  await rm(copy);
  const database = new DatabaseSync(dbFile); database.prepare('DELETE FROM v3_integration_state').run(); database.close();
  await expect(collectIntegrationEvidence({ dataDir: dir })).rejects.toThrow('integration_database_not_ready');
});

it('sanitizes unexpected strings, flags truncation and mismatched receipts', async () => {
  const database = new DatabaseSync(dbFile);
  database.prepare('INSERT INTO device_capabilities_v3 VALUES(?,?,?,?,?)').run(device, privateValue, privateValue, null, -1);
  database.prepare('UPDATE ingestion_batches_v3 SET body_sha256=? WHERE node_id=?').run('b'.repeat(64), device);
  database.close();
  const report = await collectIntegrationEvidence({ dataDir: dir, limit: 1 });
  expect(report.details_truncated).toBe(true);
  expect(report.capabilities).toEqual([{ capability_sha256: null, registered_at: null, issued_at: null, expires_at: null }]);
  expect(report.streams.node_status.batches[0].receipt_metadata_matches).toBe(false);
  expect(JSON.stringify(report)).not.toContain(privateValue);
});

it('writes a new private report only inside the isolated root without following links', async () => {
  const report = await collectIntegrationEvidence({ dataDir: dir });
  const output = join(dir, 'reports/device.json'); await saveIntegrationEvidence(output, report);
  expect((await lstat(output)).mode & 0o777).toBe(0o600);
  expect((await lstat(join(dir, 'reports'))).mode & 0o777).toBe(0o700);
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(report);
  await expect(saveIntegrationEvidence(output, report)).rejects.toThrow();
  await expect(saveIntegrationEvidence('/private/tmp/unrelated-report.json', report)).rejects.toThrow('outside_isolated_root');
  await symlink(join(dir, 'reports'), join(dir, 'linked-reports'));
  await expect(saveIntegrationEvidence(join(dir, 'linked-reports/no.json'), report)).rejects.toThrow('unsafe_private_path');
});
