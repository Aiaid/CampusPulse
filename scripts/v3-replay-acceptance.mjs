#!/usr/bin/env node
/** Local CPRAW aggregate replay acceptance. Never reads raw captures or credentials.
 * D1 checks cover every replay row; administrator evidence lists remain bounded.
 * Receipt hashes bind committed metadata, not rehashed historical source bytes.
 */
import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, chmod, open } from 'node:fs/promises';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { startV3Simulator } from './v3-simulator.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a, b) => canonical(a) === canonical(b);
class AcceptanceFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const check = (ok, code) => { if (!ok) throw new AcceptanceFailure(code); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseReplayAcceptanceArgs(args) {
  const options = { port: 5196 };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    check(['--replay', '--output', '--port'].includes(key) && value && !seen.has(key), 'invalid_arguments');
    seen.add(key);
    options[key.slice(2)] = key === '--port' ? Number(value) : value;
  }
  check(options.replay && options.output && Number.isInteger(options.port) && options.port >= 1024 && options.port <= 65535, 'invalid_arguments');
  check(path.resolve(options.replay) !== path.resolve(options.output), 'output_cannot_replace_replay');
  return options;
}

async function referenceValidator() {
  const bundle = await build({ stdin: { contents: "export {validateStatisticsV3Window} from './worker/device-v3-statistics-validation'; export {statisticsLimits} from './worker/device-v3-statistics';", resolveDir: ROOT, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}

async function browserJson(page, pathname) {
  return page.evaluate(async pathname => {
    const response = await fetch(pathname, { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  }, pathname);
}

async function writePrivateReport(filename, report) {
  const parent = path.dirname(path.resolve(filename));
  check(![path.resolve(ROOT), path.parse(parent).root, path.resolve(homedir()), path.resolve(tmpdir()), '/tmp', '/private/tmp'].includes(parent),
    'report_requires_private_directory');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  // Exclusive creation also prevents replacing an input, existing report or symlink.
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); }
  finally { await handle.close(); }
  check(((await stat(filename)).mode & 0o777) === 0o600 && ((await stat(parent)).mode & 0o777) === 0o700, 'private_report_permissions');
}

/** Exposed for local automation. Errors and output deliberately omit identifiers. */
export async function runV3ReplayAcceptance(options) {
  const report = { schema: 'campuspulse-v3-replay-acceptance/1', result: 'failed', dataset: 'controlled_test',
    checks: [], original_request_bytes_rehashed: false, historical_raw_source_custody_verified: false,
    transport: { framing: 'CPV3', local_gateway: true, production_mqtt_tls_verified: false },
    limitations: ['Software replay; no radio or hardware validation.', 'Historical intervals use a new current-time test lease.',
      'Administrator lists are bounded; every normalized source row is checked directly in isolated D1.',
      'Receipt metadata hashes are compared; historical source bytes are not reconstructed.'] };
  let simulator, browser, stage = 'aggregate_input';
  const launchedAt = Date.now();
  try {
    const metadata = await stat(options.replay);
    check(metadata.isFile() && metadata.size <= 4 * 1024 * 1024, 'bounded_aggregate_input');
    const bytes = await readFile(options.replay), source = JSON.parse(bytes.toString('utf8'));
    check(source.schema === 'campuspulse-cpraw-replay/1' && Array.isArray(source.windows) && source.windows.length > 0, 'aggregate_schema');
    const total = source.windows.length;
    check(total <= 120 && [1000, 30000, 60000].includes(source.window_ms) &&
      source.bin_ms === (source.window_ms === 1000 ? 1000 : 5000), 'aggregate_cadence');
    check(Array.isArray(source.provenance?.source_sha256) && source.provenance.source_sha256.length > 0 &&
      source.provenance.source_sha256.every(value => typeof value === 'string' && HASH.test(value)) &&
      Number.isSafeInteger(source.provenance.total_reports) && source.provenance.total_reports >= 0, 'aggregate_provenance');
    report.provenance = { aggregate_sha256: sha(bytes), source_sha256: source.provenance.source_sha256,
      total_reports: source.provenance.total_reports, source_format: 'CPRAW/1', provenance_sha256: sha(canonical(source.provenance)) };
    report.cadence = { window_ms: source.window_ms, bin_ms: source.bin_ms, windows: total };
    stage = 'reference_validator';
    const { validateStatisticsV3Window, statisticsLimits } = await referenceValidator();
    stage = 'runtime_start';
    simulator = await startV3Simulator({ replayFile: options.replay, port: options.port ?? 5196 });
    const initial = simulator.snapshot();
    check(initial.dataset === 'controlled_test' && initial.device.replay?.total_windows === total, 'replay_runtime_selected');
    const node = initial.device.nodeId, boot = initial.device.bootId;
    check(typeof node === 'string' && typeof boot === 'string', 'isolated_device_identity');
    const rows = async sql => (await simulator.db.prepare(sql).bind(node).all()).results;
    const assignments = await rows('SELECT generation,envelope_json,policy_sha256 FROM device_assignments_v3 WHERE node_id=? ORDER BY generation');
    check(assignments.length === 1, 'single_replay_assignment');
    const policy = JSON.parse(assignments[0].envelope_json).policy;
    check(policy.custody.dataset === 'controlled_test' && policy.local_raw.mode === 'off' && policy.uplink.raw_sample.mode === 'off' &&
      policy.uplink.archive.mode === 'off' && policy.collection.summary.window_ms === source.window_ms &&
      policy.collection.summary.bin_ms === source.bin_ms, 'bounded_controlled_test_policy');
    const limits = statisticsLimits(policy);
    report.checks.push('isolated_real_gateway_worker_d1', 'controlled_test_raw_off');

    stage = 'browser_start';
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', () => browserErrors.push(true));
    await page.route('https://gis.ccnu.edu.cn/**', route => route.abort());
    await page.goto(simulator.origin + '/__simulator');
    await page.getByRole('heading', { name: '模拟设备控制台', exact: true }).waitFor();
    await page.locator('#replay-notice').filter({ hasText: '历史 CPRAW 回放' }).waitFor({ state: 'visible' });
    stage = 'replay_completion';
    const deadline = launchedAt + total * source.window_ms + Math.max(120000, total * 2000);
    while (true) {
      const state = simulator.snapshot(), d = state.device;
      check(!state.last_error && !d.lastError && d.phase !== 'retry_exhausted' &&
        Object.values(d.losses).every(value => value === 0), 'replay_without_retry_or_loss');
      check(d.accepted.window_statistics <= total && d.accepted.node_status <= total && d.replay.next_index <= total, 'no_extra_replay_windows');
      if (d.replay.completed && d.accepted.window_statistics === total && d.accepted.node_status === total && d.pendingItems === 0) break;
      check(Date.now() < deadline, 'replay_completion_timeout');
      await pause(250);
    }
    // Give the scheduler another complete short cadence after EOF. For longer
    // windows, observe subsequent scheduler ticks without adding a minute wait.
    await pause(source.window_ms === 1000 ? 1300 : 600);
    report.checks.push('real_cadence_finite_replay', 'all_window_and_status_receipts_accepted', 'no_upload_failures_or_retries');

    stage = 'all_d1_records';
    const windows = await rows('SELECT * FROM statistics_windows_v3 WHERE node_id=? ORDER BY seq');
    const statuses = await rows('SELECT * FROM statistics_status_v3 WHERE node_id=? ORDER BY seq');
    const batches = await rows('SELECT * FROM statistics_batches_v3 WHERE node_id=? ORDER BY stream,seq_first');
    const spans = await rows('SELECT * FROM device_statistics_lease_spans_v3 WHERE node_id=? ORDER BY span_seq');
    check(windows.length === total && statuses.length === total && batches.length === total * 2, 'exact_durable_row_counts');
    const normalized = [], batchMap = new Map(batches.map(row => [row.batch_id, row]));
    let previous = null;
    for (let index = 0; index < total; index++) {
      const row = windows[index], template = source.windows[index].item;
      check(row.item_json !== null, 'normalized_window_available');
      const item = JSON.parse(row.item_json);
      check(row.dataset === 'controlled_test' && row.boot_id === boot && row.generation === assignments[0].generation &&
        row.seq === index + 1 && row.window_seq === index + 1 && item.seq === row.seq && item.window_seq === row.window_seq, 'window_identity_and_sequence');
      check(item.time.utc_ms >= launchedAt + template.d && item.time.utc_ms <= Date.now() && item.time.uncertainty_ms === 0 &&
        item.time.clock_epoch === 1 && item.time.mono_ms >= item.duration_ms && row.end_utc_ms === item.time.utc_ms &&
        row.end_mono_ms === item.time.mono_ms && row.duration_ms === item.duration_ms && row.quality_mask === item.quality_mask, 'current_time_rebasing');
      check(item.time.utc_ms - item.duration_ms >= simulator.snapshot().device.replay.rebased_start_utc_ms, 'replay_activation_time_bound');
      check(spans.some(span => span.generation === row.generation && item.time.utc_ms - item.duration_ms >= span.start_ms &&
        item.time.utc_ms <= span.end_ms && row.received_at_ms <= span.accept_until_ms), 'rebased_interval_inside_committed_lease');
      if (previous) {
        check(item.time.utc_ms - item.duration_ms >= previous.time.utc_ms && item.time.mono_ms - item.duration_ms >= previous.time.mono_ms &&
          item.time.utc_ms - item.time.mono_ms === previous.time.utc_ms - previous.time.mono_ms, 'nonoverlapping_rebased_window_order');
      }
      const expected = validateStatisticsV3Window({ ...template, q: index + 1, w: index + 1,
        t: [item.time.mono_ms, item.time.utc_ms, 1, 0], f: template.f & ~2 }, limits);
      check(equal(item, expected), 'every_normalized_window_matches_reference');
      normalized.push(item); previous = item;
      const statusRow = statuses[index];
      check(statusRow.item_json !== null, 'normalized_status_available');
      const status = JSON.parse(statusRow.item_json);
      check(statusRow.seq === index + 1 && statusRow.boot_id === boot && status.seq === statusRow.seq &&
        equal(status.time, item.time) && status.uptime_ms === item.time.mono_ms && status.collection_state === 'running' &&
        status.raw_recording === null && Object.values(status.losses).every(value => value === 0), 'every_status_sequence_time_and_losses');
      for (const [stream, sourceRow] of [['window_statistics', row], ['node_status', statusRow]]) {
        const batch = batchMap.get(sourceRow.batch_id), receipt = batch && JSON.parse(batch.receipt_json);
        check(batch && batch.boot_id === boot && batch.generation === assignments[0].generation && batch.stream === stream &&
          batch.seq_first === index + 1 && batch.seq_last === index + 1 && HASH.test(batch.body_sha256) &&
          receipt.protocol === 'campuspulse/3' && receipt.schema === 'device-statistics-receipt/3' && receipt.node_id === node &&
          receipt.boot_id === boot && receipt.batch_id === batch.batch_id && receipt.stream === stream &&
          receipt.policy_id === policy.policy_id && receipt.policy_sha256 === batch.policy_sha256 &&
          batch.policy_sha256 === assignments[0].policy_sha256 && receipt.body_sha256 === batch.body_sha256 &&
          receipt.assignment_generation === batch.generation && receipt.accepted_count === 1 &&
          receipt.seq_first === index + 1 && receipt.seq_last === index + 1 && receipt.durability === 'committed' &&
          receipt.custody === 'small_statistics' && Date.parse(receipt.expires_at) === batch.expires_at_ms &&
          Date.parse(receipt.retain_until) === batch.retain_until_ms, 'every_committed_receipt_tuple_and_hash_metadata');
      }
    }
    report.checks.push('every_normalized_window_exact_reference_equality', 'counts_categories_bins_rssi_coverage_and_losses',
      'rebased_sequence_time_order_and_committed_lease', 'every_status_sequence_time_and_losses', 'every_committed_receipt_tuple_and_hash_metadata');
    report.normalized_statistics_sha256 = sha(canonical(normalized));
    report.receipt_metadata_sha256 = sha(canonical(batches.map(row => ({ stream: row.stream, seq: row.seq_first, body_sha256: row.body_sha256 }))));

    stage = 'browser_administrator';
    await page.getByRole('link', { name: /自动登录本地管理后台/ }).click();
    await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
    await page.getByRole('button', { name: '设备管理', exact: true }).click();
    await page.getByRole('button', { name: `查看设备 ${node}`, exact: true }).click();
    await page.getByRole('heading', { name: 'V3 能力与应用状态', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'V3 运行诊断', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'V3 上传与保管回执', exact: true }).waitFor();
    await page.getByText('已提交；绑定匹配', { exact: true }).first().waitFor();
    const response = await browserJson(page, `/api/v1/admin/device-v3/nodes/${encodeURIComponent(node)}/evidence?limit=50`);
    check(response.status === 200, 'browser_authenticated_admin_evidence');
    const evidence = response.body;
    check(evidence.schema === 'admin-device-v3-evidence/1' && evidence.read_only === true && evidence.original_request_bytes_rehashed === false &&
      evidence.counts.windows === total && evidence.counts.statuses === total && evidence.counts.batches === total * 2 &&
      evidence.counts.latest_events === 0 && evidence.counts.legacy_public_projection_rows === 0, 'admin_evidence_totals_and_custody_boundary');
    check(evidence.batches.rows.length === Math.min(50, batches.length) && evidence.batches.rows.every(batch => {
      const stored = batchMap.get(batch.batch_id);
      return stored && batch.receipt_shape_valid === true && batch.receipt_tuple_match === true && batch.source_rows_match === true &&
        batch.original_request_bytes_rehashed === false && batch.body_sha256 === stored.body_sha256 && equal(batch.receipt, JSON.parse(stored.receipt_json));
    }), 'browser_admin_receipts_match_d1');
    check(evidence.windows.rows.every(window => {
      const stored = windows[window.seq - 1], item = normalized[window.seq - 1];
      return stored && window.batch_id === stored.batch_id && window.dataset === 'controlled_test' && window.payload_available &&
        window.visible_identifiers === item.visible_identifiers && equal(window.reports, item.reports) &&
        equal(window.losses, item.losses) && window.end_utc_ms === item.time.utc_ms;
    }), 'browser_admin_normalized_windows_match_d1');
    const field = await browserJson(page, '/api/v3/places/library/statistics');
    check(field.status === 200 && field.body.reason === 'no_field_statistics', 'public_field_statistics_isolation');
    check(browserErrors.length === 0, 'browser_no_page_errors');
    const final = simulator.snapshot();
    check(!final.last_error && !final.device.lastError && Object.values(final.device.losses).every(value => value === 0) &&
      final.device.replay.completed && final.device.replay.next_index === total && final.device.pendingItems === 0 &&
      final.device.accepted.window_statistics === total && final.device.accepted.node_status === total &&
      (await rows('SELECT seq FROM statistics_windows_v3 WHERE node_id=?')).length === total &&
      (await rows('SELECT seq FROM statistics_status_v3 WHERE node_id=?')).length === total, 'finite_replay_remains_complete');
    report.admin_evidence = { counts: { windows: total, statuses: total, batches: total * 2 }, returned_batches: evidence.batches.returned,
      batches_truncated: evidence.batches.truncated, limit: 50 };
    report.checks.push('browser_history_replay_label', 'browser_device_detail_diagnostics_and_receipts', 'browser_authenticated_admin_evidence_matches_d1',
      'public_field_statistics_isolation', 'browser_no_page_errors', 'finite_replay_remains_complete');
    const failed = await page.evaluate(async () => {
      const response = await fetch('/__simulator/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: 'failed' }) });
      return response.status;
    });
    await pause(600);
    const afterFailure = simulator.snapshot().device;
    check(failed === 200 && afterFailure.phase === 'failed' && afterFailure.terminalGeneration === assignments[0].generation + 1 &&
      afterFailure.accepted.window_statistics === total && afterFailure.accepted.node_status === total, 'post_eof_failed_ack_remains_visible');
    report.checks.push('post_eof_failed_ack_remains_visible');
    report.result = 'passed';
  } catch (error) {
    // Never echo third-party errors: they can include raw JSON, local paths or tokens.
    report.failure_code = error instanceof AcceptanceFailure ? error.code : `local_runner_failure_${stage}`;
  } finally {
    try { await browser?.close(); } catch { report.result = 'failed'; report.failure_code ??= 'browser_cleanup_failed'; }
    try { await simulator?.close(); } catch { report.result = 'failed'; report.failure_code ??= 'simulator_cleanup_failed'; }
  }
  report.elapsed_ms = Date.now() - launchedAt;
  if (options.output) await writePrivateReport(options.output, report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runV3ReplayAcceptance(parseReplayAcceptanceArgs(process.argv.slice(2)));
    console.log(`V3 replay acceptance ${result.result}; ${result.checks.length} checks${result.failure_code ? `; ${result.failure_code}` : ''}. Private report written.`);
    if (result.result !== 'passed') process.exitCode = 1;
  } catch {
    console.error('V3 replay acceptance could not finish or create a new private report. Use --replay FILE --output PRIVATE_DIRECTORY/REPORT.json [--port 5196].');
    process.exitCode = 1;
  }
}
