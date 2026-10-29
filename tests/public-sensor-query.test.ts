import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLastReportedSensor, readPublicWindows } from '../worker/sensors';
import { fixture, seedConfig, setup } from './helpers/ingestion';
import { FALLBACK_SOURCE_SQL, WINDOW_SOURCE_SQL } from './helpers/public-projection-oracle';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
let state: Awaited<ReturnType<typeof setup>>;
const plans: string[] = [];
let candidates = 0;
beforeEach(async () => {
  state = await setup();
  // Synthetic retained storage fixtures avoid ingest cost; separate ingestion
  // suites verify immutable envelopes and private per-window budget triggers.
  state.db.exec('DROP TRIGGER ingestion_items_v2_budget; DROP TRIGGER ingestion_items_v2_summary_consistency');
  state.db.function('count_public_candidate', (expiry: unknown) => { candidates++; return Number(expiry); });
  plans.length = 0; candidates = 0;
  const original = state.env.DB.prepare.bind(state.env.DB);
  state.env.DB.prepare = ((sql: string) => {
    const statement = original(sql.replaceAll('w.expires_at_ms > ?', 'count_public_candidate(w.expires_at_ms) > ?'));
    const bind = statement.bind.bind(statement);
    statement.bind = ((...values: unknown[]) => {
      if (sql.includes('FROM public_sensor_projection_v2')) {
        const queryPlan = state.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values as []);
        plans.push(...queryPlan.map(row => String(row.detail)));
      }
      return bind(...values as []);
    }) as typeof statement.bind;
    return statement;
  }) as typeof state.env.DB.prepare;
});
afterEach(() => state.db.close());
function register(index: number, place = 'library') {
  const node = `synthetic-public-${index}`, placement = `synthetic-placement-${index}`;
  state.db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').run(node, String(index).padStart(64, '0'));
  state.db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)').run(placement, node, place, 0);
  const config = { ...fixture('capture-config-v2.fixture'), node_id: node, placement_id: placement,
    capture_config_id: `synthetic-config-${index}`, dataset: 'field', accept_until: new Date(NOW + 86400000).toISOString() };
  seedConfig(state.db, config);
  for (const [stream, boot] of [['ble_windows', 'synthetic-boot'], ['address_summaries', 'synthetic-noise']]) {
    state.db.prepare(`INSERT INTO ingestion_batches_v2(node_id,batch_id,receipt_id,body_sha256,boot_id,stream,
      seq_first,seq_last,accepted_count,placement_id,capture_config_id,dataset,firmware_version,received_at,expires_at_ms,retain_until_ms)
      VALUES(?,?,?,?,?,?,1,4294967295,1,?,?,'field','synthetic-projection-test',?,?,?)`)
      .run(node, stream, crypto.randomUUID(), 'a'.repeat(64), boot, stream, placement, config.capture_config_id,
        new Date(NOW).toISOString(), NOW + 86400000, NOW + 86400000);
  }
  return { node, placement, config: config.capture_config_id };
}
function insert(scope: ReturnType<typeof register>, seq: number, options: {
  utc?: number | null; received?: number; flags?: string[]; expiry?: number; stream?: string;
} = {}) {
  const item = fixture('ble-windows-v2.request').items[0];
  item.seq = seq;
  item.time.utc_ms = options.utc === undefined ? NOW - seq * 1000 : options.utc;
  item.time.uncertainty_ms = item.time.utc_ms === null ? null : 10;
  item.quality_flags = options.flags ?? [];
  state.db.prepare(`INSERT INTO ingestion_items_v2(node_id,boot_id,stream,seq,batch_id,placement_id,capture_config_id,dataset,
    utc_ms,duration_ms,window_seq,item_json,received_at,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(scope.node, 'synthetic-boot', options.stream ?? 'ble_windows', seq, options.stream ?? 'ble_windows', scope.placement, scope.config,
      'field', item.time.utc_ms, item.duration_ms, seq, JSON.stringify(item), new Date(options.received ?? NOW - 1).toISOString(), options.expiry ?? NOW + 86400000);
}
function addPrivateNoise(scope: ReturnType<typeof register>) {
  state.db.prepare(`WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter WHERE n<30000)
    INSERT INTO ingestion_items_v2(node_id,boot_id,stream,seq,batch_id,placement_id,capture_config_id,dataset,
      utc_ms,duration_ms,window_seq,item_json,received_at,expires_at_ms)
    SELECT ?,'synthetic-noise','address_summaries',n,'address_summaries',?,?,'field',?,30000,n,'{}',?,? FROM counter`)
    .run(scope.node, scope.placement, scope.config, NOW, new Date(NOW).toISOString(), NOW + 86400000);
}

describe('bounded v2 public sensor queries', () => {
  it('merges exact global top201 across placements without visiting private retained rows', async () => {
    const scopes = [register(1), register(2), register(3)], elsewhere = register(4, 'east-parking');
    state.db.exec('BEGIN');
    for (const [index, scope] of scopes.entries()) {
      for (let seq = 1; seq <= 400; seq++) insert(scope, seq, { utc: NOW - Math.floor(seq / 3) * 1000 - index });
    }
    for (let seq = 1; seq <= 400; seq++) insert(elsewhere, seq, { utc: NOW - seq });
    addPrivateNoise(scopes[0]);
    state.db.exec('COMMIT');
    const expected = state.db.prepare(`SELECT w.node_id,w.seq FROM ingestion_items_v2 w JOIN placements p ON p.id=w.placement_id
      WHERE p.place_id='library' AND w.stream='ble_windows' ORDER BY w.utc_ms DESC,w.node_id,w.seq DESC LIMIT 201`).all();
    const windows = await readPublicWindows(state.env, 'library', NOW - 86400000, NOW);
    expect(windows.map(({ node_id, seq }) => ({ node_id, seq }))).toEqual(expected);
    expect(windows).toHaveLength(201);
    expect(candidates, plans.join('\n')).toBeLessThanOrEqual(201);
    expect(plans.join('\n')).toContain('public_sensor_projection_v2_time');
    expect(plans.join('\n')).not.toMatch(/ingestion_items_v2|sensor_windows|SCAN w|TEMP B-TREE/);
    expect(state.db.prepare('SELECT COUNT(*) n FROM public_sensor_projection_v2').get()?.n).toBe(1600);
    expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_items_v2').get()?.n).toBe(31600);
  });

  it('applies materialized quality and placement validity before the global limit', async () => {
    const scope = register(1), closed = register(2);
    state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
      .run(closed.placement, closed.node, NOW - 10000, new Date(NOW).toISOString());
    state.db.exec('BEGIN');
    // More rejected rows than the result limit must never hide eligible rows.
    for (let seq = 1; seq <= 220; seq++) insert(scope, seq, { flags: ['utc_jump'] });
    insert(scope, 221, { expiry: NOW });
    insert(scope, 222);
    insert(closed, 1, { utc: NOW - 1000 });
    insert(closed, 2, { utc: NOW - 20000 });
    state.db.exec('COMMIT');
    expect((await readPublicWindows(state.env, 'library', NOW - 86400000, NOW)).map(row => [row.node_id, row.seq]))
      .toEqual([[closed.node, 2], [scope.node, 222]]);
  });

  it('skips invalid dates, future receipts and disallowed flags before selecting a fallback', async () => {
    const scope = register(1);
    insert(scope, 1, { utc: null, received: NOW - 10 });
    insert(scope, 2, { utc: 8640000000000001, received: NOW, flags: ['utc_jump'] });
    insert(scope, 3, { utc: null, received: NOW + 1 });
    insert(scope, 4, { utc: null, received: NOW, flags: ['unknown_quality_flag'] });
    expect(await readLastReportedSensor(state.env, 'library', NOW)).toMatchObject({ seq: 1, observed_at: null, time_status: 'unknown' });
  });

  it('finds the global receipt winner with a single place-wide indexed candidate', async () => {
    const scopes = [register(1), register(2)];
    state.db.exec('BEGIN');
    for (const scope of scopes) {
      for (let seq = 1; seq <= 500; seq++) insert(scope, seq, { utc: null, received: NOW - seq });
    }
    insert(scopes[0], 501, { utc: null, received: NOW });
    insert(scopes[1], 501, { utc: null, received: NOW });
    addPrivateNoise(scopes[0]);
    state.db.exec('COMMIT');
    const result = await readLastReportedSensor(state.env, 'library', NOW);
    expect(result).toMatchObject({ node_id: scopes[0].node, seq: 501, observed_at: null, time_status: 'unknown', freshness: 'unverified' });
    expect(candidates, plans.join('\n')).toBeLessThanOrEqual(1);
    expect(plans.join('\n')).toContain('public_sensor_projection_v2_receipt');
    expect(plans.join('\n')).not.toMatch(/ingestion_items_v2|sensor_windows|SCAN w|TEMP B-TREE/);
  });
});

// Independent canonical SQL is the acceptance oracle for the derived cache.
// It deliberately performs the original joins/JSON guards at read time.
function canonicalTimed(place: string, from: number, now: number): any[] {
  return state.db.prepare(WINDOW_SOURCE_SQL).all(place, from, now, now);
}
function canonicalFallback(place: string, now: number): any {
  return state.db.prepare(FALLBACK_SOURCE_SQL)
    .get(place, now, now, new Date(now).toISOString());
}
function expectedWindow(row: any, now: number, fallback = false) {
  if (!row) return null;
  const item = JSON.parse(row.item_json), valid = row.utc_ms - item.time.uncertainty_ms + 90000;
  return {
    node_id: row.node_id, boot_id: row.boot_id, placement_id: row.placement_id, capture_config_id: row.capture_config_id,
    source: 'sensor', dataset: 'field', seq: item.seq,
    observed_at: row.utc_ms === null ? null : new Date(row.utc_ms).toISOString(),
    valid_until: fallback ? null : new Date(valid).toISOString(), uncertainty_ms: item.time.uncertainty_ms,
    duration_ms: item.duration_ms, scan_enabled_ms: item.scan_enabled_ms, reports_aggregated: item.reports_aggregated,
    visible_identifiers: item.visible_identifiers, unique_table_overflow: item.unique_table_overflow,
    aggregation_drops: item.aggregation_drops, quality_flags: item.quality_flags,
    freshness: fallback ? 'unverified' : valid > now ? 'fresh' : 'stale',
    ...(fallback ? { received_at: row.received_at, time_status: row.utc_ms === null ? 'unknown' : 'uncertain' } : {}),
  };
}
async function expectCanonical(place = 'library', from = NOW - 86400000, now = NOW) {
  expect(await readPublicWindows(state.env, place, from, now)).toEqual(canonicalTimed(place, from, now).map(row => expectedWindow(row, now)));
  expect(await readLastReportedSensor(state.env, place, now)).toEqual(expectedWindow(canonicalFallback(place, now), now, true));
}

describe('incremental sensor projection canonical parity', () => {
  it('preserves historical backfill, tied receipts, future rows and dynamic freshness/expiry/ranges', async () => {
    const first = register(1), second = register(2), elsewhere = register(3, 'east-parking');
    insert(first, 1, { utc: NOW - 190000 });
    insert(first, 2, { utc: NOW - 1000, expiry: NOW + 1000 });
    insert(first, 3, { utc: NOW + 1000 });
    insert(first, 4, { utc: null, received: NOW });
    insert(second, 4, { utc: null, received: NOW });
    insert(second, 6, { utc: null, received: NOW + 1000 });
    insert(elsewhere, 1, { utc: NOW - 10 });
    // A delayed row shares the same server receipt and has older capture time.
    insert(first, 5, { utc: NOW - 180000, received: NOW });
    for (const now of [NOW, NOW + 1001, NOW + 100000, NOW + 86400000]) {
      await expectCanonical('library', NOW - 86400000, now);
      await expectCanonical('library', NOW - 10000, now);
      await expectCanonical('east-parking', NOW - 86400000, now);
    }
  });

  it('reclassifies already retained timed and receipt rows when a closure is appended', async () => {
    const scope = register(1);
    insert(scope, 1, { utc: NOW - 20000, received: NOW - 15000 });
    insert(scope, 2, { utc: NOW - 5000, received: NOW - 4000 });
    insert(scope, 3, { utc: null, received: NOW - 15000 });
    insert(scope, 4, { utc: null, received: NOW - 10000 });
    await expectCanonical();
    state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
      .run(scope.placement, scope.node, NOW - 10000, new Date(NOW).toISOString());
    await expectCanonical();
    expect((await readPublicWindows(state.env, 'library', NOW - 86400000, NOW)).map(row => row.seq)).toEqual([1]);
    expect(await readLastReportedSensor(state.env, 'library', NOW)).toMatchObject({ seq: 3 });
  });

  it('repairs changed canonical rows and removes deleted rows through source identity', async () => {
    const scope = register(1);
    insert(scope, 1, { utc: null });
    await expectCanonical();
    const row = state.db.prepare("SELECT item_json FROM ingestion_items_v2 WHERE node_id=? AND stream='ble_windows'").get(scope.node);
    const item = JSON.parse(String(row?.item_json));
    item.time = { ...item.time, utc_ms: NOW - 1000, uncertainty_ms: 10 };
    item.visible_identifiers = 7;
    state.db.prepare("UPDATE ingestion_items_v2 SET utc_ms=?,item_json=? WHERE node_id=? AND stream='ble_windows'")
      .run(item.time.utc_ms, JSON.stringify(item), scope.node);
    await expectCanonical();
    expect((await readPublicWindows(state.env, 'library', NOW - 86400000, NOW))[0]).toMatchObject({ visible_identifiers: 7 });
    expect(await readLastReportedSensor(state.env, 'library', NOW)).toBeNull();
    state.db.prepare("UPDATE ingestion_items_v2 SET expires_at_ms=? WHERE node_id=? AND stream='ble_windows'").run(NOW, scope.node);
    await expectCanonical();
    state.db.prepare("DELETE FROM ingestion_items_v2 WHERE node_id=? AND stream='ble_windows'").run(scope.node);
    await expectCanonical();
    expect(state.db.prepare('SELECT COUNT(*) n FROM public_sensor_projection_v2').get()?.n).toBe(0);
  });

  it('does not lose valid backfill behind more than500 expired projection heads', async () => {
    const scope = register(1);
    state.db.exec('BEGIN');
    for (let seq = 1; seq <= 550; seq++) insert(scope, seq, { expiry: NOW });
    insert(scope, 551);
    state.db.exec('COMMIT');
    await expectCanonical();
    expect((await readPublicWindows(state.env, 'library', NOW - 86400000, NOW)).map(row => row.seq)).toEqual([551]);
    // These checks are intentionally not capped: expired heads are filtered at
    // read time and can cost reads until retention physically removes them.
    expect(candidates).toBeGreaterThan(500);
  });
});
