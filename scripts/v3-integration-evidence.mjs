#!/usr/bin/env node
/** Read-only local evidence. Never contacts a service or creates device ACKs.
 * node scripts/v3-integration-evidence.mjs --cohort device [--output data/v3-integration/reports/device.json]
 * --config selects a server private-config; --profile selects an existing harness profile.
 * Every input/output remains under data/v3-integration. stdout is counts only.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ISOLATED_ROOT = fileURLToPath(new URL('../data/v3-integration', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const requireValue = (condition, code) => { if (!condition) throw new Error(code); };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const millis = value => count(value) !== null && value <= 8640000000000000 ? new Date(value).toISOString() : null;
const TABLES = ['v3_integration_migrations', 'v3_integration_state', 'device_capabilities_v3',
  'device_assignments_v3', 'device_control_v3', 'device_acknowledgements_v3', 'ingestion_batches_v3', 'ingestion_items_v3'];

// Check each component, not just the final file: symlinked parents must not escape
// into production persistence. Owned private storage is also required.
async function privatePath(filename, { directory = false } = {}) {
  const absolute = resolve(filename), child = relative(ISOLATED_ROOT, absolute);
  requireValue(child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), 'outside_isolated_root');
  let current = ISOLATED_ROOT;
  for (const component of ['', ...child.split(sep).filter(Boolean)]) {
    if (component) current = join(current, component);
    const stat = await lstat(current);
    requireValue(!stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'unsafe_private_path');
    requireValue(current === absolute && !directory ? stat.isFile() : stat.isDirectory(), 'unsafe_private_path');
  }
  requireValue(await realpath(absolute) === absolute, 'unsafe_private_path');
  return absolute;
}

async function readConfig(filename, cohort, profile) {
  const safe = await privatePath(filename);
  const handle = await open(safe, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireValue((stat.mode & 0o777) === 0o600 && stat.size < 262144, 'invalid_private_config');
    const config = JSON.parse(await handle.readFile('utf8'));
    requireValue(config.isolation === 'synthetic-controlled-test' && config.operator_confirmed_isolated === true, 'invalid_isolation');
    if (profile) requireValue(config.actor === (cohort === 'device' ? 'existing_device' : 'synthetic_client'), 'profile_cohort_mismatch');
    else requireValue(config.schema === 'cp-v3-integration/1' && config.synthetic?.nodeId !== config.device?.nodeId, 'invalid_private_config');
    const nodeId = profile ? config.nodeId : config[cohort]?.nodeId;
    requireValue(typeof nodeId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(nodeId), 'invalid_private_config');
    const syntheticId = /^(?:synthetic-|v3-synthetic-)/.test(nodeId);
    requireValue(cohort === 'synthetic' ? syntheticId : !syntheticId, 'cohort_identity_mismatch');
    return nodeId;
  } finally { await handle.close(); }
}

async function findDatabase(dataDir) {
  // Restrict discovery to the D1 subtree, excluding metadata and R2/cache DBs.
  const root = await privatePath(join(dataDir, 'storage/d1'), { directory: true });
  const candidates = [];
  async function walk(path, depth = 0) {
    requireValue(depth <= 8, 'storage_depth_exceeded');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      requireValue(!entry.isSymbolicLink(), 'unsafe_private_path');
      const filename = join(path, entry.name);
      if (entry.isDirectory()) { await privatePath(filename, { directory: true }); await walk(filename, depth + 1); }
      else if (entry.isFile() && entry.name.endsWith('.sqlite') && entry.name !== 'metadata.sqlite') {
        requireValue(candidates.length < 64, 'too_many_databases');
        candidates.push(await privatePath(filename));
      }
    }
  }
  await walk(root);
  let selected;
  try {
    for (const filename of candidates) {
      let database = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
      try {
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type=? AND name IN (?,?,?,?,?,?,?,?)")
          .all('table', ...TABLES);
        if (tables.length !== TABLES.length) continue;
        requireValue(!selected, 'ambiguous_integration_database');
        selected = database; database = undefined;
      } finally { database?.close(); }
    }
    requireValue(selected, 'integration_database_not_found');
    return selected;
  } catch (error) { selected?.close(); throw error; }
}

function redactBatch(row, nodeId, stream) {
  let receipt; try { receipt = JSON.parse(row.receipt_json); } catch { receipt = null; }
  return { body_sha256: digest(row.body_sha256), receipt_sha256: hash(row.receipt_json), generation: count(row.generation),
    seq_first: count(row.seq_first), seq_last: count(row.seq_last), accepted_count: count(receipt?.accepted_count),
    received_at: time(receipt?.received_at), expires_at: millis(row.expires_at_ms), retain_until: millis(row.retain_until_ms),
    receipt_metadata_matches: !!receipt && receipt.node_id === nodeId && receipt.boot_id === row.boot_id && receipt.batch_id === row.batch_id &&
      receipt.stream === stream && receipt.body_sha256 === row.body_sha256 && receipt.seq_first === row.seq_first && receipt.seq_last === row.seq_last &&
      receipt.assignment_generation === row.generation && receipt.durability === 'committed',
  };
}

/** The only SELECTs of application data use the configured identity as a bound
 * parameter. JSON evidence, identifiers, tokens and credentials never leave here.
 * @param {{dataDir?:string,config?:string,profile?:string,cohort?:'device'|'synthetic',limit?:number}} [options]
 */
