import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fetch, ProxyAgent } from 'undici';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

// Read-only cloud operations. Never select device credential digests or print secrets.
export async function dumpIngestion({ output, config = '.wrangler/deploy/wrangler.json', secretFile = '.wrangler/ops/runtime-secrets.json', proxyUrl = process.env.HTTPS_PROXY, request = fetch } = {}) {
  const cutoff = new Date().toISOString();
  output = resolve(output ?? `data/ingestion-${cutoff.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const belowData = relative(resolve('data'), output);
  if (!belowData || belowData.startsWith('..') || belowData.startsWith('/')) throw new Error('output_must_be_new_directory_under_data');
  if (!statSync(secretFile).isFile() || (statSync(secretFile).mode & 0o077)) throw new Error('secret_file_must_be_private');
  const { RESEARCH_TOKEN: token } = JSON.parse(readFileSync(secretFile, 'utf8'));
  if (typeof token !== 'string' || !token) throw new Error('research_credential_missing');
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
  const manifest = { cutoff, completed_at: null, endpoint: 'https://pulse.anend.net',
    representation: 'Research API JSON responses, not original frozen upload bytes. Server verifies R2 original-body SHA-256; response hash and D1 hash are checked locally.',
    snapshot_scope: 'Receipts received by cutoff; raw fetched afterward. Concurrent writes excluded; expiry/cleanup races explicitly recorded. Orphan R2 objects are not included.',
    indexed_batches: index.length, expired_raw_at_cutoff: [], downloaded: [], failures: [] };
  const raw = index.filter(r => r.stream === 'ble_reports');
  const pending = raw.filter(r => {
    if (r.expires_at_ms > Date.parse(cutoff)) return true;
    manifest.expired_raw_at_cutoff.push({ node_id: r.node_id, batch_id: r.batch_id }); return false;
  });
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (cursor < pending.length) {
        const row = pending[cursor++];
        let completed = false;
        for (let attempt = 0; attempt < 3 && !completed; attempt++) {
          try {
            const url = new URL(`/api/v1/research/batches/${encodeURIComponent(row.batch_id)}`, manifest.endpoint);
            url.searchParams.set('node_id', row.node_id);
            const response = await request(url, { headers: { Authorization: `Bearer ${token}` }, dispatcher, redirect: 'error', signal: AbortSignal.timeout(20_000) });
            const bytes = Buffer.from(await response.arrayBuffer());
            if (response.status !== 200) {
              if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
              manifest.failures.push({ node_id: row.node_id, batch_id: row.batch_id, status: response.status }); completed = true; continue;
            }
            const data = JSON.parse(bytes);
            const batch = data.batch;
            if (data.body_sha256 !== row.body_sha256 || batch.node_id !== row.node_id || batch.batch_id !== row.batch_id || batch.boot_id !== row.boot_id || batch.stream !== row.stream || batch.dataset !== row.dataset || batch.firmware_version !== row.firmware_version || batch.placement_id !== row.placement_id || batch.capture_config_id !== row.capture_config_id || batch.items.length !== row.accepted_count || batch.items[0].seq !== row.seq_first || batch.items.at(-1).seq !== row.seq_last) throw new Error('integrity_mismatch');
            const filename = `batches/${randomUUID()}.json`;
            writeFileSync(resolve(output, filename), bytes, { mode: 0o600, flag: 'wx' });
            manifest.downloaded.push({ node_id: row.node_id, batch_id: row.batch_id, file: filename, records: batch.items.length, response_bytes: bytes.length, response_sha256: digest(bytes), original_upload_sha256: row.body_sha256, received_at: row.received_at });
            completed = true;
          } catch (error) {
            if (error.message === 'integrity_mismatch' || attempt === 2) {
              manifest.failures.push({ node_id: row.node_id, batch_id: row.batch_id, error: error.message === 'integrity_mismatch' ? 'integrity_mismatch' : 'fetch_or_parse_failed' }); completed = true;
            }
          }
        }
      }
    }));
  } finally { await dispatcher?.close(); }
  manifest.downloaded.sort((a, b) => a.received_at.localeCompare(b.received_at));
  manifest.completed_at = new Date().toISOString();
  save(resolve(output, 'manifest.json'), manifest);
  console.log(JSON.stringify({ output, cutoff, indexed_batches: index.length, downloaded_batches: manifest.downloaded.length, downloaded_reports: manifest.downloaded.reduce((sum, x) => sum + x.records, 0), expired_raw_at_cutoff: manifest.expired_raw_at_cutoff.length, failures: manifest.failures.length }));
  if (manifest.failures.length) process.exitCode = 1;
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  dumpIngestion({ output: process.argv[2] }).catch(() => { console.error('Dump failed; inspect private local state. Credentials and payloads were not logged.'); process.exitCode = 1; });
}
