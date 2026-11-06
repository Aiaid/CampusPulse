import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { authState, Client, json, ORIGIN } from './admin-auth-helpers';
import { validateReplayImport } from '../worker/admin-replays';
import { createAdminSession } from '../worker/admin-auth';

function payload(id = 'historical-synthetic') {
  const item = (duration: number) => ({ d: duration, b: 5000, c: [0, 0, 0, 0, 1, 0], r: [1, 1, 1, 0],
    x: Array.from({ length: Math.ceil(duration / 5000) }, (_, i) => i ? [0, 0, 0, 0] : [1, 1, 1, -60]),
    s: [1, -60, -60, -60], l: [0, 0, 0, 0], f: duration === 60000 ? 4 : 5, v: ['cp-v3-stats/1', 'unclassified-v1'] });
  return { schema: 'campuspulse-replay-import/1', id, label: 'Synthetic historical aggregate test', place_id: 'library' as string | null,
    window_ms: 60000, bin_ms: 5000, source: { sha256: ['a'.repeat(64)], total_reports: 2, replayed_reports: 2,
      time_semantics: 'historical_capture', clock_anchors: [{ mono_us: 1000000, utc_epoch_seconds: 1700000000, uncertainty_us: 1100, source: 2 }] },
    windows: [{ source_start_mono_us: 1000000, source_end_mono_us: 61000000, item: item(60000) },
      { source_start_mono_us: 61000000, source_end_mono_us: 62339000, item: item(1339) }] };
}

