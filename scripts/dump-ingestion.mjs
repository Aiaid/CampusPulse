// Historical D1 metadata export only; V1/V2 live upload/research routes are retired.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

// Read-only cloud operations. Never select device credential digests or print secrets.
export async function dumpIngestion({ output, config = '.wrangler/deploy/wrangler.json' } = {}) {
  const cutoff = new Date().toISOString();
  output = resolve(output ?? `data/ingestion-${cutoff.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const belowData = relative(resolve('data'), output);
  if (!belowData || belowData.startsWith('..') || belowData.startsWith('/')) throw new Error('output_must_be_new_directory_under_data');
  mkdirSync(resolve('data'), { recursive: true, mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  mkdirSync(resolve(output, 'batches'), { mode: 0o700 });
  const sql = [
    `SELECT node_id,batch_id,boot_id,stream,dataset,firmware_version,placement_id,capture_config_id,body_sha256,accepted_count,seq_first,seq_last,received_at,expires_at_ms FROM ingestion_batches WHERE received_at <= '${cutoff}' ORDER BY received_at,node_id,batch_id`,
    `SELECT id,node_id,placement_id,dataset,config_json,accept_until_ms,raw_retention_hours,aggregate_retention_days FROM capture_configs`,
    `SELECT node_id,boot_id,seq,batch_id,dataset,utc_ms,item_json,received_at FROM sensor_windows WHERE received_at <= '${cutoff}'`,
    `SELECT node_id,boot_id,seq,batch_id,dataset,utc_ms,item_json,received_at FROM node_status WHERE received_at <= '${cutoff}'`,
  ].join('; ');
  const query = spawnSync(resolve('node_modules/.bin/wrangler'), ['d1', 'execute', 'campuspulse', '--config', config, '--remote', '--json', '--command', sql], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90_000,
    env: { ...process.env, WRANGLER_LOG_PATH: resolve(output, 'wrangler.log') },
  });
  if (query.status !== 0) throw new Error('remote_index_query_failed');
  const result = JSON.parse(query.stdout);
  if (result.length !== 4 || result.some(r => !r.success || r.meta?.changed_db || r.meta?.rows_written)) throw new Error('unexpected_query_result');
  const [index, configs, windows, statuses] = result.map(r => r.results);
  save(resolve(output, 'index.json'), index);
  save(resolve(output, 'capture-configs.json'), configs);
  save(resolve(output, 'sensor-windows.json'), windows);
  save(resolve(output, 'node-status.json'), statuses);
  const manifest = { cutoff, completed_at:new Date().toISOString(),
    representation:'Read-only retained legacy D1 records. No original request bytes were rehashed.',
    snapshot_scope:'Historical records received by cutoff; this does not enable a device protocol.',
    indexed_batches:index.length,downloaded:[],failures:[],expired_raw_at_cutoff:[],
    raw_download_state:'not_requested_legacy_research_api_retired' };
  save(resolve(output, 'manifest.json'), manifest);
  console.log(JSON.stringify({ output, cutoff, indexed_batches: index.length, downloaded_batches: manifest.downloaded.length, downloaded_reports: manifest.downloaded.reduce((sum, x) => sum + x.records, 0), expired_raw_at_cutoff: manifest.expired_raw_at_cutoff.length, failures: manifest.failures.length }));
  if (manifest.failures.length) process.exitCode = 1;
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  dumpIngestion({ output: process.argv[2] }).catch(() => { console.error('Dump failed; inspect private local state. Credentials and payloads were not logged.'); process.exitCode = 1; });
}
