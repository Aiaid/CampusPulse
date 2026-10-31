import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { authState, Client, json, ORIGIN } from './admin-auth-helpers';
import { DEVICE_TOKEN } from './helpers/ingestion';
import { statisticsCapabilities } from './helpers/v3-statistics-policy-fixtures';
import { v3Registration } from './helpers/device-v3-fixtures';

let state: Awaited<ReturnType<typeof authState>>;
let client: Client;
const publicCall = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, {
  method, headers: { Authorization: 'Bearer synthetic-operator-token', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), state.env);
const purposes = ['activity', 'parking', 'elevator'];
const enableAll = () => client.call('/places/library', 'PATCH', { observation_kinds: purposes });
const parking = (age = 0) => ({ id: crypto.randomUUID(), place_id: 'library', kind: 'parking', observed_at: new Date(Date.now() - age).toISOString(), parking_min: 2, parking_max: 4 });
const elevator = (age = 0) => ({ id: crypto.randomUUID(), place_id: 'library', kind: 'elevator', observed_at: new Date(Date.now() - age).toISOString(), wait_seconds: 0 });
const placement = (id: string, from: number, observation_kinds?: unknown, place_id: string | null = 'library') => client.call(`/devices/${state.config.node_id}/placements`, 'POST', {
  id, place_id, valid_from_ms: from, valid_until_ms: null, ...(observation_kinds === undefined ? {} : { observation_kinds }),
});

