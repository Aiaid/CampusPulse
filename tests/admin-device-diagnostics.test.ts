import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { sha256 } from '../worker/ingest';
import { authState, Client, json, TOKEN } from './admin-auth-helpers';
import { DEVICE_TOKEN, fixture } from './helpers/ingestion';

let state: Awaited<ReturnType<typeof authState>>;
let client: Client;
const path = '/devices/cp-demo-01/batches';
beforeEach(async () => { state = await authState(); client = new Client(state); await client.initialize(); });
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });
async function upload(name: string, change: (batch: any) => void = () => {}, version = 1) {
  const batch = fixture(name); change(batch);
  const bytes = new TextEncoder().encode(JSON.stringify(batch, null, 2) + '\n');
  await json(await worker.fetch(new Request(`https://admin.example.test/api/v${version}/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(bytes) }, body: bytes }), state.env));
  return { batch, bytes };
}
async function seedV2() {
  const config = fixture('capture-config-v2.fixture'); config.accept_until = new Date(Date.now() + 86400000).toISOString();
  await json(await client.call('/configs', 'POST', { config }), 201);
  await json(await client.call(`/configs/${config.capture_config_id}/publish`, 'POST', { revision: 1 }));
}
it('requires an initialized admin session and rejects bearer auth, cross-origin access and mutations', async () => {
  const anonymous = new Client(state);
  for (const token of [undefined, DEVICE_TOKEN, TOKEN, state.env.RESEARCH_TOKEN]) {
    expect((await anonymous.call(path, 'GET', undefined, token ? { Authorization: `Bearer ${token}` } : {})).status).toBe(401);
  }
  expect((await client.call(path, 'GET', undefined, { Origin: 'https://foreign.test' })).status).toBe(403);
  expect((await client.call(path, 'POST', {})).status).toBe(405);
  expect((await client.call('/devices/other-device/batches')).status).toBe(404);
  await client.call('/session', 'DELETE');
  expect((await client.call(path)).status).toBe(401);
});
it('paginates immutable mixed-protocol receipts with tied timestamps and bounds query inputs', async () => {
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
  await seedV2();
  await upload('ble-windows.request');
  await upload('node-status.request');
  await upload('address-summaries-v2.request', () => {}, 2);
  const first = await json(await client.call(`${path}?limit=2`));
  const second = await json(await client.call(`${path}?limit=2&before=${first.next_cursor}`));
  expect(first.batches).toHaveLength(2); expect(second.batches).toHaveLength(1); expect(second.next_cursor).toBeNull();
  expect(new Set([...first.batches, ...second.batches].map(row => row.batch_id)).size).toBe(3);
  expect(new Set([...first.batches, ...second.batches].map(row => row.protocol))).toEqual(new Set(['campuspulse/1', 'campuspulse/2']));
  const filtered = await json(await client.call(`${path}?stream=address_summaries`)); expect(filtered.batches).toHaveLength(1);
  expect(JSON.stringify(first)).not.toMatch(/credential|raw_object_key|synthetic-device-token/);
  for (const query of ['limit=0', 'limit=51', 'limit=1e2', 'stream=unknown', 'before=not-json', `before=${'a'.repeat(257)}`, 'limit=1&limit=2', 'node_id=other']) expect((await client.call(`${path}?${query}`)).status).toBe(422);
});
it('returns normalized projection with measurement provenance without inventing request bytes', async () => {
  await seedV2(); const { batch } = await upload('address-summaries-v2.request', () => {}, 2);
  const response = await client.call(`${path}/${batch.batch_id}`); expect(response.headers.get('cache-control')).toBe('no-store');
  const result = await json(response);
  expect(result.batch).toMatchObject({ durability: 'committed', accepted_count: batch.items.length, exact_size_bytes: null });
  expect(result.projection).toMatchObject({ source: 'normalized_d1', status: 'complete', content: 'validated_items' });
  expect(result.projection.items.map((row: any) => row.item)).toEqual(batch.items);
  expect(result.exact).toEqual({ status: 'not_archived', size_bytes: null, sha256_verified: false });
  expect((await client.call(`/devices/unknown/batches/${batch.batch_id}`)).status).toBe(404);
  expect((await client.call(`${path}/${crypto.randomUUID()}`)).status).toBe(404);
});
it('verifies the selected private R2 bytes, preserving exact formatting, without fetching during listing', async () => {
  const { batch, bytes } = await upload('ble-reports.request');
  const get = vi.spyOn(state.env.RAW_BUCKET!, 'get');
  await json(await client.call(path)); expect(get).not.toHaveBeenCalled();
  const result = await json(await client.call(`${path}/${batch.batch_id}`));
  expect(get).toHaveBeenCalledTimes(1);
  expect(result.exact).toEqual({ status: 'verified', size_bytes: bytes.length, sha256_verified: true, utf8_text: new TextDecoder().decode(bytes) });
  expect(result.projection).toMatchObject({ status: 'not_stored', items: [] });
});
it('hides expired content immediately while retaining receipts, including before cleanup runs', async () => {
  const { batch } = await upload('ble-reports.request');
  state.db.prepare('UPDATE ingestion_batches SET expires_at_ms=? WHERE batch_id=?').run(Date.now() - 1, batch.batch_id);
  const get = vi.spyOn(state.env.RAW_BUCKET!, 'get');
  const result = await json(await client.call(`${path}/${batch.batch_id}`));
  expect(result.batch.durability).toBe('committed'); expect(result.exact.status).toBe('expired'); expect(result.exact.utf8_text).toBeUndefined(); expect(get).not.toHaveBeenCalled();
  const status = await upload('node-status.request');
  state.db.prepare('UPDATE node_status SET expires_at_ms=? WHERE batch_id=?').run(Date.now() - 1, status.batch.batch_id);
  expect((await json(await client.call(`${path}/${status.batch.batch_id}`))).projection).toMatchObject({ items: [], status: 'partial_or_missing' });
});
it('withholds corrupt, absent, oversized and credential-bearing archival bodies', async () => {
  const { batch } = await upload('ble-reports.request');
  const [key, original] = [...state.raw.objects.entries()][0];
  state.raw.objects.set(key, new TextEncoder().encode('tampered'));
  let result = await json(await client.call(`${path}/${batch.batch_id}`)); expect(result.exact.status).toBe('integrity_error'); expect(result.exact.utf8_text).toBeUndefined();
  state.raw.objects.delete(key);
  expect((await json(await client.call(`${path}/${batch.batch_id}`))).exact.status).toBe('missing');
  state.raw.objects.set(key, new Uint8Array(65537));
  expect((await json(await client.call(`${path}/${batch.batch_id}`))).exact.status).toBe('size_limit');
  const setup = Object.fromEntries(['pin', 'proof', 'setup_pin', 'setup_proof', 'api_key', 'access_token', 'refresh_token', 'pairing_code'].map(key => [key, `synthetic-hidden-${key}`]));
  const injected = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(original)), device_token: 'must-never-leave-storage', wifi: { password: 'never-render' }, setup }));
  state.raw.objects.set(key, injected);
  state.db.prepare('UPDATE ingestion_batches SET body_sha256=? WHERE batch_id=?').run(await sha256(injected), batch.batch_id);
  result = await json(await client.call(`${path}/${batch.batch_id}`)); expect(result.exact.status).toBe('sensitive_fields_omitted'); expect(JSON.stringify(result)).not.toContain('must-never-leave-storage'); expect(JSON.stringify(result)).not.toContain('never-render');
  expect(result.exact.utf8_text).toBeUndefined();
  for (const value of Object.values(setup)) expect(JSON.stringify(result)).not.toContain(value);
});
it('redacts credential keys from stored projections and provides explicit status provenance', async () => {
  const { batch } = await upload('node-status.request');
  const setup = Object.fromEntries(['pin', 'proof', 'setup_pin', 'setup_proof', 'api_key', 'access_token', 'refresh_token', 'pairing_code'].map(key => [key, `synthetic-hidden-${key}`]));
  const inserted = { ...batch.items[0], credentials: { device_token: 'projection-secret' }, network: { eap_password: 'private-network-secret' }, setup };
  state.db.prepare('UPDATE node_status SET item_json=? WHERE batch_id=? AND seq=1').run(JSON.stringify(inserted), batch.batch_id);
  const detail = await json(await client.call(`${path}/${batch.batch_id}`)); expect(JSON.stringify(detail)).not.toContain('projection-secret'); expect(JSON.stringify(detail)).not.toContain('private-network-secret');
  for (const value of Object.values(setup)) expect(JSON.stringify(detail)).not.toContain(value);
  // Restore the validated status before asserting the separate device projection.
  state.db.prepare('UPDATE node_status SET item_json=? WHERE batch_id=? AND seq=1').run(JSON.stringify(batch.items[0]), batch.batch_id);
  const fleet = await json(await client.call('/devices')); expect(fleet.devices).toHaveLength(1);
  expect(fleet.devices[0].latest_status).toMatchObject({ item: { seq: 1 }, batch_id: batch.batch_id, capture_config_id: batch.capture_config_id });
  expect(fleet.devices[0].latest_ingestion).toMatchObject({ boot_id: batch.boot_id, batch_id: batch.batch_id });
});
it('withholds standalone setup and API secrets without hiding normal BLE identity', async () => {
  const { batch, bytes } = await upload('ble-reports.request');
  const [key] = [...state.raw.objects.keys()];
  const original = JSON.parse(new TextDecoder().decode(bytes));
  for (const field of ['pin', 'proof', 'setup_pin', 'setup_proof', 'api_key', 'access_token', 'refresh_token', 'pairing_code']) {
    const injected = new TextEncoder().encode(JSON.stringify({ ...original, setup: { [field]: 'synthetic-private-value' } }));
    state.raw.objects.set(key, injected);
    state.db.prepare('UPDATE ingestion_batches SET body_sha256=? WHERE batch_id=?').run(await sha256(injected), batch.batch_id);
    const result = await json(await client.call(`${path}/${batch.batch_id}`));
    expect(result.exact.status).toBe('sensitive_fields_omitted');
    expect(result.exact.utf8_text).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
  }
  state.raw.objects.set(key, bytes);
  state.db.prepare('UPDATE ingestion_batches SET body_sha256=? WHERE batch_id=?').run(await sha256(bytes), batch.batch_id);
  const restored = await json(await client.call(`${path}/${batch.batch_id}`));
  expect(restored.exact.status).toBe('verified');
  expect(restored.exact.utf8_text).toBe(new TextDecoder().decode(bytes));
});
it('labels v2 raw D1 records as bookkeeping while verifying the separate archive', async () => {
  const config = fixture('capture-config-v2.fixture');
  config.accept_until = new Date(Date.now() + 86400000).toISOString();
  config.raw_capture = { mode: 'sampled', sample_every_n: 1, selection: 'seq_mod_n_eq_0', max_reports_per_window: 4 };
  config.allowed_streams.push('ble_reports');
  await json(await client.call('/configs', 'POST', { config }), 201);
  await json(await client.call(`/configs/${config.capture_config_id}/publish`, 'POST', { revision: 1 }));
  const { batch } = await upload('ble-reports.request', b => { b.protocol = 'campuspulse/2'; b.capture_config_id = config.capture_config_id; }, 2);
  const result = await json(await client.call(`${path}/${batch.batch_id}`));
  expect(result.projection).toMatchObject({ status: 'complete', content: 'sequence_bookkeeping_only' });
  expect(Object.keys(result.projection.items[0].item).sort()).toEqual(['seq', 'window_seq']);
  expect(result.exact.status).toBe('verified');
});
