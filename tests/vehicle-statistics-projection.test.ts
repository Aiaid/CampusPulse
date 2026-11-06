import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilityDigestV3 } from '../worker/device-v3-config';
import { V3_VEHICLE_CANDIDATE_RULESET } from '../worker/device-v3-statistics-validation';
import { handleDeviceV3Statistics } from '../worker/device-v3-statistics';
import { readPlaceStatistics } from '../worker/statistics-public';
import { projectVehicleStatistics } from '../worker/vehicle-statistics-projection';
import { readAutomaticObservations } from '../worker/place-inference';
import type { Place } from '../worker/types';
import type { DeviceV3StatisticsEnv } from '../worker/device-v3-statistics-policy';
import { sha256 } from '../worker/http';
import { setup, DEVICE_TOKEN } from './helpers/ingestion';
import { statisticsFixture, statisticsBatch, seedStatistics } from './helpers/v3-statistics-fixtures';

let state: Awaited<ReturnType<typeof setup>>, env: DeviceV3StatisticsEnv;
const nodes = ['sim-live-20261106-01', 'sim-live-20261106-02'];
const place = (id = 'east-parking'): Place => ({ id, name: 'Synthetic projection fixture', kind: 'parking',
  observation_kinds: ['parking'], anchor: { x: 0, y: 0 }, coverage: 'unconfigured' });
beforeEach(async () => {
  state = await setup();
  env = { ...state.env, DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true',
    DEVICE_V3_PRODUCER_VERSIONS: '["cp-v3-small/1"]', DEVICE_V3_SIMULATOR_NODE_IDS: JSON.stringify(nodes),
    DEVICE_V3_INGEST_ENABLED: 'false', CPRAW_ARCHIVE_ENABLED: '0' };
});
afterEach(() => state.db.close());
async function upload({ node = nodes[0], target = 'east-parking', bike = 1, car = 1, uncertainty = 0,
  partial = false, visible = 2, producer = 'synthetic-statistics/1', rules = V3_VEHICLE_CANDIDATE_RULESET as string } = {}) {
  const token = `${DEVICE_TOKEN}-${node}`;
  await env.DB.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)')
    .bind(node, await sha256(new TextEncoder().encode(token))).run();
  const placement = `${node}-placement`;
  await env.DB.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)').bind(placement, node, target).run();
  const source = await statisticsFixture(node, placement);
  source.caps.producer_version = producer; source.caps.statistics!.ruleset_versions = [rules];
  source.caps.uplink!.transports = ['mqtt_tls'];
  source.policy.custody.dataset = 'field'; source.policy.custody.purpose = 'site_observation';
  if (!source.policy.uplink.enabled || source.policy.evidence.mode !== 'statistics') throw Error('fixture');
  source.policy.uplink.transport = 'mqtt_tls'; source.policy.evidence.ruleset_version = rules;
  source.policy.control.capability_sha256 = await capabilityDigestV3(source.caps);
  await seedStatistics(env.DB, source);
  const batch = await statisticsBatch(source);
  batch.x[0].v[1] = rules; batch.x[0].c = [0, bike, car, 0, visible - bike - car, 0];
  batch.x[0].x[0][1] = visible;
  batch.x[0].t[3] = uncertainty; batch.x[0].f = uncertainty ? 2 : 0;
  if (partial) { batch.x[0].l[0] = 900; batch.x[0].f |= 4; }
  const body = JSON.stringify(batch);
  const response = await handleDeviceV3Statistics(new Request('https://synthetic.test/api/v3/statistics/ingest', {
    method: 'POST', body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Body-SHA256': await sha256(new TextEncoder().encode(body)) },
  }), env);
  expect(response?.status, await response?.clone().text()).toBe(200);
  return source;
}