beforeEach(async () => { state = await authState(); client = new Client(state); await client.initialize(); });
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('concurrent observation purposes', () => {
  it('backfills pre-migration places and immutable placements without altering observations', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
      for (const name of migrations.filter(name => !name.startsWith('0006'))) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES (?,?)').run('legacy-node', 'a'.repeat(64));
      db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms,valid_until_ms) VALUES (?,?,?,?,?)').run('legacy-park', 'legacy-node', 'east-parking', 0, 1000);
      db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES (?,?,?,?)').run('legacy-transit', 'legacy-node', null, 1000);
      db.prepare('INSERT INTO observations(id,place_id,kind,observed_at,valid_until,received_at,parking_min,parking_max) VALUES (?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'east-parking', 'parking', '2026-10-24T00:00:00.000Z', '2026-10-24T00:15:00.000Z', '2026-10-24T00:01:00.000Z', 1, 2);
      const observations = db.prepare('SELECT * FROM observations').all();
      db.exec(readFileSync(new URL('../migrations/0006_observation_purposes.sql', import.meta.url), 'utf8'));
      expect(db.prepare('SELECT observation_kinds_json FROM places WHERE id=?').get('east-parking')?.observation_kinds_json).toBe('["parking"]');
      expect(db.prepare('SELECT observation_kinds_json FROM placements ORDER BY id').all()).toEqual([
        { observation_kinds_json: '["parking"]' }, { observation_kinds_json: '["activity"]' },
      ]);
      expect(db.prepare('SELECT * FROM observations').all()).toEqual(observations);
      expect(() => db.prepare('UPDATE placements SET observation_kinds_json=? WHERE id=?').run('["elevator"]', 'legacy-park')).toThrow(/immutable/);
      db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES (?,?)').run('legacy-insert-node', 'b'.repeat(64));
      db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms,valid_until_ms) VALUES (?,?,?,?,?)').run('legacy-insert-park', 'legacy-insert-node', 'east-parking', 0, 1000);
      db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms,valid_until_ms) VALUES (?,?,?,?,?)').run('legacy-insert-lift', 'legacy-insert-node', 'teaching-elevator', 1000, 2000);
      db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES (?,?,?,?)').run('legacy-insert-transit', 'legacy-insert-node', null, 2000);
      expect(db.prepare('SELECT observation_kinds_json FROM placements WHERE id LIKE ? ORDER BY valid_from_ms').all('legacy-insert-%')).toEqual([
        { observation_kinds_json: '["parking"]' }, { observation_kinds_json: '["elevator"]' }, { observation_kinds_json: '["activity"]' },
      ]);
      db.prepare('UPDATE places SET kind=?,observation_kinds_json=? WHERE id=?').run('activity', '["activity"]', 'east-parking');
      expect(db.prepare('SELECT observation_kinds_json FROM placements WHERE id=?').get('legacy-insert-park')?.observation_kinds_json).toBe('["parking"]');
      expect(() => db.prepare('UPDATE placements SET observation_kinds_json=NULL WHERE id=?').run('legacy-insert-park')).toThrow(/immutable/);
      expect(() => db.prepare('INSERT INTO places(id,name,kind,anchor_x,anchor_y,observation_kinds_json) VALUES (?,?,?,?,?,?)')
        .run('duplicate-purpose', 'Invalid', 'parking', 0, 0, '["parking","parking"]')).toThrow(/purposes_invalid/);
    } finally { db.close(); }
  });

  it('keeps independent latest manual results, expiry and cancellation at one three-purpose site', async () => {
    await json(await enableAll());
    const p = parking(16 * 60_000), e = elevator();
    const responses = await Promise.all([publicCall('/observations', 'POST', p), publicCall('/observations', 'POST', e)]);
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    const summary = await json(await publicCall('/places/library/summary'));
    expect(summary.place).toMatchObject({ kind: 'activity', observation_kinds: purposes });
    expect(summary.latest_observations.parking).toMatchObject({ id: p.id, kind: 'parking' });
    expect(summary.latest_observations.elevator).toMatchObject({ id: e.id, wait_seconds: 0 });
    expect(Date.parse(summary.latest_observations.parking.valid_until)).toBeLessThan(Date.now());
    expect(Date.parse(summary.latest_observations.elevator.valid_until)).toBeGreaterThan(Date.now());
    expect(summary).toMatchObject({ latest_observation: { id: e.id }, freshness: 'fresh', sensor: null });
    await json(await publicCall(`/observations/${e.id}`, 'DELETE'));
    const cancelled = await json(await publicCall('/places/library/summary'));
    expect(cancelled).toMatchObject({ latest_observations: { parking: { id: p.id }, elevator: null }, freshness: 'stale' });
    const history = await json(await publicCall('/places/library/history?minutes=60'));
    expect(history.observations.map((value: { id: string }) => value.id)).toEqual([p.id]);
    const next = elevator();
    await json(await publicCall('/observations', 'POST', next), 201);
    await json(await client.call('/places/library', 'PATCH', { observation_kinds: ['activity'] }));
    const retained = await json(await publicCall('/places/library/summary'));
    expect(retained.latest_observations.elevator.id).toBe(next.id);
    expect(retained.latest_observations.parking.id).toBe(p.id);
    expect((await publicCall('/observations', 'POST', elevator())).status).toBe(422);
    expect((await publicCall('/observations', 'POST', next)).status).toBe(200);
    expect((await publicCall('/observations', 'POST', { ...next, wait_seconds: 1 })).status).toBe(409);
    await json(await publicCall(`/observations/${next.id}`, 'DELETE'));
    expect((await json(await publicCall('/observations', 'POST', next))).observation.status).toBe('cancelled');
  });

  it('rejects invalid, empty and duplicate selections and preserves legacy kind-only callers', async () => {
    const before = state.db.prepare('SELECT COUNT(*) n FROM admin_audit').get()?.n;
    for (const observation_kinds of [[], ['parking','parking'], ['unknown'], [null], 'parking', null, ['activity','parking','elevator','activity']]) {
      expect((await client.call('/places', 'POST', { id: 'invalid', name: 'Invalid', anchor: { x: 0, y: 0 }, observation_kinds })).status).toBe(422);
      expect((await client.call('/places/library', 'PATCH', { observation_kinds })).status).toBe(422);
    }
    expect((await client.call('/places', 'POST', { id: 'invalid', name: 'Invalid', anchor: { x: 0, y: 0 } })).status).toBe(422);
    expect((await client.call('/places/library', 'PATCH', { kind: 'activity', observation_kinds: ['parking'] })).status).toBe(422);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_audit').get()?.n).toBe(before);
    const created = await json(await client.call('/places', 'POST', { id: 'legacy-place', name: 'Legacy', kind: 'parking', anchor: { x: 0, y: 0 } }), 201);
    expect(created.place).toMatchObject({ kind: 'parking', observation_kinds: ['parking'] });
    await json(await client.call('/places/legacy-place', 'PATCH', { kind: 'elevator' }));
    expect((await json(await publicCall('/places'))).places.find((p: { id: string }) => p.id === 'legacy-place')).toMatchObject({ kind: 'elevator', observation_kinds: ['elevator'] });
    const all = await json(await client.call('/places', 'POST', { id: 'new-place', name: 'New', observation_kinds: purposes, anchor: { x: 0, y: 0 } }), 201);
    expect(all.place).toMatchObject({ kind: 'activity', observation_kinds: purposes });
  });

  it('rechecks manual-purpose admission at insertion if an admin disables it after preflight', async () => {
    await json(await enableAll());
    const original = state.env.DB.prepare.bind(state.env.DB);
    vi.spyOn(state.env.DB, 'prepare').mockImplementation(sql => {
      const statement = original(sql);
      if (sql.startsWith('INSERT INTO observations')) {
        const run = statement.run.bind(statement);
        statement.run = async () => {
          state.db.prepare('UPDATE places SET observation_kinds_json=? WHERE id=?').run('["activity"]', 'library');
          return run();
        };
      }
      return statement;
    });
    expect((await publicCall('/observations', 'POST', parking())).status).toBe(422);
    expect(state.db.prepare('SELECT COUNT(*) n FROM observations').get()?.n).toBe(0);
  });

  it('keeps the summary fresh when a newer expired purpose coexists with an older still-valid one', async () => {
    await json(await enableAll());
    const old = parking(3 * 60_000);
    await json(await publicCall('/observations', 'POST', old), 201);
    const current = await json(await client.call('/settings'));
    await json(await client.call('/settings', 'PUT', { revision: current.revision, settings: { ...current.settings, observation_ttl_minutes: 1 } }));
    const newer = elevator(2 * 60_000);
    await json(await publicCall('/observations', 'POST', newer), 201);
    const summary = await json(await publicCall('/places/library/summary'));
    expect(summary).toMatchObject({ freshness: 'fresh', latest_observation: { id: newer.id }, latest_observations: { parking: { id: old.id }, elevator: { id: newer.id } } });
  });

  it('versions device work scope separately from strict capture policy and preserves old scope', async () => {
    await json(await enableAll());
    const from = Date.now() - 2000;
    const created = await json(await placement('all-work', from), 201);
    expect(created.placement.observation_kinds).toEqual(purposes);
    expect(created.requires_v3_assignment).toBe(true);
    Object.assign(state.env,{DEVICE_V3_CONTROL_ENABLED:'true',DEVICE_V3_STATISTICS_ENABLED:'true',DEVICE_V3_PRODUCER_VERSIONS:'["synthetic-statistics/1"]'});
    const caps=statisticsCapabilities(state.config.node_id);caps.uplink!.transports=['mqtt_tls'];
    await json(await worker.fetch(new Request(`${ORIGIN}/api/v3/device/capabilities`,{method:'POST',headers:{Authorization:`Bearer ${DEVICE_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(v3Registration(caps))}),state.env));
    const first=await json(await client.call('/device-v3/prepare','POST',{node_id:state.config.node_id,placement_id:'all-work'}));
    await json(await client.call('/device-v3/assignments','POST',{policy:first.policy,expected_generation:first.expected_generation}));
    await json(await placement('selected-work', from+1000, ['parking','elevator']),201);
    const next=await json(await client.call('/device-v3/prepare','POST',{node_id:state.config.node_id,placement_id:'selected-work'}));
    await json(await client.call('/device-v3/assignments','POST',{policy:next.policy,expected_generation:next.expected_generation}));
    await json(await client.call('/places/library', 'PATCH', { observation_kinds: ['activity'] }));
    const detail = await json(await client.call(`/devices/${state.config.node_id}`));
    expect(detail.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'selected-work', observation_kinds: ['parking','elevator'] }),
      expect.objectContaining({ id: 'all-work', observation_kinds: purposes, effective_valid_until_ms: from + 1000 }),
      expect.objectContaining({ id: state.config.placement_id, observation_kinds: ['activity'], effective_valid_until_ms: from }),
    ]));
    expect(JSON.stringify(detail.placements)).not.toContain('observation_kinds_json');
    expect(detail.device.desired_policy_id).toBe(next.policy.policy_id);
    expect(JSON.parse(String(state.db.prepare('SELECT envelope_json FROM device_assignments_v3 WHERE node_id=? AND generation=1').get(state.config.node_id)?.envelope_json)).policy).toEqual(first.policy);
    expect(Object.keys(next.policy)).not.toContain('observation_kinds');
    expect(state.db.prepare('SELECT placement_id FROM capture_configs WHERE id=?').get(state.config.capture_config_id)?.placement_id).toBe(state.config.placement_id);
  });

  it('rejects out-of-scope placement selection without closing the old placement; accepts unlocated purposes', async () => {
    const from = Date.now();
    for (const kinds of [[], ['activity','activity'], ['parking'], ['unknown']]) expect((await placement('invalid-scope', from, kinds)).status).toBe(422);
    expect(state.db.prepare('SELECT COUNT(*) n FROM placement_closures').get()?.n).toBe(0);
    const unlocated = await json(await placement('unlocated', from, purposes, null), 201);
    expect(unlocated.placement).toMatchObject({ place_id: null, observation_kinds: purposes });
    const defaultScope = await json(await placement('unlocated-default', from + 1, undefined, null), 201);
    expect(defaultScope.placement.observation_kinds).toEqual(['activity']);
  });

  it('rolls back the closure, insertion and audit if place purposes change before the placement transaction', async () => {
    await json(await enableAll());
    const before = state.db.prepare('SELECT COUNT(*) n FROM admin_audit').get()?.n;
    const batch = state.env.DB.batch.bind(state.env.DB);
    vi.spyOn(state.env.DB, 'batch').mockImplementation(async statements => {
      state.db.prepare('UPDATE places SET observation_kinds_json=? WHERE id=?').run('["activity"]', 'library');
      return batch(statements);
    });
    expect((await placement('racing-work', Date.now(), ['parking'])).status).toBe(409);
    expect(state.db.prepare('SELECT COUNT(*) n FROM placements WHERE id=?').get('racing-work')?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM placement_closures').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_audit').get()?.n).toBe(before);
  });

  it('rejects a raced default scope if newly added purposes would otherwise be silently omitted', async () => {
    const batch = state.env.DB.batch.bind(state.env.DB);
    vi.spyOn(state.env.DB, 'batch').mockImplementation(async statements => {
      state.db.prepare('UPDATE places SET observation_kinds_json=? WHERE id=?').run(JSON.stringify(purposes), 'library');
      return batch(statements);
    });
    expect((await placement('default-scope-race', Date.now())).status).toBe(409);
    expect(state.db.prepare('SELECT COUNT(*) n FROM placement_closures').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM placements WHERE id=?').get('default-scope-race')?.n).toBe(0);
  });
});
