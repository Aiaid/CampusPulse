import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createAdminSession } from '../worker/admin-auth';
import { sha256 } from '../worker/http';
import { clockTranscript, type ClockProofFields } from '../worker/device-v3-clock';
import { v3Ack, v3Registration } from './helpers/device-v3-fixtures';
import { statisticsCapabilities, statisticsPolicy } from './helpers/v3-statistics-policy-fixtures';
let mf: Miniflare, cookie: string, db: Awaited<ReturnType<Miniflare['getD1Database']>>, publicKey: CryptoKey;
const ORIGIN = 'https://synthetic-startup.example.test', token = 'synthetic-startup-workerd-token', secret = 'synthetic-startup-admin';
const caps = statisticsCapabilities('synthetic-startup-workerd');
let policy: Awaited<ReturnType<typeof statisticsPolicy>>;
async function request(path: string, body?: unknown, admin = false, anonymous = false) {
  return mf.dispatchFetch(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(anonymous ? {} : admin ? { Cookie: cookie, Origin: ORIGIN } : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['tests/helpers/device-v3-workerd.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); publicKey = keys.publicKey;
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'startup-control-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true', DEVICE_V3_STARTUP_ENABLED: 'true',
      DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1"]', ADMIN_TOKEN: secret,
      DEVICE_V3_CLOCK_PRIVATE_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey)),
      DEVICE_V3_CLOCK_AUDIENCE: ORIGIN, DEVICE_V3_CLOCK_KEY_ID: 'synthetic-workerd-key', DEVICE_V3_CLOCK_MAX_ERROR_MS: '1000' }, log: new Log(LogLevel.ERROR) }));
  db = await mf.getD1Database('DB');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  }
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(caps.node_id, await sha256(new TextEncoder().encode(token))).run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)').bind('synthetic-startup-place', caps.node_id, 'library', 0).run();
  const now = new Date().toISOString(), session = await createAdminSession(secret);
  await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('synthetic-admin', 'synthetic-admin', 'Synthetic administrator', 'unused-test-hash', 'synthetic-user-handle', now, now).run();
  await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','synthetic-admin',1)")
    .bind(session.hash, now, session.expires).run();
  cookie = `cp_admin_session=${session.value}`; caps.uplink!.transports = ['mqtt_tls']; policy = await statisticsPolicy(caps, 'synthetic-startup-place');
  if (policy.uplink.enabled) policy.uplink.transport = 'mqtt_tls';
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe.sequential('startup and signed clock in actual workerd', () => {
  it('produces standard verifiable P1363 time proofs and DER91 metadata', async () => {
    const response = await request('/api/v3/clock', { nonce: 'a7'.repeat(32) }, false, true);
    expect(response.status).toBe(200);
    const proof = await response.json() as ClockProofFields & { sig: string };
    expect(Buffer.from(proof.sig, 'base64url')).toHaveLength(64);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, Buffer.from(proof.sig, 'base64url'), clockTranscript(proof))).toBe(true);
    const key = await (await request('/api/v3/clock/key', undefined, false, true)).json() as { public_key_spki: string };
    expect(Buffer.from(key.public_key_spki, 'base64url')).toHaveLength(91);
  });
  it('approves a real-ACK template then atomically mints only one concurrent new-boot generation', async () => {
    expect((await request('/api/v3/device/capabilities', v3Registration(caps))).status).toBe(200);
    expect((await request('/api/v1/admin/device-v3/assignments', { policy, expected_generation: 0 }, true)).status).toBe(200);
    expect((await request('/api/v3/device/config/ack', await v3Ack(policy))).status).toBe(200);
    expect((await request(`/api/v1/admin/device-v3/nodes/${caps.node_id}/startup-grant`, { enabled: true, expected_revision: 0,
      source_generation: 1, grant_expires_at: new Date(Date.now() + 86400000).toISOString(), policy_ttl_ms: 1200000, accept_grace_ms: 3600000 }, true)).status).toBe(200);
    caps.boot_id = crypto.randomUUID(); caps.capability_id = 'next-startup-boot';
    expect((await request('/api/v3/device/capabilities', v3Registration(caps))).status).toBe(200);
    const responses = await Promise.all([request('/api/v3/device/config?boot_id=' + caps.boot_id), request('/api/v3/device/config?boot_id=' + caps.boot_id)]);
    expect(responses.some(r => r.status === 200)).toBe(true); expect(responses.every(r => [200, 409].includes(r.status))).toBe(true);
    const winner = await request('/api/v3/device/config?boot_id=' + caps.boot_id);
    policy = (await winner.json() as { config: { policy: typeof policy } }).config.policy;
    expect(policy.assignment_generation).toBe(2);
    expect(await db.prepare('SELECT COUNT(*) n FROM device_startup_assignments_v3').first()).toMatchObject({ n: 1 });
    expect(await db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').first()).toMatchObject({ n: 1 });
    expect(await db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').first()).toMatchObject({ n: 0 });
  });
  it('rolls back an ACK if the grant is revoked within its transaction', async () => {
    await db.exec(`CREATE TRIGGER test_revoke_startup AFTER INSERT ON device_statistics_authorizations_v3
      WHEN NEW.generation=2 BEGIN
      INSERT INTO device_startup_grants_v3(node_id,revision,enabled,created_at) VALUES(NEW.node_id,2,0,'synthetic');
      UPDATE device_startup_state_v3 SET revision=2 WHERE node_id=NEW.node_id; END`.replaceAll('\n', ' '));
    expect((await request('/api/v3/device/config/ack', await v3Ack(policy))).status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) n FROM device_startup_grants_v3').first()).toMatchObject({ n: 1 });
    expect(await db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').first()).toMatchObject({ n: 1 });
    await db.exec('DROP TRIGGER test_revoke_startup');
    expect((await request('/api/v3/device/config/ack', await v3Ack(policy))).status).toBe(200);
  });
});