describe('authoritative compact vehicle projections', () => {
  it('projects two approved virtual devices independently at separate places', async () => {
    await env.DB.prepare("INSERT INTO places(id,name,kind,anchor_x,anchor_y) VALUES('synthetic-parking','Synthetic second site','parking',0,0)").run();
    await upload(); await upload({ node: nodes[1], target: 'synthetic-parking', bike: 0, car: 1 });
    const first = await readAutomaticObservations(env, place(), [], Date.now());
    const second = await readAutomaticObservations(env, place('synthetic-parking'), [], Date.now());
    expect(first.vehicles).toMatchObject({ status: 'candidate_estimate', candidate_count: 1, car_related_count: 1,
      ecosystem_count: 0, sample_count: 2, model_version: V3_VEHICLE_CANDIDATE_RULESET, evidence_kind: 'compact', reason: null });
    expect(second.vehicles).toMatchObject({ candidate_count: 0, car_related_count: 1, sample_count: 2 });
    expect(JSON.stringify([first, second])).not.toMatch(/"(?:node_id|boot_id|address|token|estimated_total|calibration)"\s*:/);
  });
  it('projects the same reviewed ruleset for the unchanged ordinary producer', async () => {
    await upload({ node: 'ordinary-fixture', producer: 'cp-v3-small/1' });
    expect((await readAutomaticObservations(env, place(), [], Date.now())).vehicles).toMatchObject({
      status: 'candidate_estimate', candidate_count: 1, car_related_count: 1 });
  });
  it('preserves bounded clock uncertainty in the candidate result', async () => {
    await upload({ uncertainty: 50 });
    expect((await readAutomaticObservations(env, place(), [], Date.now())).vehicles).toMatchObject({
      status: 'candidate_estimate', quality_flags: ['uncertain_clock'] });
  });
  it('does not turn unclassified unknowns into zero vehicles', async () => {
    await upload({ bike: 0, car: 0, rules: 'unclassified-v1' });
    expect((await readAutomaticObservations(env, place(), [], Date.now())).vehicles).toMatchObject({
      status: 'unavailable', reason: 'classification_unavailable', candidate_count: null, car_related_count: null });
  });
  it('keeps a complete zero-positive classified window distinct from unknown classification', async () => {
    await upload({ bike: 0, car: 0 });
    expect((await readAutomaticObservations(env, place(), [], Date.now())).vehicles).toMatchObject({
      status: 'candidate_estimate', candidate_count: 0, car_related_count: 0, sample_count: 2 });
  });
  it('withholds a complete empty window instead of producing an invalid zero-sample candidate record', async () => {
    await upload({ bike: 0, car: 0, visible: 0 });
    const statistics = await readPlaceStatistics(env, 'east-parking');
    expect(statistics).toMatchObject({ state: 'observed', visible_identifiers: 0 });
    expect(projectVehicleStatistics(statistics, Date.now())).toBeNull();
    expect((await readAutomaticObservations(env, place(), [], Date.now())).vehicles).toMatchObject({
      status: 'unavailable', candidate_count: null, car_related_count: null, sample_count: 0 });
  });
  it.each(['partial', 'stale', 'lease', 'disabled', 'unapproved_node', 'closed_placement', 'clock_out_of_bounds'])('%s sources never become vehicle candidates', async kind => {
    const source = await upload({ partial: kind === 'partial' });
    if (kind === 'lease') state.db.prepare('DELETE FROM device_statistics_lease_spans_v3').run();
    if (kind === 'disabled') state.db.prepare('UPDATE device_nodes SET enabled=0').run();
    if (kind === 'unapproved_node') env.DEVICE_V3_SIMULATOR_NODE_IDS = '[]';
    if (kind === 'closed_placement') state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
      .run(source.policy.custody.placement_id, source.policy.node_id, Date.now() - 1, new Date().toISOString());
    if (kind === 'clock_out_of_bounds') state.db.prepare('UPDATE statistics_windows_v3 SET uncertainty_ms=5001').run();
    const now = Date.now() + (kind === 'stale' ? 100000 : 0);
    expect((await readAutomaticObservations(env, place(), [], now)).vehicles.status).toBe('unavailable');
  });
  it('requires parking purpose and leaves manual observations untouched', async () => {
    await upload();
    state.db.prepare(`INSERT INTO observations(id,place_id,kind,observed_at,valid_until,received_at,parking_min,parking_max)
      VALUES('synthetic-manual','east-parking','parking',?,?,?,4,8)`)
      .run(new Date().toISOString(), new Date(Date.now() + 60000).toISOString(), new Date().toISOString());
    const before = state.db.prepare('SELECT * FROM observations').all();
    expect((await readAutomaticObservations(env, { ...place(), observation_kinds: ['activity'] }, [], Date.now())).vehicles)
      .toMatchObject({ status: 'unavailable', reason: 'purpose_not_enabled' });
    await readAutomaticObservations(env, place(), [], Date.now());
    expect(state.db.prepare('SELECT * FROM observations').all()).toEqual(before);
  });
  it('defensively withholds a future or quality-limited aggregate', async () => {
    await upload(); const now = Date.now(), statistics = await readPlaceStatistics(env, 'east-parking', now);
    if (!('versions' in statistics)) throw Error('fixture');
    expect(projectVehicleStatistics({ ...statistics, observed_at: new Date(now + 1).toISOString() }, now)).toBeNull();
    expect(projectVehicleStatistics({ ...statistics, quality: { ...statistics.quality, flags: ['unknown_quality'] } }, now)).toBeNull();
    expect(projectVehicleStatistics({ ...statistics, quality: { ...statistics.quality, callback_drops: 1 } }, now)).toBeNull();
  });
});
