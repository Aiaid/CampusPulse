import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import worker from '../worker/index';
import { sha256 } from '../worker/ingest';
import { validateCaptureConfigV2, validateEnvelopeV2, type CaptureConfigV2 } from '../worker/device-v2-validation';
import { COMPACT_VEHICLE_SCHEMA_VERSION } from '../worker/vehicle-rules';
import { DEVICE_TOKEN, fixture, setup } from './helpers/ingestion';

let state: Awaited<ReturnType<typeof setup>>;
let config: CaptureConfigV2;
const origin = 'https://compact-vehicle.example.test';
const fetchWorker = (path: string, init: RequestInit = {}) => worker.fetch(new Request(origin + path, init), state.env);
const upload = async (body: unknown) => {
  const bytes = JSON.stringify(body);
  return fetchWorker('/api/v2/ingest', { method: 'POST', body: bytes, headers: {
    Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json',
    'X-Body-SHA256': await sha256(new TextEncoder().encode(bytes)),
  } });
};
async function data(response: Response, status = 200): Promise<any> {
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  return value;
}
function batch(withEvidence = true) {
  const body = fixture('address-summaries-v2.request');
  body.capture_config_id = config.capture_config_id;
  body.dataset = config.dataset;
  if (withEvidence) body.items[0].vehicle_evidence = {
    schema_version: COMPACT_VEHICLE_SCHEMA_VERSION,
    parsed_reports: body.items[0].reports, malformed_reports: 0,
    name_brand_mask: 1, exclusion_mask: 0, ecosystem_mask: 0,
  };
  return body;
}
beforeEach(async () => {
  state = await setup();
  config = fixture('capture-config-v2.fixture');
  config.capture_config_id = 'compact-vehicle-field-v2';
  config.dataset = 'field';
  config.accept_until = new Date(Date.now() + 86_400_000).toISOString();
  state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
    .run(config.capture_config_id, config.node_id, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until));
  state.db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)')
    .run(config.node_id, config.capture_config_id, new Date().toISOString());
});
afterEach(() => state.db.close());