let state: Awaited<ReturnType<typeof authState>>, client: Client;
describe('private historical aggregate replay administrator API', () => {
  beforeEach(async () => { state = await authState(); client = new Client(state); await client.initialize(); });
  afterEach(() => { vi.restoreAllMocks(); state.db.close(); });
  it('stores immutable normalized history, exact retries, provenance and original historical clock only', async () => {
    const p = payload(), old = state.db.prepare('SELECT * FROM capture_configs').all();
    const response = await client.call('/replays', 'POST', p), first = await json(response, 201);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(first).toMatchObject({ schema: 'campuspulse-replay-view/1', dataset: 'controlled_test', source: 'historical_cpraw',
      id: p.id, place_id: 'library', source_metadata: p.source });
    expect(first.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.windows[0].item).toMatchObject({ seq: 1, window_seq: 1, time: { mono_ms: 61000, utc_ms: 1700000060000, uncertainty_ms: 2 },
      visible_identifiers: 1, estimated_total: null, reports: { worker: 1 }, quality_mask: 6 });
    expect(first.windows[1].item).toMatchObject({ duration_ms: 1339, quality_mask: 7 });
    expect(await json(await client.call('/replays', 'POST', p))).toEqual(first);
    expect(await json(await client.call('/replays/' + p.id))).toEqual(first);
    expect(state.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='replay.import'").get()?.n).toBe(1);
    expect(state.db.prepare('SELECT * FROM capture_configs').all()).toEqual(old);
    for (const table of ['statistics_windows_v3', 'statistics_batches_v3', 'device_assignments_v3', 'device_statistics_authorizations_v3'])
      expect(state.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n).toBe(0);
    expect(() => state.db.prepare('UPDATE controlled_replays SET imported_at=?').run('changed')).toThrow(/immutable/);
    expect(() => state.db.exec('DELETE FROM controlled_replays')).toThrow(/immutable/);
  });
  it('rejects differing content for an existing immutable ID', async () => {
    const p = payload(); await json(await client.call('/replays', 'POST', p), 201);
    expect((await client.call('/replays', 'POST', { ...p, label: 'Different content' })).status).toBe(409);
    expect((await json(await client.call('/replays/' + p.id))).label).toBe(p.label);
  });
  it('keeps unknown historical clock unknown and display anchor optional', async () => {
    const p = payload(); p.source.clock_anchors = []; p.place_id = null;
    const result = await json(await client.call('/replays', 'POST', p), 201);
    expect(result.windows[0].item.time).toMatchObject({ mono_ms: 61000, utc_ms: null, uncertainty_ms: null });
    expect(result.place_id).toBeNull();
  });
  it('requires a full administrator cookie and same-origin mutation; bearer/public replay paths stay inaccessible', async () => {
    const anonymous = new Client(state);
    expect((await anonymous.call('/replays', 'POST', payload(), { Authorization: 'Bearer synthetic-research-token' })).status).toBe(401);
    expect((await anonymous.call('/replays/historical-synthetic')).status).toBe(401);
    expect((await client.call('/replays', 'POST', payload(), { Origin: 'https://other.example.test' })).status).toBe(403);
    expect((await client.call('/replays/historical-synthetic')).status).toBe(404);
    await client.call('/session', 'DELETE');
    expect((await client.call('/replays/historical-synthetic')).status).toBe(401);
  });
  it('rechecks session authority atomically after body/validation awaits and rolls back an unavailable audit', async () => {
    const batch = state.env.DB.batch.bind(state.env.DB);
    vi.spyOn(state.env.DB, 'batch').mockImplementation(async statements => { state.db.exec('DELETE FROM admin_sessions'); return batch(statements); });
    expect((await client.call('/replays', 'POST', payload())).status).toBe(409);
    expect(state.db.prepare('SELECT COUNT(*) n FROM controlled_replays').get()?.n).toBe(0);
    vi.restoreAllMocks(); await client.login();
    state.db.exec("CREATE TRIGGER test_replay_audit_failure BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_outage'); END");
    expect((await client.call('/replays', 'POST', payload())).status).toBe(503);
    expect(state.db.prepare('SELECT COUNT(*) n FROM controlled_replays').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').get()?.n).toBe(0);
  });
  it('bounds the request before parsing and rejects duplicate decoded JSON keys', async () => {
    expect((await client.call('/replays', 'POST', { padding: 'x'.repeat(262144) })).status).toBe(413);
    const headers = { Origin: ORIGIN, Cookie: `cp_admin_session=${client.cookies.get('cp_admin_session')}`, 'Content-Type': 'application/json' };
    const { handleAdmin } = await import('../worker/admin');
    const request = new Request(ORIGIN + '/api/v1/admin/replays', { method: 'POST', headers, body: '{"id":"one","\\u0069d":"two"}' });
    expect((await handleAdmin(request, state.env))?.status).toBe(400);
  });
  it('guards private GET and exact-retry reads against revocation after the initial authentication', async () => {
    const p = payload(); await json(await client.call('/replays', 'POST', p), 201);
    for (const method of ['GET', 'POST']) {
      const prepare = state.env.DB.prepare.bind(state.env.DB);
      vi.spyOn(state.env.DB, 'prepare').mockImplementation(sql => {
        if (sql.startsWith('SELECT r.body_sha256')) state.db.exec('DELETE FROM admin_sessions');
        return prepare(sql);
      });
      expect((await client.call(method === 'GET' ? '/replays/' + p.id : '/replays', method, method === 'POST' ? p : undefined)).status).toBe(401);
      vi.restoreAllMocks(); await client.login();
    }
    expect(state.db.prepare('SELECT COUNT(*) n FROM controlled_replays').get()?.n).toBe(1);
  });
  it('rejects unknown query strings and unsupported methods without creating data', async () => {
    expect((await client.call('/replays?raw=1', 'POST', payload())).status).toBe(422);
    expect((await client.call('/replays')).status).toBe(405);
    expect((await client.call('/replays/synthetic', 'POST', {})).status).toBe(405);
    expect(state.db.prepare('SELECT COUNT(*) n FROM controlled_replays').get()?.n).toBe(0);
  });
});

describe('historical import strict accounting and nested raw-data exclusion', () => {
  it.each([
    ['extra root/raw', (p: any) => { p.raw = 'forbidden'; }],
    ['extra source', (p: any) => { p.source.address = 'forbidden'; }],
    ['extra window', (p: any) => { p.windows[0].payload = 'forbidden'; }],
    ['extra compact item', (p: any) => { p.windows[0].item.address = 'forbidden'; }],
    ['extra anchor', (p: any) => { p.source.clock_anchors[0].path = 'forbidden'; }],
    ['incomplete source', (p: any) => { p.source.total_reports++; }],
    ['wrong report accounting', (p: any) => { p.source.total_reports = p.source.replayed_reports = 3; }],
    ['noncontiguous time', (p: any) => { p.windows[1].source_start_mono_us++; }],
    ['wrong duration', (p: any) => { p.windows[1].item.d++; }],
    ['missing partial flag', (p: any) => { p.windows[1].item.f = 4; }],
    ['invalid RSSI', (p: any) => { p.windows[0].item.s[1] = -200; }],
    ['unknown extractor', (p: any) => { p.windows[0].item.v[0] = 'future-extractor'; }],
    ['too many windows', (p: any) => { p.windows = Array(121).fill(p.windows[0]); }],
    ['forged field dataset', (p: any) => { p.dataset = 'field'; }],
  ])('rejects %s', (_name, change) => { const p = payload(); change(p); expect(() => validateReplayImport(p)).toThrow(); });
});

let mf: Miniflare, db: Awaited<ReturnType<Miniflare['getD1Database']>>, cookie: string;
describe.sequential('historical replay in real workerd D1 transactions', () => {
  beforeAll(async () => {
    const bundle = await build({ entryPoints: ['tests/helpers/admin-replays-workerd.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], external: ['node:*', 'cloudflare:*'], target: 'es2022' });
    const secret = 'synthetic-replay-workerd-admin';
    mf = new Miniflare(convertV4MiniflareOptions({ name: 'admin-replay-test', modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { ADMIN_TOKEN: secret }, log: new Log(LogLevel.ERROR) }));
    db = await mf.getD1Database('DB');
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort())
      await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
    const now = new Date().toISOString(), session = await createAdminSession(secret);
    await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind('synthetic-replay-admin', 'synthetic-replay-admin', 'Synthetic administrator', 'unused-test-hash', 'synthetic-replay-user', now, now).run();
    await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','synthetic-replay-admin',1)")
      .bind(session.hash, now, session.expires).run();
    cookie = `cp_admin_session=${session.value}`;
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });
  const request = (p: ReturnType<typeof payload>) => mf.dispatchFetch(ORIGIN + '/api/v1/admin/replays', { method: 'POST',
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  it('conserves immutable snapshots under concurrent exact retries and conflicting imports', async () => {
    const p = payload('workerd-replay');
    const responses = await Promise.all([request(p), request(p)]), bodies = await Promise.all(responses.map(r => r.json()));
    expect(responses.every(r => r.status === 200 || r.status === 201), JSON.stringify(bodies)).toBe(true);
    expect(bodies[0]).toEqual(bodies[1]);
    const a = payload('workerd-race'), b = { ...a, label: 'Conflicting concurrent snapshot' };
    expect((await Promise.all([request(a), request(b)])).map(r => r.status).sort()).toEqual([201, 409]);
    expect(await db.prepare('SELECT COUNT(*) n FROM controlled_replays').first()).toMatchObject({ n: 2 });
    expect(await db.prepare('SELECT COUNT(*) n FROM statistics_windows_v3').first()).toMatchObject({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').first()).toMatchObject({ n: 0 });
  });
});
