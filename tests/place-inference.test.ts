import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAutomaticObservations } from '../worker/place-inference';
import { readPublicWindows, type PublicSensorWindow } from '../worker/sensors';
import { commitBatchV2 } from '../worker/device-v2-store';
import { validateEnvelopeV2, type AddressSummary, type CaptureConfigV2 } from '../worker/device-v2-validation';
import type { BleWindow } from '../worker/ingest-validation';
import type { Place } from '../worker/types';
import { COMPACT_VEHICLE_SCHEMA_VERSION, type CompactVehicleEvidence } from '../worker/vehicle-rules';
import { normalizeAutomaticObservations } from '../src/campus/field-data.js';
import { sha256 } from '../worker/ingest';
import { fixture, setup } from './helpers/ingestion';

const NOW = Date.parse('2026-10-22T02:30:00.000Z'), DAY = 86_400_000;
const BOOT = '11111111-1111-4111-8111-111111111111';
let state: Awaited<ReturnType<typeof setup>>;
const place: Place = { id: 'library', name: 'Synthetic library', kind: 'activity',
  observation_kinds: ['activity', 'parking', 'elevator'], anchor: { x: 0.5, y: 0.5 }, coverage: 'unconfigured' };
const compact = (extra: Partial<CompactVehicleEvidence> = {}): CompactVehicleEvidence => ({
  schema_version: COMPACT_VEHICLE_SCHEMA_VERSION, parsed_reports: 2, malformed_reports: 0,
  name_brand_mask: 0, exclusion_mask: 0, ecosystem_mask: 0, ...extra,
});
async function register(suffix = 'one', purposes = ['parking'], dataset: CaptureConfigV2['dataset'] = 'field') {
  const config = fixture('capture-config-v2.fixture') as CaptureConfigV2;
  Object.assign(config, { node_id: `synthetic-node-${suffix}`, placement_id: `synthetic-placement-${suffix}`,
    capture_config_id: `synthetic-config-${suffix}`, dataset, accept_until: new Date(NOW + DAY).toISOString() });
  state.db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').run(config.node_id, await sha256(new TextEncoder().encode(suffix)));
  state.db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms,observation_kinds_json) VALUES(?,?,?,?,?)')
    .run(config.placement_id, config.node_id, 'library', 0, JSON.stringify(purposes));
  state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
    .run(config.capture_config_id, config.node_id, config.placement_id, dataset, JSON.stringify(config), NOW + DAY);
  return config;
}
function windowItem(count: number, extra: Partial<BleWindow> = {}): BleWindow {
  const reports = count * 2;
  return { seq: 1, time: { mono_ms: 60000, utc_ms: NOW - 1000, uncertainty_ms: 10, clock_epoch: 1 },
    duration_ms: 30000, scan_enabled_ms: 30000, reports_seen: reports, reports_aggregated: reports, aggregation_drops: 0,
    adv_reports: reports, scan_response_reports: 0, visible_identifiers: count, unique_table_capacity: 64, unique_table_overflow: false,
    rssi: { samples: reports, min_dbm: reports ? -70 : null, max_dbm: reports ? -50 : null, mean_dbm: reports ? -60 : null },
    raw_capture: { mode: 'off', selected_reports: 0, intentional_skips: 0, pressure_skips: 0, drops: 0 }, quality_flags: [], ...extra };
}
function summaryItem(window: BleWindow, index: number, evidence?: CompactVehicleEvidence): AddressSummary {
  return { seq: window.seq * 100 + index, time: { ...window.time }, window_seq: window.seq,
    duration_ms: window.duration_ms, bin_ms: 5000, address: `02:00:00:00:00:${index.toString(16).padStart(2, '0')}`, address_type: 'random',
    reports: 2, adv_reports: 2, scan_response_reports: 0, first_offset_ms: 100, last_offset_ms: window.duration_ms - 100,
    bins: Array.from({ length: Math.ceil(window.duration_ms / 5000) }, (_, i) => {
      const end = Math.ceil(window.duration_ms / 5000) - 1;
      return (i === 0 ? 1 : 0) + (i === end ? 1 : 0);
    }), rssi: { samples: 2, min_dbm: -70, max_dbm: -50, mean_dbm: -60 },
    ...(evidence ? { vehicle_evidence: evidence } : {}) };
}
async function commit(config: CaptureConfigV2, stream: 'ble_windows' | 'address_summaries', items: (BleWindow | AddressSummary)[], received = NOW - 500) {
  const batch = validateEnvelopeV2({ protocol: 'campuspulse/2', node_id: config.node_id, boot_id: BOOT,
    placement_id: config.placement_id, capture_config_id: config.capture_config_id, dataset: config.dataset,
    batch_id: crypto.randomUUID(), firmware_version: 'synthetic-compact-fixture', stream, items });
  return commitBatchV2(state.env.DB, batch, await sha256(new TextEncoder().encode(JSON.stringify(batch))), null, 24, 7, NOW + DAY, received);
}
async function seed(evidence: (CompactVehicleEvidence | undefined)[], options: {
  config?: CaptureConfigV2; window?: Partial<BleWindow>; omitSummaries?: boolean;
} = {}) {
  const config = options.config ?? await register(), window = windowItem(evidence.length, options.window);
  await commit(config, 'ble_windows', [window]);
  const summaries = evidence.map((item, index) => summaryItem(window, index + 1, item));
  if (summaries.length && !options.omitSummaries) await commit(config, 'address_summaries', summaries);
  return { config, window, summaries };
}
const windows = (now = NOW) => readPublicWindows(state.env, 'library', now - DAY, now);
const read = async (now = NOW, selected = place, input?: PublicSensorWindow[]) => {
  const result = await readAutomaticObservations(state.env, selected, input ?? await windows(now), now);
  expect(normalizeAutomaticObservations(result)).toEqual(result);
  return result;
};
function manual(index: number, extra: { observed?: number; received?: number; wait?: number; status?: string; target?: string } = {}) {
  const observed = extra.observed ?? NOW - (1 + index % 2) * DAY;
  state.db.prepare('INSERT INTO observations(id,place_id,kind,status,observed_at,valid_until,received_at,wait_seconds) VALUES(?,?,?,?,?,?,?,?)')
    .run(`synthetic-manual-${index}`, extra.target ?? 'library', 'elevator', extra.status ?? 'active',
      new Date(observed).toISOString(), new Date(observed + 900000).toISOString(), new Date(extra.received ?? observed + 1000).toISOString(), extra.wait ?? index * 10);
}
beforeEach(async () => {
  state = await setup();
  state.db.prepare('UPDATE places SET observation_kinds_json=? WHERE id=?').run(JSON.stringify(place.observation_kinds), place.id);
});
afterEach(() => state.db.close());

