import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createAdminSession } from '../worker/admin-auth';
import { sha256 } from '../worker/http';
import { v3Ack, v3Registration } from './helpers/device-v3-fixtures';
import { statisticsCapabilities, statisticsPolicy } from './helpers/v3-statistics-policy-fixtures';
let mf: Miniflare, cookie: string, db: Awaited<ReturnType<Miniflare['getD1Database']>>;
const ORIGIN = 'https://synthetic-statistics.example.test', token = 'synthetic-statistics-workerd-token', secret = 'synthetic-statistics-workerd-admin';
const caps = statisticsCapabilities('synthetic-stats-workerd');
let policy: Awaited<ReturnType<typeof statisticsPolicy>>, contact: Record<string, unknown>;
async function request(path: string, body?: unknown, admin = false) {
  return mf.dispatchFetch(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(admin ? { Cookie: cookie, Origin: ORIGIN } : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['tests/helpers/device-v3-workerd.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'statistics-control-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true',
      DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1"]', ADMIN_TOKEN: secret }, log: new Log(LogLevel.ERROR) }));
  db = await mf.getD1Database('DB');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  }
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(caps.node_id, await sha256(new TextEncoder().encode(token))).run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)').bind('synthetic-stats-place', caps.node_id, 'library', 0).run();
  const now = new Date().toISOString(), session = await createAdminSession(secret);
  await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('synthetic-admin', 'synthetic-admin', 'Synthetic administrator', 'unused-test-hash', 'synthetic-user-handle', now, now).run();
  await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','synthetic-admin',1)")
    .bind(session.hash, now, session.expires).run();
  cookie = `cp_admin_session=${session.value}`; policy = await statisticsPolicy(caps, 'synthetic-stats-place');
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe.sequential('statistics control in real workerd D1 transactions', () => {
  it('atomically commits one initial span under concurrent applied ACK retries', async () => {
    expect((await request('/api/v3/device/capabilities', v3Registration(caps))).status).toBe(200);
    expect((await request('/api/v1/admin/device-v3/assignments', { policy, expected_generation: 0 }, true)).status).toBe(200);
    const ack = await v3Ack(policy);
    const responses = await Promise.all([request('/api/v3/device/config/ack', ack), request('/api/v3/device/config/ack', ack)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(await db.prepare('SELECT COUNT(*) n FROM device_statistics_lease_spans_v3').first()).toMatchObject({ n: 1 });
    contact = { protocol: 'campuspulse/3', boot_id: caps.boot_id, policy_id: policy.policy_id, policy_sha256: ack.policy_sha256,
      assignment_generation: 1, contact_seq: 1, uptime_ms: 2000 };
  });
  it('uses one committed lease receipt for concurrent exact renewal and does not renew on GET', async () => {
    const responses = await Promise.all([request('/api/v3/device/lease', contact), request('/api/v3/device/lease', contact)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    const receipt = await responses[0].json(); expect(receipt).toEqual(await responses[1].json());
    expect(receipt).toMatchObject({ contiguous: true, span_seq: 1, contact_seq: 1, durability: 'committed' });
    const before = await db.prepare('SELECT * FROM device_statistics_authorizations_v3').first();
    expect((await request('/api/v3/device/config?boot_id=' + caps.boot_id)).status).toBe(200);
    expect(await db.prepare('SELECT * FROM device_statistics_authorizations_v3').first()).toEqual(before);
    expect(await db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').first()).toMatchObject({ n: 0 });
  });
  it('records a distinct span after an expired lease and preserves original accept_until', async () => {
    const now = Date.now();
    await db.prepare('UPDATE device_statistics_lease_spans_v3 SET start_ms=?,end_ms=?').bind(now - 10000, now - 1000).run();
    await db.prepare('UPDATE device_statistics_authorizations_v3 SET lease_until_ms=?,state_version=state_version+1').bind(now - 1000).run();
    const response = await request('/api/v3/device/lease', { ...contact, contact_seq: 2, uptime_ms: 3000 });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ contiguous: false, span_seq: 2, contact_seq: 2 });
    const spans = (await db.prepare('SELECT start_ms,end_ms FROM device_statistics_lease_spans_v3 ORDER BY span_seq').all<{ start_ms: number; end_ms: number }>()).results;
    expect(spans).toHaveLength(2); expect(spans[0].end_ms).toBeLessThan(spans[1].start_ms);
    expect(await db.prepare('SELECT accept_until_ms FROM device_statistics_authorizations_v3').first()).toMatchObject({ accept_until_ms: Date.parse(policy.custody.accept_until) });
  });
  it('disallows renewal after reboot while preserving bounded historical grant rows', async () => {
    await db.exec('CREATE TRIGGER test_revoke_lease AFTER UPDATE OF contact_seq ON device_statistics_authorizations_v3 BEGIN UPDATE device_nodes SET enabled=0; END');
    expect((await request('/api/v3/device/lease', { ...contact, contact_seq: 3, uptime_ms: 4000 })).status).toBe(409);
    expect(await db.prepare('SELECT enabled FROM device_nodes').first()).toMatchObject({ enabled: 1 });
    expect(await db.prepare('SELECT contact_seq FROM device_statistics_authorizations_v3').first()).toMatchObject({ contact_seq: 2 });
    await db.exec('DROP TRIGGER test_revoke_lease');
    const next = { ...caps, boot_id: crypto.randomUUID(), capability_id: 'next-statistics-boot' };
    expect((await request('/api/v3/device/capabilities', v3Registration(next, 1, 0))).status).toBe(200);
    expect((await request('/api/v3/device/lease', { ...contact, contact_seq: 3, uptime_ms: 4000 })).status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) n FROM device_statistics_lease_spans_v3').first()).toMatchObject({ n: 2 });
    expect(await db.prepare('SELECT COUNT(*) n FROM device_statistics_authorizations_v3').first()).toMatchObject({ n: 1 });
  });
});
