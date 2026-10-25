import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { setup } from './helpers/ingestion';
import { seedElevatorSeries } from './helpers/elevator';

let state: Awaited<ReturnType<typeof setup>>;
const NOW = Date.parse('2026-10-25T06:00:00.000Z');
const ORIGIN = 'https://elevator-events.example.test';
const PLACE = 'teaching-elevator';
const endpoint = `/api/v1/places/${PLACE}/elevator-events`;
const request = (path = endpoint, init: RequestInit = {}) => worker.fetch(new Request(ORIGIN + path, init), state.env);

const seedSeries = (options: Parameters<typeof seedElevatorSeries>[2] = {}) => seedElevatorSeries(state, NOW, options);

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  state = await setup();
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('public elevator event projection from private v2 records', () => {
  it('reads committed field summaries and exposes only unverified aggregate candidates', async () => {
    await seedSeries();
    const response = await request();
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const result = JSON.parse(text);
    expect(result).toMatchObject({ place_id: PLACE, status: 'observing', truncated: false });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ lost_identifiers: 6, baseline_identifiers: 18, verification: 'unverified' });
    expect(Date.parse(result.events[0].event_to)).toBeLessThanOrEqual(NOW);
    expect(Date.parse(result.data_until)).toBeLessThanOrEqual(NOW);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(text).not.toContain('02:ee:');
    expect(text).not.toContain('elevator-fixture-node');
    expect(text).not.toContain('address_summaries');
    expect(text).not.toContain('item_json');
    expect(text).not.toContain('event_from_mono_ms');
  });

  it('never substitutes demo or controlled-test data into the public field endpoint', async () => {
    await seedSeries({ dataset: 'demo', prefix: 'demo' });
    await seedSeries({ dataset: 'controlled_test', prefix: 'controlled' });
    const result = await (await request()).json() as any;
    expect(result.status).toBe('unavailable');
    expect(result.events).toEqual([]);
    expect(result.data_until).toBeNull();
  });

  it('does not treat missing address summaries as a disappearance', async () => {
    await seedSeries({ incompleteWindow: 1 });
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
  });

  it('does not use a newer demo stream in place of an available field stream', async () => {
    await seedSeries();
    await seedSeries({ prefix: 'newer-demo', dataset: 'demo', firstEnd: NOW - 94_000 });
    const result = await (await request()).json() as any;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].lost_identifiers).toBe(6);
    expect(Date.parse(result.data_until)).toBe(NOW - 5_000);
  });

  it('requires node health evidence rather than inferring health from a quiet radio', async () => {
    await seedSeries({ noStatus: true });
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
    expect(result.status).toBe('degraded');
  });

  it('breaks a candidate at a device storage-loss increment', async () => {
    const { node } = await seedSeries();
    state.db.prepare("UPDATE ingestion_items_v2 SET item_json=json_set(item_json,'$.loss_totals.storage_drops',1) WHERE node_id=? AND stream='node_status' AND seq>=2")
      .run(node);
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
  });

  it.each(['lowScanWindow', 'overflowWindow'] as const)('rejects unhealthy evidence: %s', async (option) => {
    await seedSeries({ [option]: 1 });
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
  });

  it('excludes windows with unknown UTC rather than manufacturing a real-time date', async () => {
    await seedSeries({ unknownClock: true });
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
    expect(result.data_until).toBeNull();
  });

  it('breaks cohort evidence when UTC mapping jumps within the same clock epoch', async () => {
    await seedSeries({ clockShiftMs: -10_000 });
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
    // Later stable windows can recover observation; the pre-jump candidate
    // must not survive that recovery as an incorrectly dated event.
    expect(result.data_until).not.toBeNull();
  });

  it('does not publish future observations', async () => {
    await seedSeries({ firstEnd: NOW + 30_000 });
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
    expect(result.data_until).toBeNull();
  });

  it('checks actual receive availability, not just observation timestamps', async () => {
    await seedSeries({ futureReceived: true });
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
    expect(result.data_until).toBeNull();
  });

  it('does not present delayed old captures as fresh when they arrive now', async () => {
    await seedSeries({ firstEnd: NOW - 10 * 60_000 });
    const result = await (await request()).json() as any;
    expect(['stale', 'unavailable']).toContain(result.status);
    expect(result.valid_until === null || Date.parse(result.valid_until) <= NOW).toBe(true);
  });

  it('excludes expired private address evidence even when receipt metadata survives', async () => {
    const { node } = await seedSeries();
    state.db.prepare("UPDATE ingestion_items_v2 SET expires_at_ms=? WHERE node_id=? AND stream='address_summaries'").run(NOW - 1, node);
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
  });

  it('excludes data belonging to a different registered place', async () => {
    await seedSeries({ place: 'library' });
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
    expect(result.data_until).toBeNull();
  });

  it('honors immutable placement closures at the actual observation time', async () => {
    const { node, placement } = await seedSeries();
    state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
      .run(placement, node, NOW - 100_000, new Date(NOW - 100_000).toISOString());
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
    expect(result.data_until).toBeNull();
  });

  it('does not mix boot histories to assemble a disappearing cohort', async () => {
    await seedSeries({ newBootAt: 1 });
    const result = await (await request()).json() as any;
    expect(result.events).toEqual([]);
  });

  it('returns explicit unavailable data for an existing unconfigured elevator point', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ place_id: PLACE, status: 'unavailable', data_until: null, events: [] });
  });

  it('returns 404 for an unknown place and 422 for a non-elevator place', async () => {
    expect((await request('/api/v1/places/no-such-place/elevator-events')).status).toBe(404);
    expect((await request('/api/v1/places/library/elevator-events')).status).toBe(422);
  });

  it('never changes records on a write request to the read-only route', async () => {
    const response = await request(endpoint, { method: 'POST' });
    expect([404, 405]).toContain(response.status);
    expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_items_v2').get()?.n).toBe(0);
  });

  it('returns a retryable storage error without leaking private SQL or source data', async () => {
    const original = state.env.DB.prepare;
    state.env.DB.prepare = () => { throw new Error('synthetic private SQL failure'); };
    try {
      const response = await request();
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'storage_unavailable', retryable: true } });
      expect(text).not.toContain('private SQL');
    } finally { state.env.DB.prepare = original; }
  });
});