describe('public automatic vehicle projection', () => {
  it('keeps absent and disabled purposes unavailable without querying private evidence', async () => {
    expect(await read()).toMatchObject({ vehicles: { status: 'unavailable', reason: 'no_field_sensor_windows', candidate_count: null },
      elevator: { status: 'unavailable', reason: 'no_manual_samples' } });
    expect(await read(NOW, { ...place, observation_kinds: ['activity'] })).toMatchObject({
      vehicles: { reason: 'purpose_not_enabled' }, elevator: { reason: 'purpose_not_enabled' },
    });
  });

  it('requires the immutable placement parking purpose even when the site enables parking', async () => {
    await seed([compact({ name_brand_mask: 1 })], { config: await register('activity', ['activity']) });
    expect((await read()).vehicles).toMatchObject({ status: 'unavailable', reason: 'purpose_not_enabled', candidate_count: null });
  });

  it('reports pending summaries and legacy missing features rather than zero', async () => {
    const capture = await seed([compact()], { omitSummaries: true });
    expect((await read()).vehicles).toMatchObject({ reason: 'summaries_pending', candidate_count: null });
    const legacy = { ...capture.summaries[0] };
    delete legacy.vehicle_evidence;
    await commit(capture.config, 'address_summaries', [legacy]);
    expect((await read()).vehicles).toMatchObject({ reason: 'vehicle_features_not_reported', evidence_kind: 'none', candidate_count: null });
  });

  it('requires every visible identifier summary and every feature object', async () => {
    const capture = await seed([compact(), compact()], { omitSummaries: true });
    await commit(capture.config, 'address_summaries', [capture.summaries[0]]);
    expect((await read()).vehicles.reason).toBe('summaries_pending');
    const legacy = { ...capture.summaries[1] };
    delete legacy.vehicle_evidence;
    await commit(capture.config, 'address_summaries', [legacy]);
    expect((await read()).vehicles.reason).toBe('vehicle_features_not_reported');
  });

  it('publishes a genuine zero only with usable classified input', async () => {
    await seed([compact()]);
    expect((await read()).vehicles).toMatchObject({ status: 'candidate_estimate', candidate_count: 0,
      car_related_count: 0, ecosystem_count: 0, sample_count: 2, evidence_kind: 'compact', reason: null,
      observed_at: new Date(NOW - 1000).toISOString(), valid_until: new Date(NOW - 1000 - 10 + 90000).toISOString() });
  });

  it('keeps e-bike, car, ecosystem and exclusions separate without leaking private fields', async () => {
    await seed([compact({ name_brand_mask: 1 }), compact({ name_brand_mask: 1 << 5 }),
      compact({ ecosystem_mask: 1 }), compact({ name_brand_mask: 1, exclusion_mask: 1 })]);
    const result = await read();
    expect(result.vehicles).toMatchObject({ candidate_count: 1, car_related_count: 1, ecosystem_count: 1, sample_count: 8 });
    const text = JSON.stringify(result);
    for (const secret of ['02:00:', 'synthetic-node', 'synthetic-placement', 'synthetic-config', BOOT, 'name_brand_mask', 'exclusion_mask', 'ecosystem_mask', 'address_type', 'rule_id']) {
      expect(text).not.toContain(secret);
    }
    expect(state.raw.objects.size).toBe(0);
  });

  it('uses one latest node/window, never sums nodes or falls back to older positive results', async () => {
    await seed([compact({ name_brand_mask: 1 }), compact({ name_brand_mask: 1 })], { config: await register('older'),
      window: { time: { mono_ms: 60000, utc_ms: NOW - 5000, uncertainty_ms: 10, clock_epoch: 1 } } });
    await seed([compact()], { config: await register('latest') });
    const rows = await windows();
    expect((await read(NOW, place, rows.reverse())).vehicles).toMatchObject({ candidate_count: 0, sample_count: 2 });
  });

  it('selects the latest parking-purpose window before inspecting its classification', async () => {
    await seed([compact({ name_brand_mask: 1 })], { config: await register('parking-old'),
      window: { time: { mono_ms: 60000, utc_ms: NOW - 5000, uncertainty_ms: 10, clock_epoch: 1 } } });
    await seed([compact({ name_brand_mask: 1 })], { config: await register('activity-new', ['activity']) });
    expect((await read()).vehicles).toMatchObject({ status: 'candidate_estimate', candidate_count: 1,
      observed_at: new Date(NOW - 5000).toISOString(), sample_count: 2 });
    await seed([undefined], { config: await register('parking-new'),
      window: { time: { mono_ms: 60000, utc_ms: NOW - 500, uncertainty_ms: 10, clock_epoch: 1 } } });
    expect((await read()).vehicles).toMatchObject({ status: 'unavailable', reason: 'vehicle_features_not_reported',
      observed_at: new Date(NOW - 500).toISOString(), candidate_count: null });
  });

  it('does not substitute fresh activity data for a stale parking window', async () => {
    await seed([compact({ name_brand_mask: 1 })], { config: await register('parking-old'),
      window: { time: { mono_ms: 60000, utc_ms: NOW - 100000, uncertainty_ms: 10, clock_epoch: 1 } } });
    await seed([compact({ name_brand_mask: 1 })], { config: await register('activity-new', ['activity']) });
    expect((await read()).vehicles).toMatchObject({ status: 'unavailable', reason: 'stale_sensor_window', candidate_count: null });
  });

  it('bounds the public candidate set and abstains if overflow could hide a parking scope', async () => {
    await seed([compact()], { config: await register('activity', ['activity']) });
    const [row] = await windows();
    expect((await read(NOW, place, Array.from({ length: 201 }, () => row))).vehicles.reason).toBe('input_limit_exceeded');
    expect((await read(NOW, place, Array.from({ length: 202 }, () => row))).vehicles.reason).toBe('input_limit_exceeded');
  });

  it('does not renew stale sensor evidence or admit future observations', async () => {
    await seed([compact({ name_brand_mask: 1 })]);
    const rows = await windows();
    expect((await read(NOW + 100000, place, rows)).vehicles).toMatchObject({ status: 'unavailable', reason: 'stale_sensor_window',
      valid_until: rows[0].valid_until, candidate_count: null });
    expect((await read(NOW, place, [{ ...rows[0], observed_at: new Date(NOW + 1000).toISOString() }])).vehicles.reason).toBe('no_field_sensor_windows');
  });

  it('keeps an empty radio window and all-unusable AD features unavailable', async () => {
    const empty = await seed([]);
    expect((await read()).vehicles).toMatchObject({ reason: 'no_usable_vehicle_features', candidate_count: null, sample_count: 0 });
    await seed([compact({ parsed_reports: 0, malformed_reports: 2 })], { config: empty.config,
      window: { seq: 2, time: { mono_ms: 90000, utc_ms: NOW - 500, uncertainty_ms: 10, clock_epoch: 1 } } });
    expect((await read()).vehicles).toMatchObject({ reason: 'no_usable_vehicle_features', candidate_count: null, evidence_kind: 'compact' });
  });

  it('marks partial/overflow/drop evidence as incomplete observations', async () => {
    await seed([compact({ name_brand_mask: 1 })], { window: { duration_ms: 1880, scan_enabled_ms: 1880,
      reports_seen: 5, reports_aggregated: 4, adv_reports: 4, aggregation_drops: 1, unique_table_overflow: true,
      quality_flags: ['partial_window', 'unique_table_overflow', 'aggregation_drops'] } });
    expect((await read()).vehicles).toMatchObject({ status: 'candidate_estimate', candidate_count: 1, sample_count: 2,
      quality_flags: ['partial_window', 'unique_table_overflow', 'aggregation_drops', 'incomplete_vehicle_evidence'] });
  });

  it('does not turn conflicting categories into a confident zero', async () => {
    const capture = await seed([compact({ name_brand_mask: 1 | (1 << 5) })]);
    expect((await read()).vehicles).toMatchObject({ status: 'unavailable', reason: 'no_usable_vehicle_features',
      candidate_count: null, sample_count: 2, quality_flags: ['unusable_vehicle_features'] });
    await seed([compact({ name_brand_mask: 1 | (1 << 5) }), compact({ name_brand_mask: 1 })], { config: capture.config,
      window: { seq: 2, time: { mono_ms: 90000, utc_ms: NOW - 500, uncertainty_ms: 10, clock_epoch: 1 } } });
    expect((await read()).vehicles).toMatchObject({ status: 'candidate_estimate', candidate_count: 1, sample_count: 4,
      quality_flags: ['unusable_vehicle_features', 'incomplete_vehicle_evidence'] });
  });

  it('allows added exclusion evidence to reduce candidates instead of promising a lower bound', async () => {
    const capture = await seed([compact({ name_brand_mask: 1 })], { window: {
      reports_seen: 3, aggregation_drops: 1, quality_flags: ['aggregation_drops'],
    } });
    const incomplete = (await read()).vehicles;
    expect(incomplete).toMatchObject({ candidate_count: 1, quality_flags: ['aggregation_drops', 'incomplete_vehicle_evidence'] });
    // A later synthetic window includes an additional parsed exclusion report
    // for the same address: more evidence can remove the earlier rule candidate.
    const full = windowItem(1, { seq: 2, time: { mono_ms: 90000, utc_ms: NOW - 500, uncertainty_ms: 10, clock_epoch: 1 },
      reports_seen: 3, reports_aggregated: 3, adv_reports: 3 });
    const summary = summaryItem(full, 1, compact({ parsed_reports: 3, name_brand_mask: 1, exclusion_mask: 1 }));
    summary.reports = summary.adv_reports = 3; summary.bins[5] = 2;
    await commit(capture.config, 'ble_windows', [full]);
    await commit(capture.config, 'address_summaries', [summary]);
    expect((await read()).vehicles).toMatchObject({ status: 'candidate_estimate', candidate_count: 0, sample_count: 3 });
    expect(JSON.stringify(incomplete)).not.toContain('lower_bound');
  });

  it.each(['expired_item', 'expired_batch', 'late_receipt'])('does not use %s private rows', async change => {
    await seed([compact({ name_brand_mask: 1 })]);
    if (change === 'expired_item') state.db.exec(`UPDATE ingestion_items_v2 SET expires_at_ms=${NOW} WHERE stream='address_summaries'`);
    if (change === 'expired_batch') state.db.exec(`UPDATE ingestion_batches_v2 SET expires_at_ms=${NOW} WHERE stream='address_summaries'`);
    if (change === 'late_receipt') state.db.prepare("UPDATE ingestion_items_v2 SET received_at=? WHERE stream='address_summaries'").run(new Date(NOW + 1000).toISOString());
    expect((await read()).vehicles).toMatchObject({ status: 'unavailable', reason: 'summaries_pending', candidate_count: null });
  });

  it.each(['mono', 'epoch', 'count', 'duration', 'mask'])('abstains on inconsistent or malformed %s data', async change => {
    await seed([compact({ name_brand_mask: 1 })]);
    const stored = state.db.prepare("SELECT item_json FROM ingestion_items_v2 WHERE stream='address_summaries'").get();
    const item = JSON.parse(String(stored?.item_json)) as AddressSummary;
    if (change === 'mono') item.time.mono_ms++;
    if (change === 'epoch') item.time.clock_epoch++;
    if (change === 'duration') item.duration_ms--;
    if (change === 'count') { item.reports++; item.adv_reports++; item.bins[0]++; item.vehicle_evidence!.parsed_reports++; }
    if (change === 'mask') item.vehicle_evidence!.name_brand_mask = 1 << 20;
    state.db.prepare("UPDATE ingestion_items_v2 SET item_json=? WHERE stream='address_summaries'").run(JSON.stringify(item));
    expect((await read()).vehicles).toMatchObject({ status: 'unavailable', candidate_count: null });
  });

  it('excludes demo input and rejects caller/window projection inconsistencies', async () => {
    await seed([compact({ name_brand_mask: 1 })], { config: await register('demo', ['parking'], 'demo') });
    expect((await read()).vehicles.reason).toBe('no_field_sensor_windows');
    await seed([compact()], { config: await register('field') });
    const rows = await windows();
    expect((await read(NOW, place, [{ ...rows[0], visible_identifiers: 65 }])).vehicles).toMatchObject({ status: 'unavailable', candidate_count: null });
    expect((await read(NOW, place, [{ ...rows[0], capture_config_id: 'other-config' }])).vehicles.reason).toBe('no_field_sensor_windows');
    expect((await read(NOW, place, [{ ...rows[0], boot_id: crypto.randomUUID() }])).vehicles.reason).toBe('no_field_sensor_windows');
  });

  it('fails closed if retained private rows exceed the bounded address budget', async () => {
    const capture = await seed(Array.from({ length: 64 }, () => compact()));
    // Deliberately emulate corrupted imported storage; normal ingest rejects
    // the 65th record through the independent per-window budget trigger.
    state.db.exec('DROP TRIGGER ingestion_items_v2_budget');
    await commit(capture.config, 'address_summaries', [summaryItem(capture.window, 65, compact({ name_brand_mask: 1 }))]);
    expect((await read()).vehicles).toMatchObject({ status: 'unavailable', reason: 'input_limit_exceeded', candidate_count: null });
  });

  it('uses the unique private window identity index without the redundant prefix index', async () => {
    await seed([compact({ name_brand_mask: 1 })]);
    state.db.exec('DROP INDEX IF EXISTS ingestion_items_v2_window');
    const plans: string[] = [], original = state.env.DB.prepare.bind(state.env.DB);
    state.env.DB.prepare = ((sql: string) => {
      const statement = original(sql), bind = statement.bind.bind(statement);
      statement.bind = ((...values: unknown[]) => {
        if (sql.includes("i.stream='address_summaries'")) {
          plans.push(...state.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values as []).map(row => String(row.detail)));
        }
        return bind(...values as []);
      }) as typeof statement.bind;
      return statement;
    }) as typeof state.env.DB.prepare;
    expect((await read()).vehicles).toMatchObject({ status: 'candidate_estimate', candidate_count: 1 });
    expect(plans.join('\n')).toMatch(/SEARCH i USING INDEX sqlite_autoindex_ingestion_items_v2_2 \(node_id=\? AND boot_id=\? AND stream=\? AND window_seq=\?\)/);
    expect(plans.join('\n')).not.toMatch(/SCAN i|ingestion_items_v2_expiry/);
  });

  it('propagates storage errors instead of disguising them as no evidence', async () => {
    state.db.exec('DROP TABLE public_observation_projection');
    await expect(read()).rejects.toThrow(/public_observation_projection/);
  });
});

