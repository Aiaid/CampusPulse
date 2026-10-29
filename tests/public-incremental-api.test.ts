import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleApi } from '../worker/index';
import { setup } from './helpers/ingestion';

const NOW = Date.parse('2026-10-29T05:00:00.000Z');
const columns = 'id,place_id,kind,source,status,observed_at,valid_until,parking_min,parking_max,wait_seconds';
let state: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  state = await setup();
  state.db.prepare('UPDATE places SET observation_kinds_json=? WHERE id=?')
    .run('["activity","parking","elevator"]', 'library');
});
afterEach(() => { state.db.close(); vi.useRealTimers(); });
const call = async (path: string, init?: RequestInit) => {
  const response = await handleApi(new Request('https://incremental.example.test/api/v1' + path, init), state.env);
  expect(response).not.toBeNull(); expect(response!.status).toBe(200);
  return response!.json() as Promise<any>;
};
function manual(age: number, options: { id?: string; receivedAge?: number; validUntil?: number; wait?: number } = {}) {
  const row = { id: options.id ?? crypto.randomUUID(), observed: NOW - age,
    received: NOW - (options.receivedAge ?? 1000), valid: options.validUntil ?? NOW + 60000 };
  state.db.prepare(`INSERT INTO observations(id,place_id,kind,observed_at,valid_until,received_at,parking_min,parking_max,wait_seconds)
    VALUES(?,'library',?,?,?,?,?,?,?)`).run(row.id, options.wait === undefined ? 'parking' : 'elevator',
      new Date(row.observed).toISOString(), new Date(row.valid).toISOString(), new Date(row.received).toISOString(),
      options.wait === undefined ? 2 : null, options.wait === undefined ? 4 : null, options.wait ?? null);
  return row;
}
function assertProjection() {
  expect(state.db.prepare('SELECT * FROM public_observation_projection ORDER BY id').all())
    .toEqual(state.db.prepare("SELECT * FROM observations WHERE status='active' ORDER BY id").all());
  expect(state.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

it('incorporates late manual backfill and tied receipt timestamps without replacing a newer observation', async () => {
  const latest = manual(10000), earlier = manual(600000), tied = manual(20000);
  assertProjection();
  const summary = await call('/places/library/summary');
  expect(summary.latest_observations.parking.id).toBe(latest.id);
  const history = await call('/places/library/history?minutes=15');
  expect(history.observations.map((row: { id: string }) => row.id)).toEqual([latest.id, tied.id, earlier.id]);
  expect(history.observations).toEqual(state.db.prepare(`SELECT ${columns} FROM observations
    WHERE place_id='library' AND status='active' AND observed_at>=? AND observed_at<=?
    ORDER BY observed_at DESC,id DESC LIMIT 200`).all(history.from, history.to));
});

it('cancels the latest record through the API, restores the older winner and never resurrects on an exact retry', async () => {
  const older = manual(600000), latest = manual(10000);
  const cancel = () => call(`/observations/${latest.id}`, { method: 'DELETE',
    headers: { Authorization: `Bearer ${state.env.OPERATOR_TOKEN}` } });
  await cancel(); await cancel(); assertProjection();
  expect((await call('/places/library/summary')).latest_observations.parking.id).toBe(older.id);
  expect((await call('/places/library/history?minutes=15')).observations.map((row: { id: string }) => row.id)).toEqual([older.id]);
  const retry = await call('/observations', { method: 'POST', headers: { Authorization: `Bearer ${state.env.OPERATOR_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: latest.id, place_id: 'library', kind: 'parking',
      observed_at: new Date(latest.observed).toISOString(), parking_min: 2, parking_max: 4 }) });
  expect(retry.observation.status).toBe('cancelled'); assertProjection();
  expect(state.db.prepare('SELECT COUNT(*) n FROM observations').get()?.n).toBe(2);
});

it('changes display freshness and rolling history with time, preserving retained historical elevator samples', async () => {
  const parking = manual(10000, { validUntil: NOW + 1000 });
  const oldElevator = manual(2 * 86400000, { validUntil: NOW - 86400000, wait: 30 });
  expect((await call('/places/library/summary')).freshness).toBe('fresh');
  vi.setSystemTime(NOW + 2000);
  const stale = await call('/places/library/summary');
  expect(stale.freshness).toBe('stale'); expect(stale.latest_observations.parking.id).toBe(parking.id);
  expect(stale.latest_observations.elevator.id).toBe(oldElevator.id);
  expect(stale.automatic_observations.elevator.sample_count).toBe(1);
  expect((await call('/places/library/history?minutes=15')).observations).toHaveLength(1);
  vi.setSystemTime(NOW + 16 * 60000);
  expect((await call('/places/library/history?minutes=15')).observations).toEqual([]);
  assertProjection(); expect(state.db.prepare('SELECT COUNT(*) n FROM observations').get()?.n).toBe(2);
});

it('publishes a previously future record when time catches up without requiring another upload', async () => {
  const future = manual(-20000);
  expect((await call('/places/library/history?minutes=1')).observations).toEqual([]);
  vi.setSystemTime(NOW + 20000);
  expect((await call('/places/library/history?minutes=1')).observations.map((row: { id: string }) => row.id)).toEqual([future.id]);
  assertProjection();
});

it('repairs the corresponding cached row on source change and removes it on canonical deletion', async () => {
  const row = manual(10000);
  state.db.prepare('UPDATE observations SET parking_min=7,parking_max=8 WHERE id=?').run(row.id);
  assertProjection(); expect((await call('/places/library/summary')).latest_observation.parking_max).toBe(8);
  state.db.prepare('DELETE FROM observations WHERE id=?').run(row.id);
  assertProjection(); expect((await call('/places/library/summary')).latest_observation).toBeNull();
});
