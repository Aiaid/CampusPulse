import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createAdminSession } from '../worker/admin-auth';
import { sha256 } from '../worker/http';
import { readPrivateJson, validateConfig, httpsTransport, statisticsTools, expectedStatisticsReceipt, runStatisticsIntegration } from '../scripts/v3-statistics-integration.mjs';

let mf: Miniflare, db: D1Database, folder: string, origin: string, cookie: string, server: Server, ca: Buffer;
const token = 'synthetic-statistics-harness-token', secret = 'synthetic-statistics-harness-admin-secret';
const requests: { method: string; pathname: string; body: string }[] = [];
const config = (node = 'synthetic-statistics-harness') => ({ isolation: 'synthetic-controlled-test', operator_confirmed_isolated: true,
  actor: 'synthetic_client', endpoint: origin, allowedOrigin: origin, nodeId: node, placementId: `${node}-place`,
  deviceBearer: `${token}-${node}`, adminCookie: cookie, outputDir: path.join(folder, node), policyOptions: { windowMs: 1000 } });
async function seed(node: string) {
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(node, await sha256(new TextEncoder().encode(config(node).deviceBearer))).run();
  await db.prepare('INSERT INTO placements(id,node_id,valid_from_ms) VALUES(?,?,?)').bind(`${node}-place`, node, Date.now() - 10000).run();
}
beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'v3-statistics-harness-'));
  const bundle = await build({ stdin: { contents: `import {handleDeviceV3Control} from './worker/device-v3-control'; import {handleDeviceV3Statistics} from './worker/device-v3-statistics'; export default {async fetch(r,e){return await handleDeviceV3Control(r,e) ?? await handleDeviceV3Statistics(r,e) ?? new Response('Not found',{status:404})}};`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'v3-statistics-harness', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true', DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1","cp-v3-small/1"]', ADMIN_TOKEN: secret }, log: new Log(LogLevel.ERROR) }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  }
  const now = new Date().toISOString(), session = await createAdminSession(secret);
  await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('synthetic-stats-admin', 'synthetic-stats-admin', 'Synthetic administrator', 'unused-test-hash', 'synthetic-handle', now, now).run();
  await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','synthetic-stats-admin',1)")
    .bind(session.hash, now, session.expires).run(); cookie = `cp_admin_session=${session.value}`;
  const key = path.join(folder, 'test-key.pem'), cert = path.join(folder, 'test-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  ca = await readFile(cert);
  server = createServer({ key: await readFile(key), cert: ca }, async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString(), pathname = new URL(incoming.url!, origin).pathname;
      requests.push({ method: incoming.method!, pathname, body });
      const result = await mf.dispatchFetch(origin + incoming.url, { method: incoming.method,
        headers: incoming.headers as Record<string, string>, ...(body ? { body } : {}) });
      outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await mf?.dispose(); if (folder) await rm(folder, { recursive: true, force: true });
});