describe('public manual historical wait projection', () => {
  it('provides supported empirical quantiles with evidence expiry independent of sensor freshness', async () => {
    for (let i = 0; i < 5; i++) manual(i);
    const result = await read();
    expect(result.elevator).toMatchObject({ status: 'historical_estimate', source: 'manual_historical_baseline', wait_seconds: 20,
      range_seconds: { lower: 8, upper: 32 }, sample_count: 5, day_count: 2, reason: null, calibrated: false,
      observed_at: new Date(NOW - DAY).toISOString(), valid_until: new Date(NOW + 300000).toISOString() });
    expect(result.vehicles.reason).toBe('no_field_sensor_windows');
  });

  it('rejects small support, cancellations, future events, later receipts and other places', async () => {
    for (let i = 0; i < 4; i++) manual(i);
    manual(4, { observed: NOW + 1000 });
    manual(5, { received: NOW + 1000 });
    manual(6, { status: 'cancelled' });
    manual(7, { target: 'teaching-elevator' });
    expect((await read()).elevator).toMatchObject({ status: 'unavailable', sample_count: 4, reason: 'insufficient_samples', wait_seconds: null });
  });

  it('does not revive stale manual samples by generating a new result', async () => {
    for (let i = 0; i < 5; i++) manual(i, { observed: NOW - (8 + i % 2) * DAY });
    expect((await read()).elevator).toMatchObject({ reason: 'stale_manual_samples', wait_seconds: null, valid_until: null });
  });

  it('bounds SQL input and abstains rather than estimating from an arbitrary truncated subset', async () => {
    state.db.exec('BEGIN');
    for (let i = 0; i < 2001; i++) manual(i, { wait: i % 60 });
    state.db.exec('COMMIT');
    expect((await read()).elevator).toMatchObject({ status: 'unavailable', reason: 'input_limit_exceeded', wait_seconds: null });
  });
});
