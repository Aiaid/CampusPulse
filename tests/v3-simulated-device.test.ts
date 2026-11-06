import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createAdminSession } from '../worker/admin-auth';
import { sha256 } from '../worker/http';
import { createSimulatedV3Device, createSimulationPolicy } from '../scripts/lib/v3-simulated-device.mjs';
import { parseSimulatorArgs, startV3Simulator } from '../scripts/v3-simulator.mjs';

let mf: Miniflare, db: D1Database, cookie: string;
const origin = 'https://simulator.example.test', secret = 'synthetic-simulator-admin-secret';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const localField = { storage: 'ephemeral-local-d1', dataset: 'field', purpose: 'site_observation' };
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['worker/index.ts'],
    bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], external: ['cloudflare:*', 'node:*'], target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'v3-simulated-device-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true', DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1"]', ADMIN_TOKEN: secret }, log: new Log(LogLevel.ERROR) }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort())
    await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  const session = await createAdminSession(secret), now = new Date().toISOString();
  await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('sim-admin', 'sim-admin', 'Synthetic administrator', 'unused-test-hash', 'sim-handle', now, now).run();
  await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','sim-admin',1)")
    .bind(session.hash, now, session.expires).run(); cookie = `cp_admin_session=${session.value}`;
}, 30000);
afterAll(async () => { await mf?.dispose(); });

async function setup(node: string, customize?: (path: string, init: RequestInit, response: Response) => Promise<Response>, transport: 'https' | 'mqtt_tls' = 'https', localConfiguration?: typeof localField, placeId = localConfiguration ? 'library' : null) {
  const token = `private-simulator-token-${node}`, placement = `${node}-place`;
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(node, await sha256(new TextEncoder().encode(token))).run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)')
    .bind(placement, node, placeId, Date.now() - 10000).run();
  const requests: { path: string; body: string }[] = [];
  const device = await createSimulatedV3Device({ nodeId: node, deviceBearer: token, transport, localConfiguration,
    request: async (path: string, init: RequestInit) => {
      requests.push({ path, body: String(init.body ?? '') });
      const response = await mf.dispatchFetch(origin + path, { method: init.method, headers: init.headers as Record<string, string>,
        ...(init.body ? { body: String(init.body) } : {}) }) as unknown as Response;
      return customize ? customize(path, init, response) : response;
    } });
  async function assign(generation = 1, overrides?: (p: any) => void) {
    const policy = await createSimulationPolicy(device.capabilities, { placementId: placement, generation, localConfiguration });
    overrides?.(policy);
    const result = await mf.dispatchFetch(origin + '/api/v1/admin/device-v3/assignments', { method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy, expected_generation: generation - 1 }) });
    expect(result.status, JSON.stringify(await result.json())).toBe(200);
    return policy;
  }
  async function window() {
    const end = device.status().nextWindowEndMs;
    expect(end).not.toBeNull();
    await sleep(Math.max(0, end! - Date.now()) + 15);
    return device.tick();
  }
  return { device, requests, assign, window, token, node };
}

