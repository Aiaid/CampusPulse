import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { sha256 } from '../worker/ingest';
import { readLastReportedSensor } from '../worker/sensors';
import { DEVICE_TOKEN, fixture, seedConfig, setup } from './helpers/ingestion';

let state: Awaited<ReturnType<typeof setup>>;
const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://example.test${path}`, init), state.env);
const summary = async () => (await (await request('/api/v1/places/library/summary')).json()) as any;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  state = await setup();
  const config = { ...state.config, capture_config_id: 'field-config', dataset: 'field' as const };
  seedConfig(state.db, config);
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

async function upload(options: { version?: 1 | 2; config?: string; placement?: string; dataset?: string; seq?: number; utc?: number | null; uncertainty?: number | null; flags?: string[] } = {}) {
  const version = options.version ?? 1;
  const body = fixture(version === 2 ? 'ble-windows-v2.request' : 'ble-windows.request');
  Object.assign(body, { capture_config_id: options.config ?? 'field-config', dataset: options.dataset ?? 'field', batch_id: crypto.randomUUID(), boot_id: crypto.randomUUID() });
  if (options.placement) body.placement_id = options.placement;
  const item = body.items[0];
  Object.assign(item.time, { utc_ms: options.utc ?? null, uncertainty_ms: options.uncertainty ?? null });
  Object.assign(item, { seq: options.seq ?? 1, visible_identifiers: 64, reports_seen: 4801, reports_aggregated: 4801,
    adv_reports: 4801, scan_response_reports: 0, quality_flags: options.flags ?? [] });
  delete item.indices;
  if (version === 1) Object.assign(item.raw_capture, { intentional_skips: 4800 });
  const bytes = JSON.stringify(body);
  const response = await request(`/api/v${version}/ingest`, { method: 'POST', body: bytes, headers: {
    Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json',
    'X-Body-SHA256': await sha256(new TextEncoder().encode(bytes)),
  } });
  const ack = await response.json() as any;
  expect(response.status, JSON.stringify(ack)).toBe(200);
  return { body, ack };
}

