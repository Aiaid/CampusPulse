import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeDump, analyzeResponses } from '../scripts/analyze-ingestion-dump.mjs';
import { parseAdvertisement } from '../worker/ble-ad';

const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const directories: string[] = [];
const report = (seq = 1, payload = '020106') => ({
  seq, time: { mono_ms: seq * 1000, utc_ms: null as number | null, clock_epoch: 0, uncertainty_ms: null as number | null },
  window_seq: 1, identity: { scheme: 'none' }, rssi_dbm: -50 as number | null,
  report_type: 'adv_ind', report_type_code: 0, format: 'legacy_ad',
  payload_length: payload.length / 2, payload_hex: payload,
});
const response = (items = [report()]) => ({
  batch: { protocol: 'campuspulse/1', batch_id: '11111111-1111-4111-8111-111111111111',
    node_id: 'synthetic-node', boot_id: '22222222-2222-4222-8222-222222222222',
    placement_id: 'synthetic-place', capture_config_id: 'synthetic-config', dataset: 'demo',
    firmware_version: 'synthetic-v1', stream: 'ble_reports', items },
  body_sha256: 'a'.repeat(64),
  derived: items.map(item => ({ seq: item.seq, ...parseAdvertisement(item.payload_hex) })),
});

function dumpFixture(data = response()) {
  const directory = mkdtempSync(join(tmpdir(), 'campuspulse-dump-test-'));
  directories.push(directory);
  mkdirSync(join(directory, 'batches'));
  const bytes = JSON.stringify(data);
  const entry = { file: 'batches/33333333-3333-4333-8333-333333333333.json',
    node_id: data.batch.node_id, batch_id: data.batch.batch_id, records: data.batch.items.length,
    response_sha256: sha256(bytes), original_upload_sha256: data.body_sha256 };
  const manifest = { cutoff: '2026-10-24T00:00:00.000Z', completed_at: '2026-10-24T00:01:00.000Z',
    indexed_batches: 1, downloaded: [entry], expired_raw_at_cutoff: [], failures: [] };
  const saveManifest = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, entry.file), bytes);
  for (const name of ['capture-configs.json', 'sensor-windows.json', 'node-status.json']) {
    writeFileSync(join(directory, name), '[]');
  }
  saveManifest();
  return { directory, entry, manifest, saveManifest };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('private ingestion dump analysis', () => {
  it('isolates nodes, datasets and firmware cohorts without merging boot sequence ranges', () => {
    const first = response();
    const same = response([report(2)]);
    const otherNode = response(); otherNode.batch.node_id = 'another-synthetic-node';
    const otherDataset = response(); otherDataset.batch.dataset = 'field';
    const otherFirmware = response(); otherFirmware.batch.firmware_version = 'synthetic-v2';
    const cohorts = analyzeResponses([first, same, otherNode, otherDataset, otherFirmware]);
    expect(cohorts).toHaveLength(4);
    expect(cohorts[0]).toMatchObject({ batches: 2, reports: 2, boot_count: 1, duplicate_sequences: 0 });
    expect(cohorts.slice(1).map(cohort => cohort.reports)).toEqual([1, 1, 1]);
    expect(cohorts.map(cohort => [cohort.node_id, cohort.dataset, cohort.firmware_version])).toEqual([
      ['synthetic-node', 'demo', 'synthetic-v1'], ['another-synthetic-node', 'demo', 'synthetic-v1'],
      ['synthetic-node', 'field', 'synthetic-v1'], ['synthetic-node', 'demo', 'synthetic-v2'],
    ]);
  });

  it('distinguishes missing, explicit null and measured clock/RSSI fields', () => {
    const items = [report(1), report(2), report(3)];
    Reflect.deleteProperty(items[0].time, 'utc_ms');
    Reflect.deleteProperty(items[0].time, 'uncertainty_ms');
    Reflect.deleteProperty(items[0], 'rssi_dbm');
    items[1].rssi_dbm = null;
    items[2].time.utc_ms = 1_000_000; items[2].time.uncertainty_ms = 0;
    const [cohort] = analyzeResponses([response(items)]);
    expect(cohort.field_presence['time.utc_ms']).toEqual({ present: 2, missing: 1, null: 1 });
    expect(cohort.field_presence['time.uncertainty_ms']).toEqual({ present: 2, missing: 1, null: 1 });
    expect(cohort.utc_known).toBe(1);
    expect(cohort.uncertainty_known).toBe(1);
    expect(cohort.field_presence.rssi_dbm).toEqual({ present: 2, missing: 1, null: 1 });
    expect(cohort.rssi_unknown).toBe(2);
    expect(cohort.rssi_dbm).toEqual({ min: -50, p50: -50, p95: -50, max: -50 });
  });

  it('reports empirical type/code pairs and retains both fields in compact estimates', () => {
    const items = [report(1), report(2)];
    items[0].report_type_code = 99;
    items[1].report_type_code = 99; items[1].report_type = 'unknown';
    const data = response(items);
    const [cohort] = analyzeResponses([data]);
    expect(cohort.report_type_labels_by_code).toEqual({ 99: { adv_ind: 1, unknown: 1 } });
    const compactItems = items.map(({ payload_length: _length, format: _format, identity: _identity, ...item }) => ({
      ...item, time: { mono_ms: item.time.mono_ms, clock_epoch: item.time.clock_epoch },
    }));
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    expect(cohort.byte_savings_estimates.combined_conditional_compact_profile)
      .toBe(bytes(data.batch) - bytes({ ...data.batch, items: compactItems }));
  });

  it('counts recovered malformed AD prefixes while explicitly withholding absence claims', () => {
    const data = response([report(1, '020106050941'), report(2, '020941050941')]);
    const fixture = dumpFixture(data);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = analyzeDump(fixture.directory);
    expect(result.cohorts[0].ad).toMatchObject({ parse_status_counts: { malformed: 2 }, malformed: 2, with_flags: 1, with_names: 1, with_manufacturer_data: 0 });
    expect(result.ad_presence_scope).toContain('counts recovered fields');
    expect(result.ad_presence_scope).toContain('not recovered, not confirmed absent');
    expect(result.byte_estimate_scope).toContain('not original frozen-body sizes');
  });

  it('rejects altered response bytes before producing an analysis', () => {
    const fixture = dumpFixture();
    writeFileSync(join(fixture.directory, fixture.entry.file), JSON.stringify(response([report(1, '')])));
    expect(() => analyzeDump(fixture.directory)).toThrow('response_checksum_mismatch');
    expect(existsSync(join(fixture.directory, 'analysis.json'))).toBe(false);
  });

  it.each(['original_upload_sha256', 'node_id', 'batch_id', 'records'] as const)
  ('rejects a tampered manifest %s even when response bytes remain intact', key => {
    const fixture = dumpFixture();
    if (key === 'records') fixture.entry.records = 2;
    else fixture.entry[key] = key === 'original_upload_sha256' ? 'b'.repeat(64) : 'tampered';
    fixture.saveManifest();
    expect(() => analyzeDump(fixture.directory)).toThrow('manifest_identity_mismatch');
    expect(existsSync(join(fixture.directory, 'analysis.json'))).toBe(false);
  });

  it('rejects manifest paths escaping the batch directory', () => {
    const fixture = dumpFixture();
    fixture.entry.file = '../outside.json'; fixture.saveManifest();
    expect(() => analyzeDump(fixture.directory)).toThrow('invalid_manifest_path');
  });
});
