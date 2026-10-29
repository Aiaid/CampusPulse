import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLastReportedSensor, readPublicWindows } from '../worker/sensors';
import { fixture, seedConfig, setup } from './helpers/ingestion';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
let state: Awaited<ReturnType<typeof setup>>;
const plans: string[] = [];
let candidates = 0;
beforeEach(async () => {
  state = await setup();
  // Synthetic retained storage fixtures avoid ingest cost; separate ingestion
  // suites verify immutable envelopes and private per-window budget triggers.
  state.db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER ingestion_items_v2_budget; DROP TRIGGER ingestion_items_v2_summary_consistency');
  state.db.function('count_public_candidate', (expiry: unknown) => { candidates++; return Number(expiry); });
  plans.length = 0; candidates = 0;
  const original = state.env.DB.prepare.bind(state.env.DB);
  state.env.DB.prepare = ((sql: string) => {
    const statement = original(sql.replaceAll('candidate.expires_at_ms > ?', 'count_public_candidate(candidate.expires_at_ms) > ?'));
    const bind = statement.bind.bind(statement);
    statement.bind = ((...values: unknown[]) => {
      if (sql.includes('candidate.rowid')) {
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
    .run(scope.node, 'synthetic-boot', options.stream ?? 'ble_windows', seq, 'synthetic-batch', scope.placement, scope.config,
      'field', item.time.utc_ms, item.duration_ms, seq, JSON.stringify(item), new Date(options.received ?? NOW - 1).toISOString(), options.expiry ?? NOW + 86400000);
}
function addPrivateNoise(scope: ReturnType<typeof register>) {
  state.db.prepare(`WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter WHERE n<30000)
    INSERT INTO ingestion_items_v2(node_id,boot_id,stream,seq,batch_id,placement_id,capture_config_id,dataset,
      utc_ms,duration_ms,window_seq,item_json,received_at,expires_at_ms)
    SELECT ?,'synthetic-noise','address_summaries',n,'synthetic-noise',?,?,'field',?,30000,n,'{}',?,? FROM counter`)
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
    expect(candidates, plans.join('\n')).toBeLessThanOrEqual(3 * 201);
    expect(plans.join('\n')).toContain('ingestion_items_v2_public_time');
    expect(plans.join('\n')).not.toMatch(/ingestion_items_v2_expiry|sensor_windows|SCAN candidate|TEMP B-TREE FOR LAST/);
    expect(plans.join('\n')).toMatch(/SEARCH w USING INTEGER PRIMARY KEY/);
  });

  it('applies quality, expiry and placement closure before each local limit', async () => {
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

  it('finds the global receipt winner with one eligible fallback per placement', async () => {
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
    expect(candidates, plans.join('\n')).toBeLessThanOrEqual(2);
    expect(plans.join('\n')).toContain('ingestion_items_v2_public_receipt');
    expect(plans.join('\n')).not.toMatch(/ingestion_items_v2_expiry|sensor_windows|SCAN candidate|TEMP B-TREE FOR LAST/);
  });
});