describe('receipt-only public field aggregate fallback', () => {
  it('shows the existing unknown-UTC aggregate without elevating freshness, replay or inference', async () => {
    const { body, ack } = await upload();
    const result = await summary();
    expect(result).toMatchObject({ sensor: null, freshness: 'no_data', last_reported_sensor: {
      node_id: body.node_id, boot_id: body.boot_id, placement_id: body.placement_id, capture_config_id: 'field-config',
      dataset: 'field', source: 'sensor', seq: 1, visible_identifiers: 64, reports_aggregated: 4801,
      received_at: ack.received_at, observed_at: null, valid_until: null, uncertainty_ms: null,
      time_status: 'unknown', freshness: 'unverified',
    } });
    expect(result.automatic_observations.vehicles).toMatchObject({ status: 'unavailable', candidate_count: null });
    expect(result.automatic_observations.elevator).toMatchObject({ status: 'unavailable', wait_seconds: null });
    const history = await (await request('/api/v1/places/library/history?minutes=1440')).json();
    expect(history).toMatchObject({ sensor_windows: [] });
    expect(history).not.toHaveProperty('last_reported_sensor');
    expect(Object.keys(result.last_reported_sensor).sort()).toEqual([
      'node_id','boot_id','placement_id','capture_config_id','source','dataset','seq','received_at','observed_at',
      'valid_until','uncertainty_ms','time_status','duration_ms','scan_enabled_ms','reports_aggregated',
      'visible_identifiers','unique_table_overflow','aggregation_drops','quality_flags','freshness',
    ].sort());
    expect(JSON.stringify(result)).not.toMatch(/payload_hex|identity|raw_object_key|rssi|indices|address|brand_mask|exclusion_mask/);
  });

  it.each([{ uncertainty: null, flags: [] }, { uncertainty: 30001, flags: [] }, { uncertainty: 20, flags: ['utc_jump'] }])(
    'preserves original unreliable timestamps with uncertain status: %j', async ({ uncertainty, flags }) => {
      await upload({ utc: NOW - 1000, uncertainty, flags });
      expect(await summary()).toMatchObject({ sensor: null, freshness: 'no_data', last_reported_sensor: {
        observed_at: new Date(NOW - 1000).toISOString(), received_at: new Date(NOW).toISOString(),
        uncertainty_ms: uncertainty, time_status: 'uncertain', valid_until: null, freshness: 'unverified',
      } });
    });

  it.each([0, 180000])('keeps canonical timed windows authoritative at age %i', async age => {
    await upload();
    await upload({ utc: NOW - age, uncertainty: 20 });
    expect(await summary()).toMatchObject({ last_reported_sensor: null, sensor: { freshness: age ? 'stale' : 'fresh' }, freshness: age ? 'stale' : 'fresh' });
  });

  it('selects latest exact receipt and then sequence, never a count maximum or clock estimate', async () => {
    await upload({ seq: 20 });
    await upload({ seq: 21 });
    expect((await summary()).last_reported_sensor.seq).toBe(21);
    vi.mocked(Date.now).mockReturnValue(NOW + 1);
    const { ack } = await upload({ seq: 1 });
    expect((await summary()).last_reported_sensor).toMatchObject({ seq: 1, received_at: ack.received_at });
  });

  it('reads both validated protocol versions through the retained view', async () => {
    const config = fixture('capture-config-v2.fixture');
    Object.assign(config, { capture_config_id: 'field-v2', dataset: 'field', accept_until: new Date(NOW + 86400000).toISOString() });
    seedConfig(state.db, config);
    state.db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES (?,?,?)').run(config.node_id, config.capture_config_id, new Date(NOW).toISOString());
    await upload({ version: 2, config: config.capture_config_id });
    expect((await summary()).last_reported_sensor).toMatchObject({ capture_config_id: 'field-v2', visible_identifiers: 64 });
  });

  it('excludes demo, controlled tests, unknown quality flags and unknown places', async () => {
    await upload({ config: state.config.capture_config_id, dataset: 'demo' });
    const config = { ...state.config, capture_config_id: 'controlled-config', dataset: 'controlled_test' as const };
    seedConfig(state.db, config);
    await upload({ config: config.capture_config_id, dataset: config.dataset });
    await upload({ flags: ['unknown_quality_flag'] });
    expect((await summary()).last_reported_sensor).toBeNull();
    expect(await readLastReportedSensor(state.env, 'not-registered', NOW)).toBeNull();
  });

  it('excludes an expired retained aggregate', async () => {
    await upload();
    vi.mocked(Date.now).mockReturnValue(NOW + 7 * 86400000);
    expect((await summary()).last_reported_sensor).toBeNull();
  });

  it('retains receipts inside a closed original placement without relabeling them to its successor', async () => {
    await upload();
    state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES (?,?,?,?)')
      .run(state.config.placement_id, state.config.node_id, NOW + 1, new Date(NOW).toISOString());
    state.db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES (?,?,?,?)')
      .run('new-placement', state.config.node_id, 'east-parking', NOW + 1);
    vi.mocked(Date.now).mockReturnValue(NOW + 2);
    expect((await summary()).last_reported_sensor).toMatchObject({ placement_id: state.config.placement_id, visible_identifiers: 64 });
    expect(await readLastReportedSensor(state.env, 'east-parking', NOW + 2)).toBeNull();
    // End is exclusive: a queued record received at or after closure cannot
    // establish that its measurement belonged to the old physical placement.
    state.db.prepare('UPDATE sensor_windows SET received_at=?').run(new Date(NOW + 1).toISOString());
    expect((await summary()).last_reported_sensor).toBeNull();
    state.db.prepare('UPDATE sensor_windows SET received_at=?').run(new Date(NOW + 2).toISOString());
    expect((await summary()).last_reported_sensor).toBeNull();
  });

  it('requires receipt after placement start and exact registered placement/config scope', async () => {
    const { body } = await upload();
    state.db.prepare('UPDATE sensor_windows SET received_at=?').run('1969-12-31T23:59:59.999Z');
    expect((await summary()).last_reported_sensor).toBeNull();
    state.db.prepare('UPDATE sensor_windows SET received_at=?').run(new Date(NOW + 1).toISOString());
    expect((await summary()).last_reported_sensor).toBeNull();
    state.db.prepare('UPDATE sensor_windows SET received_at=?').run(new Date(NOW).toISOString());
    // Corrupt scope with foreign keys off to verify the public reader itself
    // enforces the registry join rather than trusting a device-supplied label.
    state.db.exec('PRAGMA foreign_keys=OFF');
    state.db.prepare('UPDATE sensor_windows SET capture_config_id=? WHERE boot_id=?').run('missing-config', body.boot_id);
    expect((await summary()).last_reported_sensor).toBeNull();
    state.db.prepare('UPDATE sensor_windows SET capture_config_id=? WHERE boot_id=?').run(state.config.capture_config_id, body.boot_id);
    expect((await summary()).last_reported_sensor).toBeNull();
  });

  it('withholds unlocated placements even when the aggregate is retained', async () => {
    state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES (?,?,?,?)')
      .run(state.config.placement_id, state.config.node_id, NOW - 1000, new Date(NOW).toISOString());
    state.db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES (?,?,?,?)')
      .run('unlocated', state.config.node_id, null, NOW - 1000);
    const config = { ...state.config, capture_config_id: 'unlocated-config', placement_id: 'unlocated', dataset: 'field' as const };
    seedConfig(state.db, config);
    await upload({ placement: 'unlocated', config: config.capture_config_id });
    expect((await summary()).last_reported_sensor).toBeNull();
  });
});