describe.sequential('isolated compact statistics harness with real HTTPS and workerd', () => {
  it('retains the private configuration, origin and TLS safety boundaries', async () => {
    const file = path.join(folder, 'private.json'); await writeFile(file, '{}', { mode: 0o600 });
    expect(await readPrivateJson(file)).toEqual({}); await chmod(file, 0o644); await expect(readPrivateJson(file)).rejects.toThrow('0600');
    await chmod(file, 0o600); await symlink(file, path.join(folder, 'symlink.json')); await expect(readPrivateJson(path.join(folder, 'symlink.json'))).rejects.toThrow();
    for (const endpoint of ['http://localhost:8787', 'https://pulse.anend.net', 'https://campuspulse.account.workers.dev', 'https://example.org']) {
      expect(() => validateConfig({ ...config(), endpoint, allowedOrigin: new URL(endpoint).origin })).toThrow();
    }
    expect(() => validateConfig({ ...config(), allowedOrigin: 'https://other.test' })).toThrow();
    expect(() => validateConfig({ ...config(), nodeId: 'real-device' })).toThrow();
    await expect(httpsTransport()(origin + '/', { method: 'GET', headers: {} })).rejects.toThrow('HTTPS request failed');
  });
  it('waits for an actual first lease window, freezes compact bytes, checks custody, rejects conflicts and renews', async () => {
    const c = config(); await seed(c.nodeId); const transport = httpsTransport(ca);
    expect((await runStatisticsIntegration(c, 'prepare', { transport })).outcome).toBe('prepared_awaiting_device_ack');
    expect(await db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').first()).toMatchObject({ n: 0 });
    const started = Date.now(), report = await runStatisticsIntegration(c, 'exercise', { transport });
    expect(report.outcome).toBe('synthetic_statistics_acceptance_passed'); expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'changed_bytes_same_batch_conflict', status: 409 }),
      expect.objectContaining({ check: 'wrong_node_rejected', status: 403 }), expect.objectContaining({ check: 'synthetic_lease_renewal', status: 200 })]));
    const state = await readPrivateJson(path.join(c.outputDir, 'state.json')), b = JSON.parse(state.bodies.statistics);
    const ack = await db.prepare('SELECT receipt_json FROM device_statistics_authorizations_v3').first<{ receipt_json: string }>();
    const applied = await db.prepare('SELECT acknowledgement_json FROM device_acknowledgements_v3').first<{ acknowledgement_json: string }>();
    const first = JSON.parse(applied!.acknowledgement_json);
    expect(b.x[0].t[1] - b.x[0].d).toBeGreaterThanOrEqual(Date.parse(first.server_time)); expect(b.x[0].t[1]).toBeLessThan(first.lease_until_ms);
    expect(JSON.parse(ack!.receipt_json)).toMatchObject({ contiguous: true, span_seq: 1 });
    expect(await db.prepare('SELECT COUNT(*) n FROM statistics_batches_v3').first()).toMatchObject({ n: 2 });
    const receipt = JSON.parse((await db.prepare('SELECT receipt_json FROM statistics_batches_v3 WHERE stream=?').bind('window_statistics').first<{ receipt_json: string }>())!.receipt_json);
    expectedStatisticsReceipt(receipt, state.bodies.statistics);
    for (const changed of [{ ...receipt, custody: 'private_source' }, { ...receipt, body_sha256: '0'.repeat(64) }, { ...receipt, extra: true }]) {
      expect(() => expectedStatisticsReceipt(changed, state.bodies.statistics)).toThrow();
    }
    const reportText = await readFile(path.join(c.outputDir, 'report.json'), 'utf8');
    for (const hidden of [token, cookie, c.nodeId, c.placementId, 'Authorization', 'cp_admin_session']) expect(reportText).not.toContain(hidden);
    expect((await lstat(path.join(c.outputDir, 'state.json'))).mode & 0o777).toBe(0o600); expect((await lstat(c.outputDir)).mode & 0o777).toBe(0o700);
    const posts = requests.filter(r => r.method === 'POST'); expect(posts.some(r => r.pathname === '/api/v3/ingest')).toBe(false);
    const normal = posts.filter(r => r.pathname === '/api/v3/statistics/ingest').map(r => JSON.parse(r.body));
    expect(normal.every(v => ['window_statistics', 'node_status'].includes(v.k))).toBe(true);
    expect(normal.every(v => !('items' in v) && !JSON.stringify(v).includes('identity'))).toBe(true);
    expect((await runStatisticsIntegration(c, 'exercise', { transport })).outcome).toBe('synthetic_statistics_acceptance_passed');
    expect((await readPrivateJson(path.join(c.outputDir, 'state.json'))).bodies).toEqual(state.bodies);
    const before = requests.length; expect((await runStatisticsIntegration(c, 'verify', { transport })).outcome).toBe('device_claimed_applied');
    expect(requests.slice(before).map(r => [r.method, r.pathname])).toEqual([['GET', `/api/v1/admin/device-v3/nodes/${c.nodeId}`]]);
  }, 20000);
  it('requires explicit existing state and never fabricates actual-device registration, ACK or uploads', async () => {
    let count = 0; const noCall = async () => { count++; throw new Error('must not call'); };
    await expect(runStatisticsIntegration({ ...config(), actor: 'existing_device' }, 'exercise', { transport: noCall })).rejects.toThrow('reserved');
    await expect(runStatisticsIntegration(config('synthetic-unprepared-stats'), 'verify', { transport: noCall })).rejects.toThrow('existing prepared'); expect(count).toBe(0);
    const c = { ...config('synthetic-actual-claim'), actor: 'existing_device', policyTemplateFile: path.join(folder, 'template.json') };
    await seed(c.nodeId); const tools = await statisticsTools(), caps = tools.statisticsCapabilities(c.nodeId); caps.producer_version = 'cp-v3-small/1';
    const policy = await tools.statisticsPolicy(caps, c.placementId); await writeFile(c.policyTemplateFile, JSON.stringify(policy), { mode: 0o600 });
    const transport = httpsTransport(ca);
    const reg = await transport(origin + '/api/v3/device/capabilities', { method: 'POST', headers: { Authorization: `Bearer ${c.deviceBearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tools.v3Registration(caps)) });
    expect(reg.status).toBe(200); const before = requests.length;
    expect((await runStatisticsIntegration(c, 'prepare', { transport })).outcome).toBe('prepared_awaiting_device_ack');
    expect(requests.slice(before).filter(r => r.method === 'POST').map(r => r.pathname)).toEqual(['/api/v1/admin/device-v3/assignments', '/api/v1/admin/device-v3/assignments']);
    const state = await readPrivateJson(path.join(c.outputDir, 'state.json')); expect(state.caps).toEqual(caps);
    expect(state.frozen.policy.control.capability_sha256).toBe(await tools.capabilityDigestV3(caps));
    expect(state.frozen.policy.collection.summary).toEqual(policy.collection.summary);
    await expect(runStatisticsIntegration(c, 'verify', { transport })).rejects.toThrow('ACK is not present');
    expect(await db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3 WHERE node_id=?').bind(c.nodeId).first()).toMatchObject({ n: 0 });
  });
  it('prepares target 30s/5s and default 60s/5s policies without sending a measurement', async () => {
    for (const window of [30000, 60000]) {
      const c = { ...config(`synthetic-cadence-${window}`), policyOptions: window === 60000 ? {} : { windowMs: window } };
      await seed(c.nodeId); const before = requests.length;
      expect((await runStatisticsIntegration(c, 'prepare', { transport: httpsTransport(ca) })).outcome).toBe('prepared_awaiting_device_ack');
      const state = await readPrivateJson(path.join(c.outputDir, 'state.json'));
      expect(state.frozen.policy.collection.summary).toMatchObject({ window_ms: window, bin_ms: 5000 });
      expect(state.bodies).toBeUndefined();
      expect(requests.slice(before).some(r => r.pathname === '/api/v3/statistics/ingest' || r.pathname === '/api/v3/device/config/ack')).toBe(false);
    }
  });
});
