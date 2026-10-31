#!/usr/bin/env node
/** Read-only local evidence. Never contacts a service or creates device ACKs.
 * node scripts/v3-statistics-evidence.mjs --cohort device [--output data/v3-statistics-integration/reports/device.json]
 * --config selects a statistics server private-config. No legacy/profile input.
 * Every input/output remains under data/v3-statistics-integration. stdout is counts only.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ISOLATED_ROOT = fileURLToPath(new URL('../data/v3-statistics-integration', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const requireValue = (condition, code) => { if (!condition) throw new Error(code); };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const millis = value => count(value) !== null && value <= 8640000000000000 ? new Date(value).toISOString() : null;
const TABLES = ['v3_integration_migrations', 'v3_integration_state', 'device_capabilities_v3',
  'device_assignments_v3', 'device_control_v3', 'device_acknowledgements_v3', 'device_statistics_authorizations_v3',
  'device_statistics_lease_spans_v3', 'statistics_batches_v3', 'statistics_windows_v3', 'statistics_events_v3',
  'statistics_status_v3', 'public_sensor_projection_v2', 'public_observation_projection'];

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

async function readConfig(filename, cohort) {
  const safe = await privatePath(filename);
  const handle = await open(safe, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireValue((stat.mode & 0o777) === 0o600 && stat.size < 262144, 'invalid_private_config');
    const config = JSON.parse(await handle.readFile('utf8'));
    requireValue(config.isolation === 'synthetic-controlled-test' && config.operator_confirmed_isolated === true, 'invalid_isolation');
    requireValue(config.schema === 'cp-v3-integration/1' && config.profile === 'statistics' && config.synthetic?.nodeId !== config.device?.nodeId, 'invalid_private_config');
    const nodeId = config[cohort]?.nodeId;
    requireValue(typeof nodeId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(nodeId), 'invalid_private_config');
    requireValue(!['synthetic', 'device', 'tenergy'].some(other => other !== cohort && config[other]?.nodeId === nodeId), 'cohort_identity_mismatch');
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
        const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type=? AND name IN (${TABLES.map(() => '?').join(',')})`)
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
  return { body_sha256: digest(row.body_sha256), receipt_sha256: hash(row.receipt_json), policy_sha256: digest(row.policy_sha256),
    generation: count(row.generation), seq_first: count(row.seq_first), seq_last: count(row.seq_last), accepted_count: count(receipt?.accepted_count),
    received_at: time(receipt?.received_at), expires_at: millis(row.expires_at_ms), retain_until: millis(row.retain_until_ms),
    receipt_metadata_matches: !!receipt && receipt.protocol === 'campuspulse/3' && receipt.schema === 'device-statistics-receipt/3' &&
      receipt.node_id === nodeId && receipt.boot_id === row.boot_id && receipt.batch_id === row.batch_id && receipt.stream === stream &&
      receipt.body_sha256 === row.body_sha256 && digest(row.body_sha256) !== null && receipt.seq_first === row.seq_first && receipt.seq_last === row.seq_last &&
      count(receipt.accepted_count) !== null && receipt.accepted_count > 0 && receipt.accepted_count <= row.seq_last - row.seq_first + 1 && receipt.policy_id === row.policy_id &&
      digest(row.policy_sha256) !== null && receipt.policy_sha256 === row.policy_sha256 && row.policy_sha256 === row.assignment_policy_sha256 &&
      receipt.assignment_generation === row.generation && receipt.expires_at === millis(row.expires_at_ms) && receipt.retain_until === millis(row.retain_until_ms) &&
      time(receipt.received_at) !== null && Date.parse(receipt.received_at) < row.expires_at_ms && row.retain_until_ms >= row.expires_at_ms &&
      typeof receipt.receipt_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(receipt.receipt_id) &&
      receipt.durability === 'committed' && receipt.custody === 'small_statistics',
  };
}

/** Node evidence uses the configured identity as a bound parameter; public tables
 * expose aggregate row counts only. JSON, identifiers and credentials stay private.
 * @param {{dataDir?:string,config?:string,cohort?:'device'|'synthetic'|'tenergy',limit?:number}} [options]
 */
