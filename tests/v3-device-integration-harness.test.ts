import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createAdminSession } from '../worker/admin-auth';
import { sha256 } from '../worker/ingest';
import { readPrivateJson, runIntegration, validateConfig, fixtureTools } from '../scripts/v3-device-integration.mjs';
import { INGEST_V3_FLAGS } from './helpers/v3-ingest-fixtures';
let mf: Miniflare, db: D1Database, privateDir: string, cookie: string;
const ORIGIN = 'https://synthetic-harness.example.test', token = 'synthetic-harness-device-token', secret = 'synthetic-harness-admin-secret';
function config(node = 'synthetic-harness-node') {
  return { isolation: 'synthetic-controlled-test', operator_confirmed_isolated: true, endpoint: ORIGIN, allowedOrigin: ORIGIN,
    nodeId: node, placementId: `${node}-place`, actor: 'synthetic_client', deviceBearer: `${token}-${node}`, adminCookie: cookie, outputDir: path.join(privateDir, node) };
}
const transport = (url: string, options: RequestInit) => mf.dispatchFetch(url, options as Parameters<Miniflare['dispatchFetch']>[1]);
async function seedNode(node: string) {
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(node, await sha256(new TextEncoder().encode(config(node).deviceBearer))).run();
  await db.prepare('INSERT INTO placements(id,node_id,valid_from_ms) VALUES(?,?,?)').bind(`${node}-place`, node, Date.now() - 60000).run();
}
beforeAll(async () => {
  privateDir = await mkdtemp(path.join(tmpdir(), 'v3-integration-harness-'));
  const bundle = await build({ entryPoints: ['tests/helpers/v3-ingest-workerd.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'v3-integration-harness', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { ...INGEST_V3_FLAGS,
      DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-only/1","cp-v3-producer/1"]', DEVICE_V3_EXTRACTOR_VERSIONS: '["synthetic-extractor/1","cp-v3-ad/1"]', ADMIN_TOKEN: secret }, log: new Log(LogLevel.ERROR) }));
  db = await mf.getD1Database('DB');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  }
  const now = new Date().toISOString(), session = await createAdminSession(secret);
  await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('synthetic-harness-admin', 'synthetic-harness-admin', 'Synthetic administrator', 'unused-test-hash', 'synthetic-handle', now, now).run();
  await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','synthetic-harness-admin',1)")
    .bind(session.hash, now, session.expires).run();
  cookie = `cp_admin_session=${session.value}`;
}, 30000);
afterAll(async () => { await mf?.dispose(); await rm(privateDir, { recursive: true, force: true }); });

describe.sequential('isolated v3 integration CLI', () => {
  it('requires private regular JSON and explicit isolated HTTPS origin; rejects production and unsafe overrides', async () => {
    const filename = path.join(privateDir, 'config.json');
    await writeFile(filename, '{}', { mode: 0o600 }); expect(await readPrivateJson(filename)).toEqual({});
    await chmod(filename, 0o644); await expect(readPrivateJson(filename)).rejects.toThrow('0600');
    await chmod(filename, 0o600); await symlink(filename, path.join(privateDir, 'linked.json'));
    await expect(readPrivateJson(path.join(privateDir, 'linked.json'))).rejects.toThrow();
    for (const endpoint of ['http://localhost:8799', 'https://pulse.anend.net', 'https://campuspulse.account.workers.dev', 'https://example.org', 'https://localhost/path']) {
      expect(() => validateConfig({ ...config(), endpoint, allowedOrigin: new URL(endpoint).origin })).toThrow();
    }
    expect(() => validateConfig({ ...config(), operator_confirmed_isolated: false })).toThrow();
    expect(() => validateConfig({ ...config(), allowedOrigin: 'https://different.example.test' })).toThrow();
    expect(() => validateConfig({ ...config(), policyOptions: { arbitrary: 'never' } })).toThrow();
    expect(() => validateConfig({ ...config(), nodeId: 'actual-device', actor: 'synthetic_client' })).toThrow();
    expect(validateConfig({ ...config(), nodeId: 'v3-synthetic-node' }).nodeId).toBe('v3-synthetic-node');
    for (const endpoint of ['https://192.168.8.8:8799', 'https://fully-gives-powder-titten.trycloudflare.com']) {
      expect(validateConfig({ ...config(), endpoint, allowedOrigin: endpoint }).endpoint).toBe(endpoint);
    }
  });
  it('freezes exact retries, uses first-ACK server time, checks receipts and saves only redacted evidence', async () => {
    const c = config(); await seedNode(c.nodeId);
    const prepared = await runIntegration(c, 'prepare', { transport });
    expect(prepared.outcome).toBe('prepared_awaiting_device_ack');
    expect((await runIntegration(c, 'prepare', { transport })).outcome).toBe('prepared_awaiting_device_ack');
    expect(await db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').first()).toMatchObject({ n: 0 });
    const result = await runIntegration(c, 'exercise', { transport });
    expect(result.outcome).toBe('synthetic_server_acceptance_passed');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'changed_bytes_same_batch_conflict', status: 409 }), expect.objectContaining({ check: 'wrong_node_rejected', status: 403 })]));
    const state = await readPrivateJson(path.join(c.outputDir, 'state.json'));
    const applied = await db.prepare('SELECT received_at FROM device_acknowledgements_v3').first<{ received_at: string }>();
    const feature = JSON.parse(state.bodies.feature);
    expect(feature.items[0].evidence.observed_time.start.utc_ms).toBeGreaterThanOrEqual(Date.parse(applied!.received_at));
    expect(await db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v3').first()).toMatchObject({ n: 2 });
    const reportText = await readFile(path.join(c.outputDir, 'report.json'), 'utf8');
    for (const hidden of [token, cookie, feature.items[0].evidence.identity.token, c.nodeId, c.placementId, 'company_ids', 'support_reports', state.frozen.policy_sha256]) expect(reportText).not.toContain(hidden);
    expect((await lstat(path.join(c.outputDir, 'state.json'))).mode & 0o777).toBe(0o600);
    expect((await lstat(c.outputDir)).mode & 0o777).toBe(0o700);
    const replay = await runIntegration(c, 'exercise', { transport });
    expect(replay.outcome).toBe('synthetic_server_acceptance_passed');
    expect((await readPrivateJson(path.join(c.outputDir, 'state.json'))).bodies).toEqual(state.bodies);
    expect(await db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v3').first()).toMatchObject({ n: 2 });
    const requests: string[] = [];
    const verified = await runIntegration(c, 'verify', { transport: (url: string, options: RequestInit) => { requests.push(options.method!); return transport(url, options); } });
    expect(verified.outcome).toBe('device_claimed_applied'); expect(requests).toEqual(['GET', 'GET']);
  }, 20000);
  it('does not synthesize application or upload in actual-device mode, or prepare implicitly during verify', async () => {
    let calls = 0; const noCall = async () => { calls++; throw new Error('Must not call.'); };
    await expect(runIntegration({ ...config(), actor: 'existing_device' }, 'exercise', { transport: noCall })).rejects.toThrow('reserved');
    await expect(runIntegration(config('synthetic-unprepared'), 'verify', { transport: noCall })).rejects.toThrow('existing prepared');
    expect(calls).toBe(0);
  });
  it('reads actual registered capabilities and template limits without replacing device claims or ACKs', async () => {
    const c = { ...config('synthetic-template-device'), actor: 'existing_device', policyTemplateFile: path.join(privateDir, 'policy-template.json') };
    await seedNode(c.nodeId);
    const tools = await fixtureTools(), f = await tools.ingestV3Fixture(c.nodeId, c.placementId);
    f.caps.producer_version = 'cp-v3-producer/1'; f.caps.features.extractor_versions = ['cp-v3-ad/1'];
    f.policy.evidence.extractor_version = 'cp-v3-ad/1';
    await writeFile(c.policyTemplateFile, JSON.stringify(f.policy), { mode: 0o600 });
    const registration = await transport(ORIGIN + '/api/v3/device/capabilities', { method: 'POST', headers: { Authorization: `Bearer ${c.deviceBearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tools.v3Registration(f.caps)) });
    expect(registration.status).toBe(200);
    const methods: string[] = [];
    const report = await runIntegration(c, 'prepare', { transport: (url: string, options: RequestInit) => { if (options.method === 'POST') methods.push(new URL(url).pathname); return transport(url, options); } });
    expect(report.outcome).toBe('prepared_awaiting_device_ack');
    expect(methods).toEqual(['/api/v1/admin/device-v3/assignments', '/api/v1/admin/device-v3/assignments']);
    const state = await readPrivateJson(path.join(c.outputDir, 'state.json'));
    expect(state.fixture.caps).toEqual(f.caps);
    expect(state.fixture.policy.evidence.extractor_version).toBe('cp-v3-ad/1');
    expect(state.fixture.policy.control.capability_sha256).toBe(await tools.capabilityDigestV3(f.caps));
    await expect(runIntegration(c, 'verify', { transport })).rejects.toThrow('ACK is not present');
    expect(await db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3 WHERE node_id=?').bind(c.nodeId).first()).toMatchObject({ n: 0 });
  });
});
