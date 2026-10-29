import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { handleApi } from '../worker/index';
import { sha256 } from '../worker/ingest';
import { expireIngestion } from '../worker/retention';
import { DEVICE_TOKEN, fixture, seedConfig, setup } from './helpers/ingestion';

let state: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { state = await setup(); });
afterEach(() => state.db.close());
const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://example.test${path}`, init), state.env);
async function upload(value: unknown, overrides: Record<string, string> = {}, literal?: string) {
  const body = literal ?? JSON.stringify(value);
  return request('/api/v1/ingest', { method: 'POST', body, headers: {
    Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json',
    'X-Body-SHA256': await sha256(new TextEncoder().encode(body)), ...overrides,
  } });
}
const count = () => state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches').get()?.n;

describe('device HTTP ingestion', () => {
  it('commits each stream independently and returns identical private-safe retry ACKs', async () => {
    for (const name of ['ble-windows.request', 'ble-reports.request', 'node-status.request']) {
      const body = fixture(name);
      const first = await upload(body);
      expect(first.status).toBe(200);
      const ack = await first.json();
      expect(ack).toMatchObject({ batch_id: body.batch_id, accepted_count: 1, stream: body.stream, durability: 'committed' });
      expect(ack).not.toHaveProperty('raw_object_key');
      expect(await (await upload(body)).json()).toEqual(ack);
      expect((await upload({ ...body, firmware_version: 'changed' })).status).toBe(409);
    }
    expect(count()).toBe(3);
    expect(state.raw.objects.size).toBe(1);
    const config = await (await request('/api/v1/device/config', { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } })).json();
    expect(config).toMatchObject({ expired: false, config: { dataset: 'demo' } });
  });

  it('fails closed for operator/research/unknown credentials and node/dataset/identity escalation', async () => {
    const body = fixture('ble-reports.request');
    for (const token of ['wrong', 'synthetic-operator-token', 'synthetic-research-token']) expect((await upload(body, { Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await upload({ ...body, node_id: 'other-node' })).status).toBe(403);
    expect((await upload({ ...body, dataset: 'field' })).status).toBe(422);
    body.items[0].identity = { scheme: 'none' };
    expect((await upload(body)).status).toBe(422);
    expect(count()).toBe(0);
    expect(state.raw.objects.size).toBe(0);
  });

  it('validates exact bytes, duplicate keys, bounded content and ranges before writes', async () => {
    const body = fixture('ble-reports.request');
    expect((await upload(body, { 'X-Body-SHA256': 'a'.repeat(64) })).status).toBe(400);
    expect((await upload(body, {}, '{"protocol":"campuspulse/1","protocol":"campuspulse/1"}')).status).toBe(400);
    expect((await upload(body, { 'Content-Encoding': 'gzip' })).status).toBe(415);
    expect((await upload(body, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await upload(body, {}, ' '.repeat(65537))).status).toBe(413);
    expect((await upload(body, { Origin: 'https://elsewhere.test' })).status).toBe(403);
    body.items[0].payload_length = 30;
    expect((await upload(body)).status).toBe(422);
    expect(count()).toBe(0);
  });

  it('rejects overlapping intervals and permits independent boot/stream numbering', async () => {
    const body = fixture('ble-reports.request');
    expect((await upload(body)).status).toBe(200);
    expect((await upload({ ...body, batch_id: crypto.randomUUID() })).status).toBe(409);
    expect((await upload({ ...body, batch_id: crypto.randomUUID(), boot_id: crypto.randomUUID() })).status).toBe(200);
    expect((await upload(fixture('node-status.request'))).status).toBe(200);
  });

  it('returns no ACK on R2 or D1 failure, then recovers the original frozen raw object', async () => {
    const body = fixture('ble-reports.request');
    state.raw.failPut = true;
    expect((await upload(body)).status).toBe(503);
    expect(count()).toBe(0);
    state.raw.failPut = false;
    const originalBatch = state.env.DB.batch;
    state.env.DB.batch = async () => { throw new Error('Synthetic D1 outage'); };
    expect((await upload(body)).status).toBe(503);
    expect(state.raw.objects.size).toBe(1);
    expect(count()).toBe(0);
    state.env.DB.batch = originalBatch;
    expect((await upload(body)).status).toBe(200);
    expect(state.raw.objects.size).toBe(1);
    expect(count()).toBe(1);
  });

  it('allows private parsing of malformed air payloads without exposing raw via public reads', async () => {
    const body = fixture('ble-reports.request');
    body.items[0].payload_hex = 'ff09'; body.items[0].payload_length = 2;
    expect((await upload(body)).status).toBe(200);
    const path = `/api/v1/research/batches/${body.batch_id}?node_id=${body.node_id}`;
    expect((await request(path)).status).toBe(401);
    expect((await request(path, { headers: { Authorization: 'Bearer synthetic-operator-token' } })).status).toBe(401);
    const response = await request(path, { headers: { Authorization: 'Bearer synthetic-research-token' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ batch: { items: [{ payload_hex: 'ff09' }] }, derived: [{ parse_status: 'malformed', classification: { category: 'unknown' } }] });
    expect(await (await request('/api/v1/places/library/summary')).json()).toMatchObject({ sensor: null });
    delete state.env.RAW_BUCKET;
    body.batch_id = crypto.randomUUID(); body.items[0].seq += 280;
    expect((await upload(body)).status).toBe(503);
  });

  it('retains ACK after expiry and raw deletion, prevents fresh writes under expired policy', async () => {
    const body = fixture('ble-reports.request');
    const ack = await (await upload(body)).json();
    const future = Date.now() + 2 * 86_400_000;
    await expireIngestion(state.env, future);
    expect(state.raw.objects.size).toBe(0);
    expect(await (await upload(body)).json()).toEqual(ack);
    const expired = structuredClone(state.config);
    expired.capture_config_id = 'expired'; expired.accept_until = new Date(Date.now() - 1).toISOString();
    seedConfig(state.db, expired);
    const rejected = await upload({ ...body, batch_id: crypto.randomUUID(), capture_config_id: 'expired' });
    expect(rejected.status).toBe(410);
    // Receipt removal is allowed only after its retention bound; config remains
    // immutable so an ancient batch can never resurrect a retained object.
    await expireIngestion(state.env, future + 10 * 86_400_000);
    expect(count()).toBe(0);
  });
});

describe('public field sensor projection', () => {
  const uploadPublic = async (value: any) => {
    const bytes = JSON.stringify(value);
    return request('/api/v2/ingest', { method: 'POST', body: bytes, headers: {
      Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json',
      'X-Body-SHA256': await sha256(new TextEncoder().encode(bytes)),
    } });
  };
  const seedPublic = (config: any) => {
    config.accept_until = new Date(Date.now() + 86400000).toISOString();
    seedConfig(state.db, config);
    state.db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES (?,?,?)')
      .run(config.node_id, config.capture_config_id, new Date().toISOString());
  };
  beforeEach(() => {
    const config = fixture('capture-config-v2.fixture');
    config.accept_until = new Date(Date.now() + 86400000).toISOString();
    seedPublic(config);
  });
  it('withholds uncertain clocks, unknown quality flags and data captured after a placement closure', async () => {
    const config = fixture('capture-config-v2.fixture'); config.capture_config_id = 'field'; config.dataset = 'field';
    seedPublic(config);
    const now = Date.now();
    const sendWindow = async (uncertainty: number | null, flags: string[] = []) => {
      const body = fixture('ble-windows-v2.request');
      Object.assign(body, { dataset: 'field', capture_config_id: 'field', batch_id: crypto.randomUUID(), boot_id: crypto.randomUUID() });
      Object.assign(body.items[0].time, { utc_ms: now, uncertainty_ms: uncertainty });
      body.items[0].quality_flags = flags;
      expect((await uploadPublic(body)).status).toBe(200);
    };
    await sendWindow(null);
    await sendWindow(30001);
    await sendWindow(20, ['utc_jump']);
    expect(await (await request('/api/v1/places/library/summary')).json()).toMatchObject({ sensor: null, freshness: 'no_data' });
    state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES (?,?,?,?)')
      .run(config.placement_id, config.node_id, now - 1000, new Date().toISOString());
    await sendWindow(20);
    expect(await (await request('/api/v1/places/library/summary')).json()).toMatchObject({ sensor: null });
  });

  it('uses capture time for stale backfill without inventing people counts', async () => {
    const config = fixture('capture-config-v2.fixture'); config.capture_config_id = 'field'; config.dataset = 'field';
    seedPublic(config);
    const body = fixture('ble-windows-v2.request');
    Object.assign(body, { dataset: 'field', capture_config_id: 'field' });
    Object.assign(body.items[0].time, { utc_ms: Date.now() - 180000, uncertainty_ms: 20 });
    expect((await uploadPublic(body)).status).toBe(200);
    const summary = await (await request('/api/v1/places/library/summary')).json();
    expect(summary).toMatchObject({ freshness: 'stale', sensor: { freshness: 'stale' } });
    expect(JSON.stringify(summary)).not.toContain('people_count');
  });

  it('keeps demo, controlled tests, unknown UTC, stale and placement changes distinct', async () => {
    const body = fixture('ble-windows-v2.request');
    const now = Date.now();
    body.items[0].time.utc_ms = now;
    body.items[0].time.uncertainty_ms = 20;
    await uploadPublic(body);
    expect(await (await request('/api/v1/places/library/summary')).json()).toMatchObject({ sensor: null });
    for (const dataset of ['controlled_test', 'field'] as const) {
      const config = fixture('capture-config-v2.fixture'); config.capture_config_id = dataset; config.dataset = dataset;
      seedPublic(config);
      const value = { ...body, capture_config_id: dataset, dataset, batch_id: crypto.randomUUID(), boot_id: crypto.randomUUID() };
      value.items[0].time.utc_ms = dataset === 'field' ? null : now;
      value.items[0].time.uncertainty_ms = dataset === 'field' ? null : 20;
      expect((await uploadPublic(value)).status).toBe(200);
    }
    expect(await (await request('/api/v1/places/library/summary')).json()).toMatchObject({ sensor: null });
    body.dataset = 'field'; body.capture_config_id = 'field'; body.batch_id = crypto.randomUUID(); body.boot_id = crypto.randomUUID();
    body.items[0].time.utc_ms = now; body.items[0].time.uncertainty_ms = 20;
    expect((await uploadPublic(body)).status).toBe(200);
    const summary = await (await request('/api/v1/places/library/summary')).json();
    expect(summary).toMatchObject({ freshness: 'fresh', sensor: { dataset: 'field', source: 'sensor', visible_identifiers: body.items[0].visible_identifiers } });
    expect(JSON.stringify(summary)).not.toMatch(/payload_hex|identity|raw_object_key/);
    const history = await (await request('/api/v1/places/library/history')).json();
    expect(history).toMatchObject({ sensor_windows: [{ dataset: 'field' }], sensor_truncated: false });
    expect((history as { sensor_windows: unknown[] }).sensor_windows).toHaveLength(1);
  });
});