export async function collectStatisticsEvidence({ dataDir = ISOLATED_ROOT, config, cohort = 'device', limit = 1000 } = {}) {
  requireValue(['device', 'synthetic', 'tenergy'].includes(cohort), 'invalid_cohort');
  requireValue(Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid_limit');
  dataDir = await privatePath(dataDir, { directory: true });
  const configPath = resolve(config ?? join(dataDir, 'private-config.json'));
  const configChild = relative(dataDir, configPath);
  requireValue(configChild && configChild !== '..' && !configChild.startsWith(`..${sep}`) && !isAbsolute(configChild), 'config_outside_source_root');
  const nodeId = await readConfig(configPath, cohort);
  const database = await findDatabase(dataDir);
  try {
    // One read transaction gives a consistent snapshot while workerd receives data.
    database.exec('BEGIN');
    requireValue(database.prepare('SELECT COUNT(*) n FROM v3_integration_state WHERE id=?').get('ready').n === 1, 'integration_database_not_ready');
    const counts = database.prepare(`SELECT
      (SELECT COUNT(*) FROM device_capabilities_v3 WHERE node_id=?) capabilities,
      (SELECT COUNT(*) FROM device_assignments_v3 WHERE node_id=?) assignments,
      (SELECT COUNT(*) FROM device_acknowledgements_v3 WHERE node_id=? AND state=?) applied,
      (SELECT COUNT(*) FROM device_acknowledgements_v3 WHERE node_id=? AND state=?) failed,
      (SELECT COUNT(*) FROM device_statistics_lease_spans_v3 WHERE node_id=?) lease_spans`).get(nodeId, nodeId, nodeId, 'applied', nodeId, 'failed', nodeId);
    const control = database.prepare('SELECT desired_generation,applied_generation,registration_seq,apply_seq,registered_at FROM device_control_v3 WHERE node_id=?').get(nodeId);
    const capabilities = database.prepare('SELECT capability_sha256,registered_at,issued_at_ms,expires_at_ms FROM device_capabilities_v3 WHERE node_id=? ORDER BY registered_at DESC LIMIT ?').all(nodeId, limit)
      .map(row => ({ capability_sha256: digest(row.capability_sha256), registered_at: time(row.registered_at), issued_at: millis(row.issued_at_ms), expires_at: millis(row.expires_at_ms) }));
    const assignments = database.prepare('SELECT generation,policy_sha256,assigned_at FROM device_assignments_v3 WHERE node_id=? ORDER BY generation DESC LIMIT ?').all(nodeId, limit)
      .map(row => ({ generation: count(row.generation), policy_sha256: digest(row.policy_sha256), assigned_at: time(row.assigned_at) }));
    const acknowledgements = database.prepare('SELECT generation,apply_seq,state,body_sha256,received_at FROM device_acknowledgements_v3 WHERE node_id=? ORDER BY generation DESC LIMIT ?').all(nodeId, limit)
      .map(row => ({ generation: count(row.generation), apply_seq: count(row.apply_seq), state: ['applied', 'failed'].includes(row.state) ? row.state : 'invalid', body_sha256: digest(row.body_sha256), received_at: time(row.received_at) }));
    const lease_spans = database.prepare('SELECT generation,span_seq,start_ms,end_ms,accept_until_ms FROM device_statistics_lease_spans_v3 WHERE node_id=? ORDER BY generation DESC,span_seq DESC LIMIT ?').all(nodeId, limit)
      .map(row => ({ generation: count(row.generation), span_seq: count(row.span_seq), start_at: millis(row.start_ms), end_at: millis(row.end_ms), accept_until: millis(row.accept_until_ms) }));
    const windows = database.prepare('SELECT generation,seq,clock_epoch,window_seq,end_utc_ms,duration_ms,received_at_ms,quality_mask,extractor_version,ruleset_version FROM statistics_windows_v3 WHERE node_id=? ORDER BY received_at_ms DESC,seq DESC LIMIT ?').all(nodeId, limit)
      .map(row => ({ generation: count(row.generation), seq: count(row.seq), clock_epoch: count(row.clock_epoch), window_seq: count(row.window_seq), end_at: millis(row.end_utc_ms), duration_ms: count(row.duration_ms), received_at: millis(row.received_at_ms), quality_mask: count(row.quality_mask),
        extractor_version: row.extractor_version === 'cp-v3-stats/1' ? row.extractor_version : null, ruleset_version: row.ruleset_version === 'unclassified-v1' ? row.ruleset_version : null }));
    // Event table stores one latest revision per event; never select its identity or item_json.
    const event_latest = database.prepare('SELECT generation,seq,revision,item_sha256,received_at_ms FROM statistics_events_v3 WHERE node_id=? ORDER BY received_at_ms DESC,seq DESC LIMIT ?').all(nodeId, limit)
      .map(row => ({ generation: count(row.generation), seq: count(row.seq), revision: count(row.revision), item_sha256: digest(row.item_sha256), received_at: millis(row.received_at_ms) }));
    const statuses = database.prepare('SELECT seq,uptime_ms,clock_epoch,window_drops,event_drops,status_coalesced,upload_failures,ack_failures,retries FROM statistics_status_v3 WHERE node_id=? ORDER BY uptime_ms DESC,seq DESC LIMIT ?').all(nodeId, limit)
      .map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,count(value)])));
    const itemCounts = database.prepare(`SELECT
      (SELECT COUNT(*) FROM statistics_windows_v3 WHERE node_id=?) windows,
      (SELECT COUNT(*) FROM statistics_events_v3 WHERE node_id=?) event_latest,
      (SELECT COUNT(*) FROM statistics_status_v3 WHERE node_id=?) statuses,
      (SELECT COUNT(*) FROM statistics_batches_v3 WHERE node_id=?) receipts`).get(nodeId,nodeId,nodeId,nodeId);
    const public_projection = {
      sensor_node_rows: database.prepare('SELECT COUNT(*) n FROM public_sensor_projection_v2 WHERE node_id=?').get(nodeId).n,
      sensor_total_rows: database.prepare('SELECT COUNT(*) n FROM public_sensor_projection_v2').get().n,
      observation_total_rows: database.prepare('SELECT COUNT(*) n FROM public_observation_projection').get().n,
    };
    /** @type {Record<string, {batch_count:number,generation_count:number,details_truncated:boolean,generations:{generation:number|null,boot_sha256:string,receipts:number|null,seq_first:number|null,seq_last:number|null}[],batches:ReturnType<typeof redactBatch>[]}>} */
    const streams = {};
    for (const stream of ['window_statistics', 'candidate_events', 'node_status']) {
      const totals = database.prepare('SELECT COUNT(*) batch_count FROM statistics_batches_v3 WHERE node_id=? AND stream=?').get(nodeId, stream);
      const batches = database.prepare(`SELECT b.boot_id,b.batch_id,b.generation,b.policy_sha256,b.body_sha256,b.seq_first,b.seq_last,b.receipt_json,b.expires_at_ms,b.retain_until_ms,
        a.policy_id,a.policy_sha256 assignment_policy_sha256 FROM statistics_batches_v3 b LEFT JOIN device_assignments_v3 a ON a.node_id=b.node_id AND a.generation=b.generation
        WHERE b.node_id=? AND b.stream=? ORDER BY b.rowid DESC LIMIT ?`).all(nodeId, stream, limit).map(row => redactBatch(row, nodeId, stream));
      // Sequence numbers restart with a boot: preserve that boundary using only a digest.
      const generations = database.prepare('SELECT generation,boot_id,COUNT(*) receipts,MIN(seq_first) seq_first,MAX(seq_last) seq_last FROM statistics_batches_v3 WHERE node_id=? AND stream=? GROUP BY generation,boot_id ORDER BY generation DESC,boot_id LIMIT ?').all(nodeId,stream,limit)
        .map(row => ({ generation: count(row.generation), boot_sha256: hash(row.boot_id), receipts: count(row.receipts), seq_first: count(row.seq_first), seq_last: count(row.seq_last) }));
      const generation_count = database.prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM statistics_batches_v3 WHERE node_id=? AND stream=? GROUP BY generation,boot_id)').get(nodeId,stream).n;
      streams[stream] = { ...totals, generation_count, details_truncated: totals.batch_count > batches.length || generation_count > generations.length, generations, batches };
    }
    database.exec('COMMIT');
    return { schema: 'v3-statistics-evidence/1', isolation: 'local-d1-controlled-test', cohort, node_sha256: hash(nodeId), snapshot_at: new Date().toISOString(),
      source: 'persisted_read_only_snapshot', physical_validation: 'not_established', counts: { ...counts }, statistics_counts: { ...itemCounts }, public_projection,
      control: control ? { desired_generation: count(control.desired_generation), applied_generation: count(control.applied_generation),
        registration_seq: count(control.registration_seq), apply_seq: count(control.apply_seq), registered_at: time(control.registered_at) } : null,
      details_truncated: counts.capabilities > capabilities.length || counts.assignments > assignments.length || counts.applied + counts.failed > acknowledgements.length || counts.lease_spans > lease_spans.length || itemCounts.windows > windows.length || itemCounts.event_latest > event_latest.length || itemCounts.statuses > statuses.length || Object.values(streams).some(stream => stream.details_truncated),
      capabilities, assignments, acknowledgements, lease_spans, windows, event_latest, statuses, streams };
  } finally { database.close(); }
}

