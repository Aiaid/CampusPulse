import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createAdminSession } from '../worker/admin-auth';
import { sha256 } from '../worker/http';
import { v3Ack, v3Capabilities, v3Policy, v3Registration } from './helpers/device-v3-fixtures';
let mf: Miniflare, cookie: string;
const ORIGIN = 'https://synthetic-v3.example.test', token = 'synthetic-v3-workerd-device-token', secret = 'synthetic-v3-workerd-admin-secret';
const caps = v3Capabilities('synthetic-node');
let policy: Awaited<ReturnType<typeof v3Policy>>;
async function request(path: string, body?: unknown, admin = false) {
  return mf.dispatchFetch(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(admin ? { Cookie: cookie, Origin: ORIGIN } : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['tests/helpers/device-v3-workerd.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'device-v3-control-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { DEVICE_V3_CONTROL_ENABLED: 'true', ADMIN_TOKEN: secret }, log: new Log(LogLevel.ERROR) }));
  const db = await mf.getD1Database('DB');
  // All migrations are exercised together; this is an isolated local database.
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  }
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(caps.node_id, await sha256(new TextEncoder().encode(token))).run();
  const now = new Date().toISOString(), session = await createAdminSession(secret);
  await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('synthetic-admin', 'synthetic-admin', 'Synthetic administrator', 'unused-test-hash', 'synthetic-user-handle', now, now).run();
  await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','synthetic-admin',1)")
    .bind(session.hash, now, session.expires).run();
  cookie = `cp_admin_session=${session.value}`; policy = await v3Policy(caps);
}, 30_000);
afterAll(async () => { await mf?.dispose(); });

describe.sequential('v3 control in real local workerd and D1', () => {
  it('commits immutable registration/assignment/ACK retries through actual D1 batches', async () => {
    const registrations = await Promise.all([request('/api/v3/device/capabilities', v3Registration(caps)), request('/api/v3/device/capabilities', v3Registration(caps))]);
    expect(registrations.map(r => r.status)).toEqual([200, 200]); expect(await registrations[0].json()).toEqual(await registrations[1].json());
    const assignments = await Promise.all([request('/api/v1/admin/device-v3/assignments', { policy, expected_generation: 0 }, true), request('/api/v1/admin/device-v3/assignments', { policy, expected_generation: 0 }, true)]);
    expect(assignments.map(r => r.status)).toEqual([200, 200]); expect(await assignments[0].json()).toEqual(await assignments[1].json());
    const pending = await request('/api/v1/admin/device-v3/nodes/synthetic-node', undefined, true);
    expect(await pending.json()).toMatchObject({ state: 'pending', applied_generation: null });
    const config = await request('/api/v3/device/config?boot_id=' + caps.boot_id); expect(await config.json()).toMatchObject({ config: { policy }, applied_generation: null });
    const ack = await v3Ack(policy), acks = await Promise.all([request('/api/v3/device/config/ack', ack), request('/api/v3/device/config/ack', ack)]);
    expect(acks.map(r => r.status)).toEqual([200, 200]); expect(await acks[0].json()).toEqual(await acks[1].json());
    const db = await mf.getD1Database('DB');
    expect(await db.prepare('SELECT applied_generation,apply_seq FROM device_control_v3').first()).toMatchObject({ applied_generation: 1, apply_seq: 1 });
    expect(await db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').first()).toMatchObject({ n: 1 });
    expect(await db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').first()).toMatchObject({ n: 0 });
  });
  it('rejects conflicting terminal ACKs and disabled-device retries', async () => {
    const ack = await v3Ack(policy);
    expect((await request('/api/v3/device/config/ack', { ...ack, state: 'failed', error_code: 'storage_failed' })).status).toBe(409);
    const db = await mf.getD1Database('DB'); await db.prepare('UPDATE device_nodes SET enabled=0 WHERE id=?').bind(caps.node_id).run();
    expect((await request('/api/v3/device/config/ack', ack)).status).toBe(401);
    expect((await request('/api/v3/device/config?boot_id=' + caps.boot_id)).status).toBe(401);
    expect(await db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').first()).toMatchObject({ n: 1 });
  });
});