export async function collectIntegrationEvidence({ dataDir = ISOLATED_ROOT, config, profile, cohort = 'device', limit = 1000 } = {}) {
  requireValue(['device', 'synthetic'].includes(cohort), 'invalid_cohort');
  requireValue(Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid_limit');
  requireValue(!(config && profile), 'conflicting_config_options');
  dataDir = await privatePath(dataDir, { directory: true });
  const nodeId = await readConfig(profile ?? config ?? join(dataDir, 'private-config.json'), cohort, !!profile);
  const database = await findDatabase(dataDir);
  try {
    // One read transaction gives a consistent snapshot while workerd receives data.
    database.exec('BEGIN');
    requireValue(database.prepare('SELECT COUNT(*) n FROM v3_integration_state WHERE id=?').get('ready').n === 1, 'integration_database_not_ready');
    const counts = database.prepare(`SELECT
      (SELECT COUNT(*) FROM device_capabilities_v3 WHERE node_id=?) capabilities,
      (SELECT COUNT(*) FROM device_assignments_v3 WHERE node_id=?) assignments,
      (SELECT COUNT(*) FROM device_acknowledgements_v3 WHERE node_id=? AND state=?) applied,
      (SELECT COUNT(*) FROM device_acknowledgements_v3 WHERE node_id=? AND state=?) failed`).get(nodeId, nodeId, nodeId, 'applied', nodeId, 'failed');
    const control = database.prepare('SELECT desired_generation,applied_generation,registration_seq,apply_seq,registered_at FROM device_control_v3 WHERE node_id=?').get(nodeId);
    const capabilities = database.prepare('SELECT capability_sha256,registered_at,issued_at_ms,expires_at_ms FROM device_capabilities_v3 WHERE node_id=? ORDER BY registered_at DESC LIMIT ?').all(nodeId, limit)
      .map(row => ({ capability_sha256: digest(row.capability_sha256), registered_at: time(row.registered_at), issued_at: millis(row.issued_at_ms), expires_at: millis(row.expires_at_ms) }));
    const assignments = database.prepare('SELECT generation,policy_sha256,assigned_at FROM device_assignments_v3 WHERE node_id=? ORDER BY generation DESC LIMIT ?').all(nodeId, limit)
      .map(row => ({ generation: count(row.generation), policy_sha256: digest(row.policy_sha256), assigned_at: time(row.assigned_at) }));
    const acknowledgements = database.prepare('SELECT generation,apply_seq,state,body_sha256,received_at FROM device_acknowledgements_v3 WHERE node_id=? ORDER BY generation DESC LIMIT ?').all(nodeId, limit)
      .map(row => ({ generation: count(row.generation), apply_seq: count(row.apply_seq), state: ['applied', 'failed'].includes(row.state) ? row.state : 'invalid', body_sha256: digest(row.body_sha256), received_at: time(row.received_at) }));
    /** @type {Record<string, {batch_count:number,retained_items:number,details_truncated:boolean,batches:ReturnType<typeof redactBatch>[]}>} */
    const streams = {};
    for (const stream of ['feature_summaries', 'node_status']) {
      const totals = database.prepare(`SELECT
        (SELECT COUNT(*) FROM ingestion_batches_v3 WHERE node_id=? AND stream=?) batch_count,
        (SELECT COUNT(*) FROM ingestion_items_v3 WHERE node_id=? AND stream=?) retained_items`).get(nodeId, stream, nodeId, stream);
      const batches = database.prepare('SELECT boot_id,batch_id,generation,body_sha256,seq_first,seq_last,receipt_json,expires_at_ms,retain_until_ms FROM ingestion_batches_v3 WHERE node_id=? AND stream=? ORDER BY rowid DESC LIMIT ?').all(nodeId, stream, limit)
        .map(row => redactBatch(row, nodeId, stream));
      streams[stream] = { ...totals, details_truncated: totals.batch_count > batches.length, batches };
    }
    database.exec('COMMIT');
    return { schema: 'v3-integration-evidence/1', isolation: 'local-d1-controlled-test', cohort, snapshot_at: new Date().toISOString(),
      source: 'persisted_read_only_snapshot', physical_validation: 'not_established', counts: { ...counts },
      control: control ? { desired_generation: count(control.desired_generation), applied_generation: count(control.applied_generation),
        registration_seq: count(control.registration_seq), apply_seq: count(control.apply_seq), registered_at: time(control.registered_at) } : null,
      details_truncated: counts.capabilities > capabilities.length || counts.assignments > assignments.length || counts.applied + counts.failed > acknowledgements.length,
      capabilities, assignments, acknowledgements, streams };
  } finally { database.close(); }
}

export function summarizeIntegrationEvidence(report) {
  return { schema: report.schema, isolation: report.isolation, source: report.source,
    cohort: report.cohort, snapshot_at: report.snapshot_at, counts: report.counts,
    streams: Object.fromEntries(Object.entries(report.streams).map(([stream, value]) => [stream, { batches: value.batch_count, retained_items: value.retained_items }])),
    physical_validation: report.physical_validation };
}

export async function saveIntegrationEvidence(filename, report) {
  const absolute = resolve(filename), parent = dirname(absolute);
  const child = relative(ISOLATED_ROOT, absolute);
  requireValue(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), 'outside_isolated_root');
  // Check existing ancestors before mkdir to avoid writing through a symlink.
  let ancestor = parent;
  for (;;) {
    try { await privatePath(ancestor, { directory: true }); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await privatePath(parent, { directory: true });
  const handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {}, keys = { '--cohort': 'cohort', '--data-dir': 'dataDir', '--config': 'config', '--profile': 'profile', '--output': 'output' };
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = keys[process.argv[i]], value = process.argv[i + 1];
      requireValue(key && value && options[key] === undefined, 'invalid_arguments'); options[key] = value;
    }
    const report = await collectIntegrationEvidence(options);
    if (options.output) await saveIntegrationEvidence(options.output, report);
    process.stdout.write(JSON.stringify(summarizeIntegrationEvidence(report)) + '\n');
  } catch { process.stderr.write('v3_integration_evidence_failed\n'); process.exitCode = 1; }
}
