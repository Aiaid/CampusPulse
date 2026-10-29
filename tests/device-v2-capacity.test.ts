import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { sha256 } from '../worker/ingest';
import { createOpenApiDocument } from '../worker/openapi';
import { validateCaptureConfigV2, type CaptureConfigV2 } from '../worker/device-v2-validation';
import { DEVICE_TOKEN, fixture, setup } from './helpers/ingestion';

let state: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { state = await setup(); });
afterEach(() => { state.db.close(); });

function policy(capacity: number, window = 60000): CaptureConfigV2 {
  const config = fixture('capture-config-v2.fixture');
  config.capture_config_id = `bounded-${capacity}-${window}`;
  config.accept_until = new Date(Date.now() + 86400000).toISOString();
  config.summary = { max_addresses: capacity, window_ms: window, bin_ms: window / 3 };
  config.upload_policy.max_items = 16;
  config.upload_policy.max_body_bytes = 4096;
  return config;
}

describe('bounded 128-address v2 policy', () => {
  it('accepts 128 and both three-bin trials while rejecting larger or fractional capacities', () => {
    for (const window of [60000, 120000]) {
      const config = policy(128, window);
      expect(validateCaptureConfigV2(config)).toEqual(config);
    }
    for (const capacity of [0, 128.5, 129, 256]) {
      expect(() => validateCaptureConfigV2(policy(capacity))).toThrow();
    }
    expect(createOpenApiDocument()).toHaveProperty(
      'components.schemas.CaptureConfigV2.properties.summary.properties.max_addresses.maximum', 128);
  });

  it.each([64, 128])('commits exactly %i distinct summaries across bounded bodies and rejects the next address', async capacity => {
    const config = validateCaptureConfigV2(policy(capacity));
    state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
      .run(config.capture_config_id, config.node_id, config.placement_id, config.dataset,
        JSON.stringify(config), Date.parse(config.accept_until));
    state.db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)')
      .run(config.node_id, config.capture_config_id, new Date().toISOString());
    const template = fixture('address-summaries-v2.request');
    template.capture_config_id = config.capture_config_id;
    const item = template.items[0];
    Object.assign(item, { duration_ms: 60000, bin_ms: 20000, first_offset_ms: 1,
      last_offset_ms: 40001, bins: [2, 2, 2], time: { ...item.time, mono_ms: 61000 } });
    const request = (first: number, count: number) => ({ ...template, batch_id: crypto.randomUUID(),
      items: Array.from({ length: count }, (_, index) => ({ ...structuredClone(item), seq: first + index,
        address: `02:00:00:00:00:${(first + index).toString(16).padStart(2, '0')}` })) });
    async function upload(batch: unknown) {
      const body = JSON.stringify(batch), bytes = new TextEncoder().encode(body);
      expect(bytes.length).toBeLessThanOrEqual(4096);
      return worker.fetch(new Request('https://capacity.example.test/api/v2/ingest', {
        method: 'POST', body, headers: { Authorization: `Bearer ${DEVICE_TOKEN}`,
          'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(bytes) },
      }), state.env);
    }
    const first = request(1, 4);
    let firstAck: unknown;
    for (let start = 1; start <= capacity; start += 4) {
      const response = await upload(start === 1 ? first : request(start, 4));
      const ack = await response.json();
      expect(response.status, JSON.stringify(ack)).toBe(200);
      expect(ack).toMatchObject({ accepted_count: 4, durability: 'committed' });
      if (start === 1) firstAck = ack;
    }
    const retry = await upload(first);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstAck);
    const overflow = await upload(request(capacity + 1, 1));
    expect(overflow.status).toBe(409);
    expect(await overflow.json()).toMatchObject({ error: { code: 'window_evidence_conflict' } });
    expect(state.db.prepare("SELECT COUNT(*) count, COUNT(DISTINCT address) addresses FROM ingestion_items_v2 WHERE stream='address_summaries'").get())
      .toMatchObject({ count: capacity, addresses: capacity });
    expect(state.db.prepare('SELECT COUNT(*) count FROM ingestion_batches_v2').get())
      .toMatchObject({ count: capacity / 4 });
  });
});