export function summarizeStatisticsEvidence(report) {
  return { schema: report.schema, isolation: report.isolation, source: report.source,
    cohort: report.cohort, snapshot_at: report.snapshot_at, counts: report.counts, statistics_counts: report.statistics_counts, public_projection: report.public_projection,
    streams: Object.fromEntries(Object.entries(report.streams).map(([stream, value]) => [stream, { batches: value.batch_count }])),
    physical_validation: report.physical_validation };
}

export async function saveStatisticsEvidence(filename, report, { dataDir = ISOLATED_ROOT } = {}) {
  dataDir = await privatePath(dataDir, { directory: true });
  const absolute = resolve(filename), parent = dirname(absolute);
  const child = relative(join(dataDir, 'reports'), absolute);
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
    const options = {}, keys = { '--cohort': 'cohort', '--data-dir': 'dataDir', '--config': 'config', '--output': 'output' };
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = keys[process.argv[i]], value = process.argv[i + 1];
      requireValue(key && value && options[key] === undefined, 'invalid_arguments'); options[key] = value;
    }
    const report = await collectStatisticsEvidence(options);
    if (options.output) await saveStatisticsEvidence(options.output, report, { dataDir: options.dataDir });
    process.stdout.write(JSON.stringify(summarizeStatisticsEvidence(report)) + '\n');
  } catch { process.stderr.write('v3_statistics_evidence_failed\n'); process.exitCode = 1; }
}