describe('optional compact vehicle evidence ingestion', () => {
  test('commits compact evidence with raw disabled and preserves exact retries and byte conflicts', async () => {
    expect(validateCaptureConfigV2(config).allowed_streams).toEqual(['ble_windows', 'address_summaries', 'node_status']);
    expect(config.raw_capture).toEqual({ mode: 'off' });
    const body = batch();
    const ack = await data(await upload(body));
    expect(ack).toMatchObject({ stream: 'address_summaries', accepted_count: 1, durability: 'committed' });
    expect(await data(await upload(body))).toEqual(ack);
    const changed = structuredClone(body);
    changed.items[0].vehicle_evidence.name_brand_mask = 2;
    await data(await upload(changed), 409);
    expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(1);
    const stored = state.db.prepare("SELECT item_json FROM ingestion_items_v2 WHERE stream='address_summaries'").get();
    expect(JSON.parse(String(stored?.item_json)).vehicle_evidence).toEqual(body.items[0].vehicle_evidence);
    expect(state.raw.objects.size).toBe(0);
    const raw = fixture('ble-reports.request');
    Object.assign(raw, { protocol: 'campuspulse/2', capture_config_id: config.capture_config_id, dataset: config.dataset });
    await data(await upload(raw), 422);
  });

  test('keeps older absent feature input valid and does not turn it into empty evidence', async () => {
    const body = batch(false);
    const parsed = validateEnvelopeV2(body);
    expect(parsed.items[0]).not.toHaveProperty('vehicle_evidence');
    await data(await upload(body));
    const stored = state.db.prepare("SELECT item_json FROM ingestion_items_v2 WHERE stream='address_summaries'").get();
    expect(JSON.parse(String(stored?.item_json))).not.toHaveProperty('vehicle_evidence');
  });

  test('accepts all defined mask bits, exact report accounting and the uint32 boundary', () => {
    const body = batch();
    const item = body.items[0];
    item.reports = 0xffffffff;
    item.adv_reports = 0xffffffff;
    item.scan_response_reports = 0;
    item.bins = item.bins.map((_: number, index: number) => index === 0 ? 1 : index === item.bins.length - 1 ? 0xfffffffe : 0);
    Object.assign(item.vehicle_evidence, { parsed_reports: 0xfffffffe, malformed_reports: 1, name_brand_mask: (1 << 20) - 1, exclusion_mask: 2047, ecosystem_mask: 3 });
    expect(validateEnvelopeV2(body).items[0]).toMatchObject({ vehicle_evidence: item.vehicle_evidence });
  });

  test.each([
    ['version', (v: any) => { v.schema_version = 'radar-compact-v2'; }],
    ['missing field', (v: any) => { delete v.ecosystem_mask; }],
    ['null', (_v: any, item: any) => { item.vehicle_evidence = null; }],
    ['raw name', (v: any) => { v.name = 'synthetic-observed-name'; }],
    ['raw payload', (v: any) => { v.payload_hex = '00'; }],
    ['extra address', (v: any) => { v.address = '02:00:00:00:00:02'; }],
    ['brand mask overflow', (v: any) => { v.name_brand_mask = 1 << 20; }],
    ['exclusion mask overflow', (v: any) => { v.exclusion_mask = 2048; }],
    ['ecosystem mask overflow', (v: any) => { v.ecosystem_mask = 4; }],
    ['negative mask', (v: any) => { v.name_brand_mask = -1; }],
    ['fractional mask', (v: any) => { v.exclusion_mask = 0.5; }],
    ['uint32 report overflow', (v: any) => { v.parsed_reports = 0x100000000; }],
    ['uint32 malformed overflow', (v: any) => { v.malformed_reports = 0x100000000; }],
    ['mismatched report sum', (v: any) => { v.malformed_reports = 1; }],
    ['fractional count', (v: any) => { v.parsed_reports = 0.5; }],
  ])('rejects %s atomically through the real ingestion route', async (_name, mutate) => {
    const body = batch();
    mutate(body.items[0].vehicle_evidence, body.items[0]);
    expect(() => validateEnvelopeV2(body)).toThrow();
    await data(await upload(body), 422);
    expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_items_v2').get()?.n).toBe(0);
  });

  test('keeps compact masks and address identifiers out of public summary and history', async () => {
    const body = batch();
    const window = fixture('ble-windows-v2.request');
    Object.assign(window, { capture_config_id: config.capture_config_id, dataset: config.dataset });
    body.items[0].time.utc_ms = Date.now() - 1000;
    body.items[0].time.uncertainty_ms = 10;
    window.items[0].time = body.items[0].time;
    await data(await upload(window));
    await data(await upload(body));
    const privateBatch = await data(await fetchWorker(`/api/v2/research/batches/${body.batch_id}?node_id=${body.node_id}`, { headers: { Authorization: `Bearer ${state.env.RESEARCH_TOKEN}` } }));
    expect(privateBatch.items[0].vehicle_evidence).toEqual(body.items[0].vehicle_evidence);
    for (const path of ['/summary', '/history']) {
      const result = await data(await fetchWorker('/api/v1/places/library' + path));
      if (path === '/summary') expect(result.sensor).toMatchObject({ node_id: config.node_id, visible_identifiers: 1 });
      const text = JSON.stringify(result);
      expect(text).not.toContain(body.items[0].address);
      for (const key of ['vehicle_evidence', 'name_brand_mask', 'exclusion_mask', 'ecosystem_mask', 'address_type', 'parsed_reports']) expect(text).not.toContain(key);
    }
  });

  test('documents all feature fields as required while keeping the address extension optional', async () => {
    const document = await data(await fetchWorker('/openapi.json'));
    const schemas = document.components.schemas;
    expect(schemas.AddressSummary.required).not.toContain('vehicle_evidence');
    expect(schemas.AddressSummary.properties.vehicle_evidence.$ref).toContain('CompactVehicleEvidence');
    expect(schemas.CompactVehicleEvidence.additionalProperties).toBe(false);
    expect(schemas.CompactVehicleEvidence.required).toEqual(['schema_version', 'parsed_reports', 'malformed_reports', 'name_brand_mask', 'exclusion_mask', 'ecosystem_mask']);
    expect(schemas.CompactVehicleEvidence.properties.name_brand_mask.maximum).toBe((1 << 20) - 1);
    expect(schemas.CompactVehicleEvidence.description).toContain('full raw capture is not required');
  });
});