describe.sequential('session-only simulated device against real V3 workerd and D1', () => {
  it('requires an explicit local live choice and rejects historical promotion before reading replay files', async () => {
    expect(parseSimulatorArgs([]).view).toBe('test');
    expect(parseSimulatorArgs(['--view', 'live']).view).toBe('live');
    expect(() => parseSimulatorArgs(['--view', 'demo'])).toThrow('View must');
    expect(() => parseSimulatorArgs(['--replay', 'unused.json', '--view', 'live'])).toThrow('Historical replay');
    await expect(startV3Simulator({ replayFile: 'must-not-be-read.json', view: 'live' })).rejects.toThrow('Historical replay');
    await expect(createSimulatedV3Device({ nodeId: 'x', deviceBearer: 'x', request: () => {}, localConfiguration: { ...localField, storage: 'remote' } })).rejects.toThrow('explicit ephemeral');
    await expect(createSimulatedV3Device({ nodeId: 'x', deviceBearer: 'x', request: () => {}, localConfiguration: { ...localField, purpose: 'controlled_test' } })).rejects.toThrow('explicit ephemeral');
    await expect(createSimulatedV3Device({ nodeId: 'x', deviceBearer: 'x', request: () => {}, localConfiguration: localField, replay: { windows: [] } })).rejects.toThrow('Historical replay');
  });

  it('keeps default controlled tests out of normal live and history, and rejects field assignments', async () => {
    const f = await setup('sim-isolated', undefined, 'https', undefined, 'library');
    await f.device.start(); await f.assign(); await f.device.tick(); await f.window();
    const live = await (await mf.dispatchFetch(origin + '/api/v3/places/library/statistics')).json() as any;
    expect(live).toMatchObject({ state: 'unavailable', reason: 'no_field_statistics' });
    const history = await (await mf.dispatchFetch(origin + '/api/v1/places/library/history?minutes=15', { headers: { 'Cache-Control': 'no-cache' } })).json() as any;
    expect(history.sensor_windows).toEqual([]);
    await f.assign(2, p => { p.custody.dataset = 'field'; p.custody.purpose = 'site_observation'; });
    expect((await f.device.tick()).phase).toBe('failed');
    await db.prepare('UPDATE device_nodes SET enabled=0 WHERE id=?').bind(f.node).run();
    f.device.stop();
  });

  it('sends explicit local field windows through the normal public live and history APIs with backend-only provenance', async () => {
    const f = await setup('sim-local-live', undefined, 'https', localField);
    await f.device.start(); const policy = await f.assign();
    expect(policy.custody).toMatchObject({ dataset: 'field', purpose: 'site_observation' });
    expect(policy.local_raw).toEqual({ mode: 'off' });
    await f.device.tick(); await f.window();
    const readLive = async () => await (await mf.dispatchFetch(origin + '/api/v3/places/library/statistics')).json() as any;
    const quiet = await readLive();
    expect(quiet).toMatchObject({ state: 'observed', visible_identifiers: 2, estimated_total: null });
    f.device.setScenario('busy'); await f.window();
    const busy = await readLive();
    expect(busy).toMatchObject({ state: 'observed', visible_identifiers: 12 });
    expect(Date.parse(busy.observed_at)).toBeGreaterThan(Date.parse(quiet.observed_at));
    const summary = await (await mf.dispatchFetch(origin + '/api/v1/places/library/summary', { headers: { 'Cache-Control': 'no-cache' } })).json() as any;
    expect(summary.sensor.visible_identifiers).toBe(12);
    const history = await (await mf.dispatchFetch(origin + '/api/v1/places/library/history?minutes=15', { headers: { 'Cache-Control': 'no-cache' } })).json() as any;
    expect(history.sensor_windows).toHaveLength(2);
    expect(history.sensor_windows.map((w: any) => w.visible_identifiers)).toEqual([12, 2]);
    expect(JSON.stringify({ quiet, busy, history })).not.toContain('synthetic');
    const inspection = await (await mf.dispatchFetch(origin + `/api/v1/admin/device-v3/nodes/${f.node}`, { headers: { Cookie: cookie } })).json() as any;
    expect(inspection.capabilities.producer_version).toBe('synthetic-statistics/1');
    expect(f.requests.filter(r => r.path.includes('/ingest')).every(r => JSON.parse(r.body).d === 'field')).toBe(true);
    // The permission cannot be broadened by delivering a different dataset or raw policy.
    await f.assign(2, p => { p.custody.dataset = 'controlled_test'; p.custody.purpose = 'controlled_test'; });
    expect((await f.device.tick()).phase).toBe('failed');
    await f.assign(3, p => { p.local_raw = { mode: 'tf_cpraw', format: 'cpraw/1', max_segment_bytes: 1048576, max_total_bytes: 16777216,
      min_free_bytes: 1048576, sync_interval_ms: 1000, full_behavior: 'stop_recording' }; });
    expect((await f.device.tick()).phase).toBe('failed');
    f.device.stop();
  }, 10000);

  it('negotiates native-mode policy declarations and accepts rolling buffers with event reports off', async () => {
    const f = await setup('sim-native-mode', undefined, 'mqtt_tls');
    expect(f.device.capabilities.uplink.transports).toEqual(['mqtt_tls']);
    expect((await f.device.start()).registered).toBe(true);
    const policy = await f.assign(1, p => {
      p.collection.summary.window_ms = 60000; p.collection.summary.bin_ms = 5000;
      p.temporal = { mode: 'rolling', slice_ms: 2000, history_ms: 600000, max_tracks: 512, max_open_events: 64,
        max_event_ms: 3600000, gap_ms: 10000, report_mode: 'off', min_update_ms: 60000 };
    });
    expect(policy.uplink.transport).toBe('mqtt_tls');
    expect(await f.device.tick()).toMatchObject({ appliedGeneration: 1, cadenceMs: 60000, transport: 'mqtt_tls', lastError: null });
    expect(await db.prepare('SELECT state FROM device_acknowledgements_v3 WHERE node_id=? AND generation=1').bind(f.node).first()).toEqual({ state: 'applied' });
    // This injected HTTPS control harness checks protocol negotiation, not a broker or native TLS link.
    expect(f.requests.some(r => r.path === '/api/v3/statistics/ingest')).toBe(false);
    await expect(createSimulationPolicy(f.device.capabilities, { placementId: `${f.node}-place`, transport: 'https' })).rejects.toThrow('Selected transport');
    f.device.stop();
  });

  it('registers, negotiates and uploads quiet/busy/loss windows with actual validators and receipts', async () => {
    const f = await setup('sim-accepted');
    expect(await f.device.start()).toMatchObject({ phase: 'unassigned', configReason: 'unassigned' });
    expect(f.device.capabilities.producer_version).toBe('synthetic-statistics/1');
    await f.assign(); expect((await f.device.tick()).appliedGeneration).toBe(1);
    for (const scenario of ['quiet', 'busy', 'loss']) {
      f.device.setScenario(scenario); const status = await f.window();
      expect(status.lastError).toBeNull();
    }
    expect(f.device.status().accepted).toEqual({ window_statistics: 3, node_status: 3 });
    const rows = await db.prepare('SELECT item_json FROM statistics_windows_v3 WHERE node_id=? ORDER BY seq').bind(f.node).all<{ item_json: string }>();
    const windows = rows.results.map(row => JSON.parse(row.item_json));
    expect(windows.map(w => w.visible_identifiers)).toEqual([2, 12, 8]);
    expect(windows[2]).toMatchObject({ quality_mask: 52, losses: { callback_drops: 2, aggregation_drops: 1, scan_coverage_ms: 900 } });
    expect(await db.prepare('SELECT COUNT(*) n FROM statistics_batches_v3 WHERE node_id=?').bind(f.node).first()).toEqual({ n: 6 });
    expect(f.requests.filter(r => r.path.includes('/ingest')).every(r => r.path === '/api/v3/statistics/ingest' && JSON.parse(r.body).d === 'controlled_test')).toBe(true);
    expect(JSON.stringify(f.device.status())).not.toContain(f.token);
    expect(f.device.status()).toMatchObject({ queuePersistence: 'session-only', powerLossRecovery: false });
    f.device.stop(); const n = f.requests.length; await f.device.tick(); expect(f.requests).toHaveLength(n);
  }, 15000);

  it('retains exact frozen bytes after a lost committed response and rejects a tampered durable receipt', async () => {
    let fault = 'lost';
    const f = await setup('sim-receipt', async (path, _init, response) => {
      if (path === '/api/v3/statistics/ingest' && fault && response.status === 200) {
        if (fault === 'lost') { fault = 'tampered'; throw new Error('private transport details'); }
        if (fault === 'tampered') { fault = ''; return new Response(JSON.stringify({ ...await response.json() as Record<string, unknown>, body_sha256: '0'.repeat(64) }), { headers: { 'cache-control': 'no-store' } }); }
      }
      return response;
    });
    await f.device.start(); await f.assign(); await f.device.tick();
    expect((await f.window()).pendingItems).toBe(2);
    const frozen = f.device.status().pendingBatches[0];
    f.device.setScenario('failed'); // Freeze new collection while checking retained retry bytes.
    const attempts = f.requests.filter(r => r.path === '/api/v3/statistics/ingest').length;
    await f.device.tick(); expect(f.requests.filter(r => r.path === '/api/v3/statistics/ingest')).toHaveLength(attempts);
    await sleep(1010);
    expect((await f.device.tick()).pendingItems).toBe(2);
    expect(f.device.status().pendingBatches[0].sha256).toBe(frozen.sha256);
    await sleep(2010);
    expect((await f.device.tick()).pendingItems).toBe(0);
    const posts = f.requests.filter(r => r.path === '/api/v3/statistics/ingest' && JSON.parse(r.body).k === 'window_statistics');
    expect(posts).toHaveLength(3); expect(new Set(posts.map(r => r.body)).size).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) n FROM statistics_windows_v3 WHERE node_id=?').bind(f.node).first()).toEqual({ n: 1 });
    expect(f.device.status().losses).toMatchObject({ upload_failures: 2, retries: 2 });
    expect(f.device.status().lastError).toBeNull(); f.device.stop();
  }, 10000);

  it('retains the exact control ACK after a committed response is lost', async () => {
    let loseAck = true;
    const f = await setup('sim-ack-retry', async (path, _init, response) => {
      if (path === '/api/v3/device/config/ack' && loseAck && response.status === 200) {
        loseAck = false; throw new Error('sensitive transport diagnostic');
      }
      return response;
    });
    await f.device.start(); await f.assign();
    expect((await f.device.tick()).pendingControlItems).toBe(1);
    expect(f.device.status().lastError).toBe('Local device transport failed.');
    // An intervening scenario change cannot mutate a frozen applied ACK.
    f.device.setScenario('failed');
    expect((await f.device.tick()).pendingControlItems).toBe(0);
    const posts = f.requests.filter(r => r.path === '/api/v3/device/config/ack');
    expect(posts).toHaveLength(2); expect(posts[0].body).toBe(posts[1].body);
    expect(JSON.parse(posts[1].body).state).toBe('applied');
    expect(f.device.status().appliedGeneration).toBe(1); f.device.stop();
  });

  it('retains exhausted frozen work until an explicit operator retry', async () => {
    let rejectOnce = true;
    const f = await setup('sim-exhausted', async (path, _init, response) => {
      if (path === '/api/v3/statistics/ingest' && rejectOnce && response.status === 200) {
        rejectOnce = false; return new Response('{}', { status: 503 });
      }
      return response;
    });
    await f.device.start(); await f.assign(1, p => { p.uplink.retry.max_attempts = 1; }); await f.device.tick();
    expect((await f.window()).phase).toBe('retry_exhausted');
    const sha = f.device.status().pendingBatches[0].sha256;
    f.device.setScenario('failed');
    const requests = f.requests.length; await f.device.tick();
    expect(f.requests.slice(requests).filter(r => r.path === '/api/v3/statistics/ingest')).toHaveLength(0);
    expect(f.device.status().pendingBatches[0]).toMatchObject({ sha256: sha, retryExhausted: true });
    f.device.retryPending(); expect((await f.device.tick()).pendingItems).toBe(0);
    const bodies = f.requests.filter(r => r.path === '/api/v3/statistics/ingest' && JSON.parse(r.body).k === 'window_statistics').map(r => r.body);
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]); f.device.stop();
  }, 10000);

  it('bounds offline backlog, reconnects and records a real failed ACK before a later applied generation', async () => {
    const f = await setup('sim-offline');
    f.device.setScenario('offline'); expect((await f.device.start()).registered).toBe(false); expect(f.requests).toHaveLength(0);
    f.device.setScenario('quiet'); await f.device.tick(); await f.assign(); await f.device.tick();
    f.device.setScenario('offline'); const requestCount = f.requests.length;
    expect((await f.window()).pendingItems).toBe(2);
    await f.window(); expect(f.device.status().pendingItems).toBe(2); expect(f.requests).toHaveLength(requestCount);
    f.device.setScenario('busy'); expect((await f.device.tick()).pendingItems).toBe(0);
    f.device.setScenario('failed'); await f.assign(2); expect((await f.device.tick()).phase).toBe('failed');
    expect(await db.prepare('SELECT state FROM device_acknowledgements_v3 WHERE node_id=? AND generation=2').bind(f.node).first()).toEqual({ state: 'failed' });
    const prior = f.device.status().accepted.window_statistics; await f.device.tick(); expect(f.device.status().accepted.window_statistics).toBe(prior);
    f.device.setScenario('quiet'); await f.assign(3); expect((await f.device.tick()).appliedGeneration).toBe(3);
    expect((await f.window()).lastError).toBeNull(); f.device.stop();
  }, 12000);

  it('uses committed lease renewal and fails closed on non-controlled or raw policy directions', async () => {
    const f = await setup('sim-lease');
    await f.device.start(); await f.assign(1, p => { p.control.lease.duration_ms = 30000; });
    expect((await f.device.tick()).lastError).toBeNull();
    const before = f.device.status().leaseUntilMs; await sleep(15100);
    expect((await f.device.tick()).leaseUntilMs).toBeGreaterThan(before!);
    expect(f.requests.some(r => r.path === '/api/v3/device/lease')).toBe(true);
    expect(await db.prepare('SELECT contact_seq FROM device_statistics_authorizations_v3 WHERE node_id=?').bind(f.node).first()).toEqual({ contact_seq: 1 });
    await f.assign(2, p => { p.custody.dataset = 'demo'; p.custody.purpose = 'demonstration'; });
    expect((await f.device.tick()).phase).toBe('failed');
    expect(await db.prepare('SELECT state FROM device_acknowledgements_v3 WHERE node_id=? AND generation=2').bind(f.node).first()).toEqual({ state: 'failed' });
    await f.assign(3, p => { p.local_raw = { mode: 'tf_cpraw', format: 'cpraw/1', max_segment_bytes: 1048576, max_total_bytes: 16777216,
      min_free_bytes: 1048576, sync_interval_ms: 1000, full_behavior: 'stop_recording' }; });
    expect((await f.device.tick()).phase).toBe('failed');
    expect(await db.prepare('SELECT state FROM device_acknowledgements_v3 WHERE node_id=? AND generation=3').bind(f.node).first()).toEqual({ state: 'failed' });
    f.device.stop();
    for (const cadenceMs of [30000, 60000]) {
      const policy = await createSimulationPolicy(f.device.capabilities, { placementId: 'sim-place', cadenceMs });
      expect(policy.collection.summary).toMatchObject({ window_ms: cadenceMs, bin_ms: 5000 });
    }
    await expect(createSimulatedV3Device({ nodeId: 'x', deviceBearer: 'x', request: () => {}, cadenceMs: 50 })).rejects.toThrow('Cadence');
  }, 25000);
});
