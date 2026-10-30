import { afterAll, beforeAll, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { startIntegrationServer } from '../scripts/v3-integration-server.mjs';
import { ingestV3Fixture, featureBatchV3 } from './helpers/v3-ingest-fixtures';
import { v3Registration, v3Ack } from './helpers/device-v3-fixtures';
import { concatCpraw, cprawHeader, cprawReport, cprawManifest } from './helpers/cpraw-fixtures';
import { sha256 } from '../worker/ingest';

let directory: string, identityPath: string, server: Awaited<ReturnType<typeof startIntegrationServer>>;
const origin = 'https://isolated-v3.example.test';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cp-v3-integration-'));
  identityPath = join(directory, 'identity.json');
  await writeFile(identityPath, JSON.stringify({ node_id: 'test-controlled-device' }), { mode: 0o600 });
  server = await startIntegrationServer({ port: 0, dataDir: join(directory, 'state'), publicOrigin: origin, deviceIdentityPath: identityPath });
}, 30_000);
afterAll(async () => { await server?.dispose(); await rm(directory, { recursive: true, force: true }); });

async function send(path: string, method = 'GET', body?: unknown, admin = false, cohort = 'synthetic') {
  return server.runtime.dispatchFetch(origin + path, { method,
    headers: { ...(admin ? { Cookie: server.config.adminCookie, Origin: origin } : { Authorization: `Bearer ${server.config[cohort].deviceBearer}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(JSON.stringify(body))) }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

it('serves real HTTPS with private credentials, complete migrations and no public cleanup/admin UI', async () => {
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpsRequest(new URL('/health', server.config.localEndpoint), {
      rejectUnauthorized: false, headers: { Host: new URL(origin).host }, // Local Miniflare self-signed test certificate only.
    }, res => { let body = ''; res.on('data', bytes => { body += bytes; }); res.on('end', () => resolve({ status: res.statusCode!, body })); });
    req.on('error', reject); req.end();
  });
  expect(result.status).toBe(200); expect(JSON.parse(result.body)).toEqual({ ready: true, draining: false, isolation: 'synthetic-controlled-test' });
  for (const path of ['/__synthetic_cleanup', '/admin', '/api/v1/admin/session', '/api/v1/places']) expect((await send(path)).status).toBe(404);
  expect((await send('/api/v1/admin/device-v3/nodes/test-controlled-device')).status).toBe(401);
  expect(await server.db.prepare('SELECT COUNT(*) n FROM v3_integration_migrations').first()).toEqual({ n: 15 });
  expect(await server.db.prepare('SELECT COUNT(*) n FROM device_capabilities_v3').first()).toEqual({ n: 0 });
  expect(await server.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').first()).toEqual({ n: 0 });
  expect(server.config.device.nodeId).toBe('test-controlled-device');
  expect(server.config.device.deviceBearer).not.toBe(server.config.synthetic.deviceBearer);
  expect(server.config.device.archivePolicyId).not.toBe(server.config.synthetic.archivePolicyId);
  const privateConfig = JSON.parse(await readFile(server.configPath, 'utf8'));
  expect(privateConfig.synthetic.endpoint).toBe(origin); expect(privateConfig.device.allowedOrigin).toBe(origin);
  expect((await stat(server.configPath)).mode & 0o777).toBe(0o600);
  expect((await stat(join(directory, 'state'))).mode & 0o777).toBe(0o700);
  expect(await server.runMaintenance()).toMatchObject({ status: 'ok', v3: { deleted_private_rows: 0 }, cpraw_reconciled: 0 });
  expect(await server.db.prepare('SELECT raw_retention_hours FROM cpraw_archive_policies WHERE id=?').bind(server.config.synthetic.archivePolicyId).first()).toEqual({ raw_retention_hours: 1 });
});

it('accepts authenticated synthetic registration/assignment/ACK/ingest and persists D1/R2 across restart', async () => {
  const c = server.config.synthetic, f = await ingestV3Fixture(c.nodeId, c.placementId);
  expect((await send('/api/v3/device/capabilities', 'POST', v3Registration(f.caps))).status).toBe(200);
  expect((await send('/api/v1/admin/device-v3/assignments', 'POST', { policy: f.policy, expected_generation: 0 }, true)).status).toBe(200);
  expect((await send('/api/v3/device/config/ack', 'POST', await v3Ack(f.policy))).status).toBe(200);
  const bytes = await featureBatchV3(f);
  const start = Date.now();
  bytes.items[0].evidence.observed_time.start.utc_ms = start;
  bytes.items[0].evidence.observed_time.end.utc_ms = start + 1000;
  await new Promise(resolve => setTimeout(resolve, 1050));
  const receipt = await send('/api/v3/ingest', 'POST', bytes); expect(receipt.status, await receipt.clone().text()).toBe(200);
  const storedReceipt = await receipt.json();
  const upload = cprawManifest(concatCpraw(cprawHeader(), cprawReport()));
  upload.manifest.archive_policy_id = c.archivePolicyId;
  const manifestBytes = JSON.stringify(upload.manifest);
  const response = await server.runtime.dispatchFetch(origin + `/api/v1/cpraw/uploads/${upload.manifest.upload_id}`, {
    method: 'PUT', body: manifestBytes, headers: { Authorization: `Bearer ${c.deviceBearer}`, 'Content-Type': 'application/json',
      'X-Body-SHA256': await sha256(new TextEncoder().encode(manifestBytes)) },
  });
  expect(response.status).toBe(200);
  await (await server.runtime.getR2Bucket('RAW_BUCKET')).put('test-persistence', 'private-test-value');
  const credential = c.deviceBearer;
  await server.dispose();
  await chmod(join(directory, 'state'), 0o755);
  server = await startIntegrationServer({ port: 0, dataDir: join(directory, 'state'), publicOrigin: origin, deviceIdentityPath: identityPath });
  expect(server.config.synthetic.deviceBearer).toBe(credential);
  expect(await (await send('/api/v3/ingest', 'POST', bytes)).json()).toEqual(storedReceipt);
  expect(await (await (await server.runtime.getR2Bucket('RAW_BUCKET')).get('test-persistence'))!.text()).toBe('private-test-value');
  expect(await server.db.prepare('SELECT COUNT(*) n FROM device_capabilities_v3 WHERE node_id=?').bind(server.config.device.nodeId).first()).toEqual({ n: 0 });
  async function permissions(path: string): Promise<void> {
    const s = await stat(path); expect(s.mode & 0o777).toBe(s.isDirectory() ? 0o700 : 0o600);
    if (s.isDirectory()) for (const name of await readdir(path)) await permissions(join(path, name));
  }
  await permissions(join(directory, 'state'));
}, 30_000);

it('records a redacted scheduled failure while still running the independent CPRAW retention pass', async () => {
  await server.db.exec('ALTER TABLE ingestion_windows_v3 RENAME TO test_missing_windows_v3');
  try {
    expect(await server.runMaintenance()).toMatchObject({ status: 'failed', v3: { error: 'v3_retention_failed' }, cpraw_reconciled: 0 });
    const report = await readFile(join(directory, 'state', 'maintenance-status.json'), 'utf8');
    expect(report).not.toContain('no such table'); expect(report).not.toContain(server.config.device.nodeId);
  } finally { await server.db.exec('ALTER TABLE test_missing_windows_v3 RENAME TO ingestion_windows_v3'); }
  expect(await server.runMaintenance()).toMatchObject({ status: 'ok' });
});

it('retires only synthetic archives explicitly and drains without shortening retained source TTLs', async () => {
  const synthetic = server.config.synthetic.nodeId;
  const before = await server.db.prepare('SELECT expires_at_ms,manifest_json FROM cpraw_uploads WHERE node_id=?').bind(synthetic).first();
  const retired = await server.retireSyntheticArchives();
  expect(retired).toMatchObject({ status: 'ok', retired_count: 1 });
  expect(await server.db.prepare('SELECT state,expires_at_ms,manifest_json FROM cpraw_uploads WHERE node_id=?').bind(synthetic).first())
    .toEqual({ ...before, state: 'expired' });
  expect(await server.db.prepare('SELECT enabled FROM device_nodes WHERE id=?').bind(server.config.device.nodeId).first()).toEqual({ enabled: 1 });
  const remainingBefore = await server.db.prepare('SELECT COUNT(*) n,MAX(expires_at_ms) expires FROM ingestion_items_v3').first();
  const draining = await server.shutdownGracefully();
  expect(draining).toMatchObject({ status: 'draining_until_source_expiry', remaining: { source_count: 1 } });
  const health = await send('/health'); expect(health.status).toBe(503); expect(await health.json()).toMatchObject({ ready: false, draining: true });
  expect(await (await send('/api/v3/device/config?boot_id=11111111-1111-4111-8111-111111111111')).json()).toMatchObject({ error: { code: 'integration_draining' } });
  expect(await server.db.prepare('SELECT COUNT(*) n,MAX(expires_at_ms) expires FROM ingestion_items_v3').first()).toEqual(remainingBefore);
  const stopped = await server.dispose();
  expect(stopped).toMatchObject({ status: 'stopped_with_retained_sources', remaining: { source_count: 1 } });
});

it('runs scheduled maintenance on the default-enabled timer and automatically closes a drained service', async () => {
  const timedDir = join(directory, 'timed');
  const timed = await startIntegrationServer({ port: 0, dataDir: timedDir, deviceIdentityPath: identityPath, maintenanceIntervalMs: 20, shutdownAfterMs: 250 });
  try {
    const initial = await timed.db.prepare('SELECT report_json FROM v3_integration_maintenance WHERE id=1').first();
    await new Promise(resolve => setTimeout(resolve, 80));
    const updated = await timed.db.prepare('SELECT report_json FROM v3_integration_maintenance WHERE id=1').first();
    expect(JSON.parse(updated!.report_json as string).checked_at_ms).toBeGreaterThan(JSON.parse(initial!.report_json as string).checked_at_ms);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('automatic_shutdown_missing')), 5000));
    expect(await Promise.race([timed.closed, timeout])).toMatchObject({ status: 'sources_drained', remaining: { source_count: 0 } });
    expect((await stat(join(timedDir, 'shutdown-status.json'))).mode & 0o777).toBe(0o600);
  } finally { await timed.dispose(); }
}, 15_000);
