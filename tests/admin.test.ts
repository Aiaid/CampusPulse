import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { sha256 } from '../worker/ingest';
import { seedMqtt } from './helpers/mqtt';
import { DEVICE_TOKEN, fixture, seedConfig, setup } from './helpers/ingestion';

// These tests execute every production migration and actual Worker SQL on a
// separate in-memory SQLite database. A transaction helper rolls back full D1
// batches, so assertions cover audit/registry atomicity rather than SQL mocks.
const ORIGIN = 'https://admin.example.test';
const ADMIN = 'synthetic-independent-admin-token';
const ACCOUNT = { username: 'synthetic-admin', display_name: 'Synthetic admin', password: 'synthetic-admin-password-only-for-tests' };
let state: Awaited<ReturnType<typeof setup>>;
let cookie: string;
const request = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), state.env);
const admin = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => request(`/api/v1/admin${path}`, {
  method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: ORIGIN }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function login() {
  const initialized = Number(state.db.prepare('SELECT COUNT(*) n FROM admin_accounts').get()?.n) > 0;
  let response = await admin('/session', 'POST', initialized ? { username: ACCOUNT.username, password: ACCOUNT.password } : { token: ADMIN });
  expect(response.status).toBe(200);
  cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  if (!initialized) {
    response = await admin('/auth/setup', 'POST', ACCOUNT);
    expect(response.status).toBe(201);
    cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  }
  return response;
}
async function data(response: Response, status = 200): Promise<any> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
async function upload(value: unknown, token = DEVICE_TOKEN) {
  const body = JSON.stringify(value);
  return request('/api/v1/ingest', { method: 'POST', body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(body)) } });
}
async function draft(id = 'admin-config-v2') {
  const config = structuredClone(state.config);
  config.capture_config_id = id;
  return data(await admin('/configs', 'POST', { config, raw_retention_hours: 12, aggregate_retention_days: 14 }), 201);
}
beforeEach(async () => {
  state = await setup();
  await seedMqtt(state,4);
  state.env.ADMIN_TOKEN = ADMIN;
  cookie = '';
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('administrator security boundary', () => {
  it('fails closed when unconfigured and keeps all credentials independent', async () => {
    delete state.env.ADMIN_TOKEN;
    expect((await admin('/session')).status).toBe(503);
    expect((await admin('/devices')).status).toBe(503);
    state.env.ADMIN_TOKEN = state.env.OPERATOR_TOKEN;
    expect((await admin('/session', 'POST', { token: state.env.OPERATOR_TOKEN })).status).toBe(503);
    state.env.ADMIN_TOKEN = ADMIN;
    for (const token of ['wrong', DEVICE_TOKEN, state.env.OPERATOR_TOKEN, state.env.RESEARCH_TOKEN]) {
      expect((await admin('/session', 'POST', { token })).status).toBe(401);
      expect((await admin('/devices', 'GET', undefined, { Authorization: `Bearer ${token}` })).status).toBe(401);
    }
    expect((await upload(fixture('node-status.request'), ADMIN)).status).toBe(401);
    expect((await request('/api/v1/observations', { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` } })).status).toBe(401);
    expect((await request('/api/v1/research/batches/44444444-4444-4444-8444-444444444444?node_id=cp-demo-01', { headers: { Authorization: `Bearer ${ADMIN}` } })).status).toBe(401);
  });

  it('sets bounded secure HttpOnly cookies, rejects tampering, expiry and revoked logout replay', async () => {
    const response = await login();
    const header = response.headers.get('Set-Cookie')!;
    expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Strict'); expect(header).toContain('Secure'); expect(header).toContain('Path=/api/v1/admin');
    expect(await data(await admin('/session'))).toMatchObject({ authenticated: true, role: 'admin' });
    expect((await request('/api/v1/observations', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(401);
    expect((await request('/api/v1/research/batches/44444444-4444-4444-8444-444444444444?node_id=cp-demo-01', { headers: { Cookie: cookie } })).status).toBe(401);
    const valid = cookie;
    const changed = cookie.length - 10;
    cookie = `${cookie.slice(0, changed)}${cookie[changed] === 'a' ? 'b' : 'a'}${cookie.slice(changed + 1)}`;
    expect((await admin('/devices')).status).toBe(401);
    cookie = valid;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 3600_000);
    expect((await admin('/session')).status).toBe(401);
    vi.restoreAllMocks();
    await data(await admin('/session', 'DELETE'));
    expect((await admin('/devices')).status).toBe(401);
    await login();
    state.env.ADMIN_TOKEN = 'synthetic-replacement-admin-token';
    expect((await admin('/session')).status).toBe(401);
  });

  it('requires exact same-origin on login and cookie mutations including absent/null Origin', async () => {
    for (const origin of [undefined, 'null', 'https://untrusted.example', 'https://admin.example.test.attacker.example']) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (origin !== undefined) headers.Origin = origin;
      expect((await request('/api/v1/admin/session', { method: 'POST', headers, body: JSON.stringify({ token: ADMIN }) })).status).toBe(403);
    }
    await login();
    for (const origin of [undefined, 'null', 'https://untrusted.example']) {
      const headers: Record<string, string> = { Cookie: cookie, 'Content-Type': 'application/json' };
      if (origin !== undefined) headers.Origin = origin;
      expect((await request('/api/v1/admin/devices', { method: 'POST', headers, body: JSON.stringify({ id: 'blocked-node', name: 'Blocked', board: 'unknown' }) })).status).toBe(403);
      expect((await request('/api/v1/admin/session', { method: 'DELETE', headers })).status).toBe(403);
    }
    expect((await admin('/devices', 'GET', undefined, { Origin: 'https://untrusted.example' })).status).toBe(403);
    expect(await data(await admin('/devices'))).toMatchObject({ devices: [{ id: state.config.node_id }] });
  });
});

describe('device registry and received health', () => {
  it('reports safe MQTT assignment metadata without claiming device application', async () => {
    await login();
    const readNode = async () => (await data(await admin(`/devices/${state.config.node_id}`))).device;
    expect((await readNode()).mqtt_assignment).toEqual({ state: 'unconfigured', broker_verified: false, namespace: null });
    const [identity] = await seedMqtt(state, 1, state.config.node_id);
    const expected = { state: 'assigned', broker_verified: true, namespace: identity.namespace };
    expect((await readNode()).mqtt_assignment).toEqual(expected);
    const listed = (await data(await admin('/devices'))).devices.find((node: any) => node.id === state.config.node_id);
    expect(listed.mqtt_assignment).toEqual(expected);
    expect(listed.applied_config_id).toBeNull();
    const serialized = JSON.stringify([listed, await readNode()]);
    for (const privateValue of [identity.password_ciphertext, 'synthetic-mqtt-password-only-for-tests', 'password_ciphertext', 'mqtt_password', 'credential_sha256']) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(Object.keys(listed.mqtt_assignment).sort()).toEqual(['broker_verified', 'namespace', 'state']);
    state.db.prepare("UPDATE mqtt_credentials SET state='pending_broker',verified_at=NULL WHERE id=?").run(identity.id);
    expect((await readNode()).mqtt_assignment).toEqual({ state: 'pending_broker', broker_verified: false, namespace: identity.namespace });
  });

  it('shows unknown telemetry as null, returns credentials once, rotates and disables them', async () => {
    await login();
    const created = await data(await admin('/devices', 'POST', { id: 'admin-node', name: 'Synthetic node', board: 'esp32-s3' }), 201);
    const oldToken = created.credential;
    expect(oldToken).toMatch(/^[!-~]{16,256}$/);
    expect(created.device).toMatchObject({ id: 'admin-node', name: 'Synthetic node', enabled: true, last_seen_at: null, latest_status: null, firmware_version: null, contact_state: 'unknown' });
    expect(created.device.mqtt_assignment).toEqual({ state: 'assigned', broker_verified: true, namespace: created.mqtt.namespace });
    expect((await admin('/devices', 'POST', { id: 'admin-node', name: 'Duplicate', board: 'esp32-s3' })).status).toBe(409);
    expect((await request('/api/v1/device/config', { headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(403); // Auth succeeds, no policy yet.
    const mqttBefore = state.db.prepare('SELECT * FROM mqtt_credentials ORDER BY id').all();
    const rotated = await data(await admin('/devices/admin-node/rotate-credential', 'POST', {}));
    expect(state.db.prepare('SELECT * FROM mqtt_credentials ORDER BY id').all()).toEqual(mqttBefore);
    expect((await data(await admin('/devices/admin-node'))).device.mqtt_assignment).toEqual(created.device.mqtt_assignment);
    expect(rotated.credential).not.toBe(oldToken);
    expect((await request('/api/v1/device/config', { headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(401);
    expect((await request('/api/v1/device/config', { headers: { Authorization: `Bearer ${rotated.credential}` } })).status).toBe(403);
    await data(await admin('/devices/admin-node', 'PATCH', { enabled: false, name: 'Renamed' }));
    expect((await request('/api/v1/device/config', { headers: { Authorization: `Bearer ${rotated.credential}` } })).status).toBe(401);
    const reads = JSON.stringify([await data(await admin('/devices')), await data(await admin('/devices/admin-node')), await data(await admin('/audit'))]);
    expect(reads).not.toContain(oldToken); expect(reads).not.toContain(rotated.credential); expect(reads).not.toContain('credential_sha256');
    expect(reads).not.toContain(await sha256(new TextEncoder().encode(rotated.credential)));
  });

  it('chooses latest contact and status by server receipt across reboot/sequence resets', async () => {
    await login();
    const now = Date.now();
    const initial = fixture('node-status.request'); initial.items[0].seq = 900; initial.firmware_version = 'older-boot';
    vi.spyOn(Date, 'now').mockReturnValue(now - 600_000);
    await data(await upload(initial));
    const newer = fixture('node-status.request'); newer.boot_id = crypto.randomUUID(); newer.batch_id = crypto.randomUUID(); newer.firmware_version = 'newer-boot';
    vi.spyOn(Date, 'now').mockReturnValue(now - 1000);
    await data(await upload(newer));
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const node = (await data(await admin('/devices'))).devices.find((v: any) => v.id === state.config.node_id);
    expect(node).toMatchObject({ firmware_version: 'newer-boot', contact_state: 'recent', last_seen_at: new Date(now - 1000).toISOString(), latest_status: { boot_id: newer.boot_id, item: { seq: 1, buffer_health: { time_to_full_s: null, growth_state: 'unknown' } } } });
    expect(await data(await admin('/overview'))).toMatchObject({ devices_total: 1, devices_recent: 1, devices_unknown: 0 });
  });
});

describe('immutable provenance and editable versioned policy', () => {
  it('rejects future and closed placements without publishing, and rolls back a placement closure racing publication', async () => {
    await login();
    const now = Date.now();
    state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
      .run(state.config.placement_id, state.config.node_id, now - 1000, new Date(now).toISOString());
    const closed = (await draft('closed-placement-policy')).draft;
    expect((await admin(`/configs/${closed.id}/validate`, 'POST', { revision: closed.revision })).status).toBe(422);
    expect((await admin(`/configs/${closed.id}/publish`, 'POST', { revision: closed.revision })).status).toBe(422);
    await data(await admin(`/devices/${state.config.node_id}/placements`, 'POST', { id: 'future-placement', place_id: 'library', valid_from_ms: now + 60_000, valid_until_ms: null }), 201);
    const futureConfig = { ...structuredClone(state.config), capture_config_id: 'future-placement-policy', placement_id: 'future-placement' };
    const future = (await data(await admin('/configs', 'POST', { config: futureConfig }), 201)).draft;
    expect((await admin(`/configs/${future.id}/publish`, 'POST', { revision: future.revision })).status).toBe(422);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_desired_configs').get()?.n).toBe(0);

    // A separate writer changes placement state after HTTP validation but before
    // the publishing transaction executes. The transaction must recheck it.
    await data(await admin('/devices', 'POST', { id: 'racing-node', name: 'Concurrent QA', board: 'unknown' }), 201);
    state.db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)').run('racing-placement', 'racing-node', 'library');
    const racingConfig = { ...structuredClone(state.config), capture_config_id: 'racing-policy', node_id: 'racing-node', placement_id: 'racing-placement' };
    const racing = (await data(await admin('/configs', 'POST', { config: racingConfig }), 201)).draft;
    const actualBatch = state.env.DB.batch.bind(state.env.DB);
    state.env.DB.batch = (async statements => {
      state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
        .run('racing-placement', 'racing-node', Date.now() - 1, new Date().toISOString());
      state.env.DB.batch = actualBatch;
      return actualBatch(statements);
    }) as D1Database['batch'];
    expect((await admin(`/configs/${racing.id}/publish`, 'POST', { revision: racing.revision })).status).toBe(409);
    expect(state.db.prepare('SELECT published_at FROM config_drafts WHERE id=?').get(racing.id)?.published_at).toBeNull();
    expect(state.db.prepare('SELECT COUNT(*) n FROM capture_configs WHERE id=?').get(racing.id)?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM config_assignments').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_desired_configs').get()?.n).toBe(0);
    expect((await data(await admin('/audit'))).entries.some((entry: any) => entry.action === 'config.publish')).toBe(false);
  });

  it('refuses invalid identity policies, foreign placements and unavailable raw publication without assigning a version', async () => {
    await login();
    const bad = { ...structuredClone(state.config), capture_config_id: 'invalid-identity', identity_scheme: 'invented_scheme' };
    expect((await admin('/configs', 'POST', { config: bad })).status).toBe(422);
    const config = structuredClone(state.config); config.capture_config_id = 'missing-placement'; config.placement_id = 'not-owned';
    const created = (await data(await admin('/configs', 'POST', { config }), 201)).draft;
    expect((await admin(`/configs/${created.id}/publish`, 'POST', { revision: created.revision })).status).toBe(422);
    const raw = (await draft('raw-unavailable')).draft;
    delete state.env.RAW_BUCKET;
    expect((await admin(`/configs/${raw.id}/publish`, 'POST', { revision: raw.revision })).status).toBe(503);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_desired_configs').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM capture_configs WHERE id IN (?,?)').get(created.id, raw.id)?.n).toBe(0);
    expect((await data(await admin('/configs'))).drafts).toHaveLength(2);
    expect((await data(await admin('/audit'))).entries.some((entry: any) => entry.action === 'config.publish')).toBe(false);
  });

  it('edits drafts with optimistic revisions, publishes once, and selects desired policy explicitly', async () => {
    await login();
    const created = (await draft()).draft;
    expect((await admin(`/configs/${created.id}`, 'PUT', { config: created.config, raw_retention_hours: null, revision: created.revision })).status).toBe(422);
    const edit = { ...created.config, scan: { ...created.config.scan, window_ms: 70 } };
    const updates = await Promise.all([admin(`/configs/${edit.capture_config_id}`, 'PUT', { config: edit, raw_retention_hours: 13, aggregate_retention_days: 15, revision: created.revision }), admin(`/configs/${edit.capture_config_id}`, 'PUT', { config: edit, raw_retention_hours: 14, aggregate_retention_days: 16, revision: created.revision })]);
    expect(updates.map(v => v.status).sort()).toEqual([200, 409]);
    const updated = (await data(updates.find(v => v.status === 200)!)).draft;
    expect(updated.revision).toBe(created.revision + 1);
    expect((await admin(`/configs/${edit.capture_config_id}/publish`, 'POST', { revision: created.revision })).status).toBe(409);
    const published = await data(await admin(`/configs/${edit.capture_config_id}/publish`, 'POST', { revision: updated.revision }));
    expect(published.desired_config_id).toBe(edit.capture_config_id);
    expect((await admin(`/configs/${edit.capture_config_id}/publish`, 'POST', { revision: updated.revision })).status).toBe(409);
    expect((await admin(`/configs/${edit.capture_config_id}`, 'PUT', { config: edit, raw_retention_hours: 13, aggregate_retention_days: 15, revision: updated.revision })).status).toBe(409);
    const selected = await data(await request('/api/v1/device/config', { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } }));
    expect(selected.config.capture_config_id).toBe(edit.capture_config_id);
    const historical = await data(await request(`/api/v1/device/config?capture_config_id=${state.config.capture_config_id}`, { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } }));
    expect(historical.config).toEqual(state.config);
    expect((await upload(fixture('ble-windows.request'))).status).toBe(200);
    expect((await admin(`/devices/${state.config.node_id}`)).status).toBe(200);
    expect(() => state.db.prepare('UPDATE capture_configs SET raw_retention_hours=48 WHERE id=?').run(state.config.capture_config_id)).toThrow();
  });

  it('distinguishes batch association from authenticated activation and rejects foreign or unassigned ACKs', async () => {
    await login();
    const created = (await draft()).draft;
    await data(await admin(`/configs/${created.id}/publish`, 'POST', { revision: created.revision }));
    const ack = (id: string, token = DEVICE_TOKEN, activation = 'applied') => request('/api/v1/device/config/ack', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ capture_config_id: id, state: activation }) });
    expect((await ack(created.id, ADMIN)).status).toBe(401);
    expect((await ack('unknown')).status).toBe(403);
    expect((await ack(state.config.capture_config_id)).status).toBe(403);
    expect((await request('/api/v1/device/config/ack', { method: 'POST', headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ capture_config_id: created.id, state: 'applied' }) })).status).toBe(403);
    expect((await request('/api/v1/device/config/ack', { method: 'POST', headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ capture_config_id: created.id, state: 'applied', message: 'arbitrary private free text' }) })).status).toBe(422);
    expect((await request('/api/v1/device/config/ack', { method: 'POST', headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ capture_config_id: created.id, state: ['applied'] }) })).status).toBe(422);
    const batch = fixture('node-status.request'); batch.capture_config_id = created.id;
    await data(await upload(batch));
    expect((await data(await admin(`/devices/${state.config.node_id}`))).device.config_state).toBe('reported');
    await data(await ack(created.id));
    expect((await data(await admin(`/devices/${state.config.node_id}`))).device.config_state).toBe('applied');
    await data(await ack(created.id)); // Repeated delivery is safe.
    await data(await ack(created.id, DEVICE_TOKEN, 'failed'));
    expect((await data(await admin(`/devices/${state.config.node_id}`))).device.config_state).toBe('failed');
    await data(await admin('/devices', 'POST', { id: 'foreign-node', name: 'Foreign', board: 'unknown' }), 201);
    const foreignConfig = structuredClone(state.config); foreignConfig.node_id = 'foreign-node'; foreignConfig.capture_config_id = 'foreign-policy'; foreignConfig.placement_id = 'foreign-placement';
    state.db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)').run(foreignConfig.placement_id, foreignConfig.node_id, 'library'); seedConfig(state.db, foreignConfig);
    expect((await ack(foreignConfig.capture_config_id)).status).toBe(403);
  });

  it('closes open placements atomically, preserves old receipt provenance and rejects overlaps', async () => {
    await login();
    const original = fixture('ble-windows.request'); await data(await upload(original));
    const from = Date.now();
    const response = await data(await admin(`/devices/${state.config.node_id}/placements`, 'POST', { id: 'new-placement', place_id: 'east-parking', valid_from_ms: from, valid_until_ms: null }), 201);
    expect(response.placement).toMatchObject({ id: 'new-placement', place_id: 'east-parking' });
    expect(state.db.prepare('SELECT placement_id,capture_config_id FROM ingestion_batches WHERE batch_id=?').get(original.batch_id)).toMatchObject({ placement_id: state.config.placement_id, capture_config_id: state.config.capture_config_id });
    expect(state.db.prepare('SELECT valid_until_ms FROM placements WHERE id=?').get(state.config.placement_id)?.valid_until_ms).toBeNull();
    expect(state.db.prepare('SELECT valid_until_ms FROM placement_closures WHERE placement_id=?').get(state.config.placement_id)?.valid_until_ms).toBe(from);
    expect((await admin(`/devices/${state.config.node_id}/placements`, 'POST', { id: 'overlap', place_id: 'library', valid_from_ms: from - 1, valid_until_ms: from + 1 })).status).toBe(409);
    expect(state.db.prepare("SELECT COUNT(*) n FROM placements WHERE id='overlap'").get()?.n).toBe(0);
    const list = await data(await admin(`/devices/${state.config.node_id}`));
    expect(list.placements).toEqual(expect.arrayContaining([expect.objectContaining({ id: state.config.placement_id, effective_valid_until_ms: from })]));
    expect((await upload(original)).status).toBe(200); // queued exact retry survives relocation.
    const second = fixture('node-status.request'); second.batch_id = crypto.randomUUID();
    expect((await upload(second)).status).toBe(200); // explicit old policy remains valid for queued records.
  });

  it('preserves historical manual evidence when changing enabled place purposes', async () => {
    await login();
    const observed_at = new Date().toISOString();
    await data(await request('/api/v1/observations', { method: 'POST', headers: { Authorization: 'Bearer synthetic-operator-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), place_id: 'east-parking', kind: 'parking', observed_at, parking_min: 1, parking_max: 2 }) }), 201);
    await data(await admin('/places/east-parking', 'PATCH', { name: 'Corrected name', anchor: { x: 0.5, y: 0.5 } }));
    await data(await admin('/places/east-parking', 'PATCH', { kind: 'elevator' }));
    expect((await data(await request('/api/v1/places'))).places.find((p: any) => p.id === 'east-parking')).toMatchObject({ kind: 'elevator', observation_kinds: ['elevator'], name: 'Corrected name' });
    expect(state.db.prepare('SELECT kind FROM observations WHERE place_id=?').get('east-parking')?.kind).toBe('parking');
  });
});

describe('settings revisions and audit durability', () => {
  it('rejects malformed inputs before writes and paginates audit entries without duplicates or private fields', async () => {
    await login();
    const before = Number(state.db.prepare('SELECT COUNT(*) n FROM admin_audit').get()?.n);
    expect((await admin('/devices', 'POST', { id: 'bad/node', name: 'Bad', board: 'unknown' })).status).toBe(422);
    expect((await admin('/devices', 'POST', { id: 'extra-node', name: 'Extra', board: 'unknown', credential: 'injected-credential' })).status).toBe(422);
    expect((await admin('/places', 'POST', { id: 'bad-place', name: 'Bad', kind: 'activity', anchor: { x: 1.1, y: 0.5 } })).status).toBe(422);
    expect((await admin('/places', 'POST', { id: 'bad-gis', name: 'Bad', kind: 'activity', anchor: { x: 0.5, y: 0.5 }, gis_anchor: { x: 0.5, y: 0.5, verified: false } })).status).toBe(422);
    const original = await data(await admin('/settings'));
    expect((await admin('/settings', 'PUT', { settings: { ...original.settings, default_mode: 'production' }, revision: original.revision })).status).toBe(422);
    expect((await admin('/settings', 'PUT', { settings: { ...original.settings, default_mode: ['field'] }, revision: original.revision })).status).toBe(422);
    expect((await admin('/settings', 'PUT', { settings: { ...original.settings, stale_after_seconds: 0 }, revision: original.revision })).status).toBe(422);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_audit').get()?.n).toBe(before);
    // Create enough real mutations to traverse the bounded cursor boundary.
    for (let i = 0; i < 104; i++) await data(await admin(`/devices/${state.config.node_id}`, 'PATCH', { name: `Synthetic ${i}` }));
    const first = await data(await admin('/audit'));
    expect(first.entries).toHaveLength(100); expect(first.next_cursor).toBeTruthy();
    const next = await data(await admin(`/audit?before=${encodeURIComponent(first.next_cursor)}`));
    expect(next.entries.length).toBeGreaterThan(0); expect(next.next_cursor).toBeNull();
    const ids = [...first.entries, ...next.entries].map((entry: any) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(JSON.stringify([first, next])).not.toMatch(/credential_sha256|token_sha256|payload_hex|synthetic-independent-admin-token/);
    expect((await admin('/audit?before=1%20OR%201=1')).status).toBe(422);
  });

  it('resolves concurrent changes once, exposes only public settings and applies TTL to new records', async () => {
    await login();
    const original = await data(await admin('/settings'));
    const observed_at = new Date().toISOString();
    const manual = (id: string) => request('/api/v1/observations', { method: 'POST', headers: { Authorization: 'Bearer synthetic-operator-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ id, place_id: 'east-parking', kind: 'parking', observed_at, parking_min: 0, parking_max: 1 }) });
    const firstId = crypto.randomUUID(); const old = await data(await manual(firstId), 201);
    const settings = { ...original.settings, site_name: 'Synthetic QA campus', default_mode: 'field', stale_after_seconds: 30, observation_ttl_minutes: 2, default_raw_retention_hours: 9, default_aggregate_retention_days: 10 };
    const results = await Promise.all([admin('/settings', 'PUT', { settings, revision: original.revision }), admin('/settings', 'PUT', { settings: { ...settings, site_name: 'Other' }, revision: original.revision })]);
    expect(results.map(v => v.status).sort()).toEqual([200, 409]);
    const stored = await data(await admin('/settings')); expect(stored.revision).toBe(original.revision + 1);
    expect(await data(await request('/api/v1/settings'))).toEqual({ site_name: stored.settings.site_name, default_mode: 'field' });
    expect((await data(await manual(firstId))).observation.valid_until).toBe(old.observation.valid_until);
    const next = await data(await manual(crypto.randomUUID()), 201);
    expect(Date.parse(next.observation.valid_until) - Date.parse(observed_at)).toBe(120000);
    expect(state.db.prepare('SELECT valid_until FROM observations WHERE id=?').get(firstId)?.valid_until).toBe(old.observation.valid_until);
    const config = structuredClone(state.config); config.capture_config_id = 'default-retention';
    const created = await data(await admin('/configs', 'POST', { config }), 201);
    expect(created.draft).toMatchObject({ raw_retention_hours: 9, aggregate_retention_days: 10 });
    const status = fixture('node-status.request');
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now - 31000); await data(await upload(status)); vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await data(await admin('/devices'))).devices[0].contact_state).toBe('stale');
  });

  it('fails all registry changes when audit insertion fails', async () => {
    await login();
    // The injected database failure occurs after the registry INSERT in the same
    // batch. A failed response must not leave an unaudited, usable node.
    state.db.exec("CREATE TRIGGER synthetic_admin_audit_outage BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'synthetic_audit_failure'); END");
    expect((await admin('/devices', 'POST', { id: 'unaudited-node', name: 'Must roll back', board: 'unknown' })).status).toBe(503);
    expect(state.db.prepare("SELECT COUNT(*) n FROM device_nodes WHERE id='unaudited-node'").get()?.n).toBe(0);
    state.db.exec('DROP TRIGGER synthetic_admin_audit_outage');
    const created = (await draft('publication-rollback')).draft;
    const settings = await data(await admin('/settings'));
    state.db.exec("CREATE TRIGGER synthetic_admin_audit_outage BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'synthetic_audit_failure'); END");
    expect((await admin(`/configs/${created.id}/publish`, 'POST', { revision: created.revision })).status).toBe(503);
    expect(state.db.prepare('SELECT published_at FROM config_drafts WHERE id=?').get(created.id)?.published_at).toBeNull();
    expect(state.db.prepare('SELECT COUNT(*) n FROM capture_configs WHERE id=?').get(created.id)?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM config_assignments').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_desired_configs').get()?.n).toBe(0);
    expect((await admin('/settings', 'PUT', { settings: { ...settings.settings, site_name: 'Must roll back' }, revision: settings.revision })).status).toBe(503);
    expect(await data(await admin('/settings'))).toEqual(settings);
  });
});
