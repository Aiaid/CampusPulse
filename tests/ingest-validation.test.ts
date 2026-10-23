import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IngestError, parseIngestJson, validateCaptureConfig, validateConfigBatch, validateEnvelope } from '../worker/ingest-validation';
import type { CaptureConfig } from '../worker/ingest-validation';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../docs/specs/examples/${name}`, import.meta.url), 'utf8'));
const clone = <T>(value: T): T => structuredClone(value);
const config = fixture('capture-config.fixture.json') as CaptureConfig;
const windowBatch = fixture('ble-windows.request.json') as Record<string, unknown>;
const reportBatch = fixture('ble-reports.request.json') as Record<string, unknown>;
const statusBatch = fixture('node-status.request.json') as Record<string, unknown>;
const item = (batch: Record<string, unknown>): Record<string, unknown> => (batch.items as Record<string, unknown>[])[0];
const err = (fn: () => unknown, status = 422) => {
  try { fn(); throw new Error('Expected rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).status).toBe(status);
  }
};

describe('byte-level JSON parsing', () => {
  const parse = (text: string) => parseIngestJson(new TextEncoder().encode(text));
  it('rejects duplicate keys at every depth, including escaped equivalents', () => {
    err(() => parse('{"a":1,"a":2}'), 400);
    err(() => parse('{"items":[{"time":{"mono_ms":1,"mono\\u005fms":2}}]}'), 400);
    err(() => parse('{"a":{},"b":{"x":1,"\\u0078":2}}'), 400);
    expect(parse('{"a":{"x":1},"b":{"x":2}}')).toEqual({ a: { x: 1 }, b: { x: 2 } });
  });
  it('rejects invalid UTF-8, malformed strings, and trailing JSON', () => {
    err(() => parseIngestJson(new Uint8Array([0x7b, 0xff, 0x7d])), 400);
    for (const value of ['{"a":"\\q"}', '{"a":1,}', '{"a":1}[]', '[1,]', '{"a":01}', '{"a":"\n"}']) {
      err(() => parse(value), 400);
    }
  });
});

describe('ingest v1 fixtures and cross-field validation', () => {
  it('accepts all three synthetic request fixtures against their registered config', () => {
    expect(validateCaptureConfig(clone(config))).toEqual(config);
    for (const sample of [windowBatch, reportBatch, statusBatch]) {
      const batch = validateEnvelope(clone(sample));
      expect(batch.items.length).toBe(1);
      expect(() => validateConfigBatch(batch, config)).not.toThrow();
    }
  });
  it('rejects envelope typos, wrong versions, unsafe numbers, empty and unsorted batches', () => {
    const b = clone(reportBatch); b.extra = true; err(() => validateEnvelope(b));
    const wrong = clone(reportBatch); wrong.protocol = 'campuspulse/2'; err(() => validateEnvelope(wrong));
    const unsafe = clone(reportBatch); item(unsafe).seq = Number.MAX_SAFE_INTEGER + 1; err(() => validateEnvelope(unsafe));
    const empty = clone(reportBatch); empty.items = []; err(() => validateEnvelope(empty));
    const unordered = clone(reportBatch); unordered.items = [item(unordered), clone(item(unordered))]; err(() => validateEnvelope(unordered));
    const status = clone(statusBatch); status.items = [item(status), { ...item(status), seq: 2 }]; err(() => validateEnvelope(status));
  });
  it('rejects unknown nested fields and bad time semantics', () => {
    const b = clone(reportBatch); (item(b).time as Record<string, unknown>).typo = 1; err(() => validateEnvelope(b));
    const privateKey = '02:00:00:00:00:01-private-token';
    const hidden = clone(reportBatch); (item(hidden).identity as Record<string, unknown>)[privateKey] = true;
    try { validateEnvelope(hidden); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(IngestError); expect((error as Error).message).not.toContain(privateKey); }
    const c = clone(reportBatch); (item(c).time as Record<string, unknown>).utc_ms = 0; err(() => validateEnvelope(c));
    const d = clone(reportBatch); (item(d).time as Record<string, unknown>).mono_ms = 1.2; err(() => validateEnvelope(d));
    const e = clone(reportBatch); (item(e).identity as Record<string, unknown>).extra = 'secret'; err(() => validateEnvelope(e));
  });
  it('checks window accounting, RSSI and report_rate calculation', () => {
    const b = clone(windowBatch); item(b).reports_seen = 281; err(() => validateEnvelope(b));
    const c = clone(windowBatch); (item(c).rssi as Record<string, unknown>).samples = 281; err(() => validateEnvelope(c));
    const d = clone(windowBatch); (item(d).raw_capture as Record<string, unknown>).drops = 2; err(() => validateEnvelope(d));
    const e = clone(windowBatch); (item(e).indices as Record<string, unknown>[])[0].value = 100; err(() => validateEnvelope(e));
    const f = clone(windowBatch); (item(f).indices as Record<string, unknown>[])[0].metric = 'crowding'; err(() => validateEnvelope(f));
    const g = clone(windowBatch); item(g).scan_enabled_ms = 0; err(() => validateEnvelope(g));
    const h = clone(windowBatch); (item(h).rssi as Record<string, unknown>).mean_dbm = Number.POSITIVE_INFINITY; err(() => validateEnvelope(h));
  });
  it('allows malformed AD bytes as evidence, while rejecting invalid transport encoding', () => {
    const malformedAd = clone(reportBatch);
    item(malformedAd).payload_hex = 'ff'; item(malformedAd).payload_length = 1;
    expect(validateEnvelope(malformedAd).stream).toBe('ble_reports');
    const invalidHex = clone(reportBatch); item(invalidHex).payload_hex = '0G'; err(() => validateEnvelope(invalidHex));
    const mismatch = clone(reportBatch); item(mismatch).payload_length = 22; err(() => validateEnvelope(mismatch));
    const tooLong = clone(reportBatch); item(tooLong).payload_length = 32; err(() => validateEnvelope(tooLong));
    const noRssi = clone(reportBatch); item(noRssi).rssi_dbm = null; expect(validateEnvelope(noRssi).stream).toBe('ble_reports');
    const unavailable = clone(reportBatch); item(unavailable).rssi_dbm = 127; err(() => validateEnvelope(unavailable));
  });
  it('enforces all three identity shapes and their configured policy', () => {
    const tokenBatch = clone(reportBatch);
    item(tokenBatch).identity = { scheme: 'window_token', token: 'a'.repeat(32), address_type: 'random' };
    const tokenConfig = { ...config, identity_scheme: 'window_token' as const };
    validateConfigBatch(validateEnvelope(tokenBatch), tokenConfig);
    err(() => validateConfigBatch(validateEnvelope(tokenBatch), config));
    const noneBatch = clone(reportBatch); item(noneBatch).identity = { scheme: 'none' };
    validateConfigBatch(validateEnvelope(noneBatch), { ...config, identity_scheme: 'none' });
    const leaked = clone(noneBatch); item(leaked).identity = { scheme: 'none', address: '02:00:00:00:00:01' };
    err(() => validateEnvelope(leaked));
    const uppercase = clone(reportBatch); (item(uppercase).identity as Record<string, unknown>).address = '02:00:00:00:00:AA';
    err(() => validateEnvelope(uppercase));
  });
  it('checks status counters, queue bounds and buffer fields', () => {
    const b = clone(statusBatch); (item(b).queue_pending as Record<string, unknown>).ble_reports = 1025; err(() => validateEnvelope(b));
    const c = clone(statusBatch); (item(c).buffer_health as Record<string, unknown>).unexpected = 1; err(() => validateEnvelope(c));
    const d = clone(statusBatch); (item(d).loss_totals as Record<string, unknown>).upload_failures = -1; err(() => validateEnvelope(d));
    const e = clone(statusBatch); (item(e).buffer_health as Record<string, unknown>).unacked_bytes = 4097; err(() => validateEnvelope(e));
  });
  it('binds batches to config, stream permissions, raw mode and per-node item limit', () => {
    const raw = validateEnvelope(clone(reportBatch));
    err(() => validateConfigBatch(raw, { ...config, node_id: 'other' }));
    err(() => validateConfigBatch(raw, { ...config, allowed_streams: ['ble_windows','node_status'] }));
    err(() => validateConfigBatch(raw, { ...config, capture_profile: 'metrics' }));
    err(() => validateConfigBatch(raw, { ...config, upload_policy: { ...config.upload_policy, max_items: 0 } }));
    const windows = validateEnvelope(clone(windowBatch));
    err(() => validateConfigBatch(windows, { ...config, raw_capture: { mode: 'all' } }));
    const unsampled = clone(reportBatch); item(unsampled).seq = 281;
    err(() => validateConfigBatch(validateEnvelope(unsampled), config));
    const passiveResponse = clone(reportBatch); item(passiveResponse).report_type = 'scan_rsp';
    err(() => validateConfigBatch(validateEnvelope(passiveResponse), config));
  });
  it('validates server capture config before it becomes an authorization policy', () => {
    const extra = clone(config) as unknown as Record<string, unknown>; extra.secret = 'x'; err(() => validateCaptureConfig(extra));
    const unlimited = clone(config); unlimited.upload_policy.max_body_bytes = 65537; err(() => validateCaptureConfig(unlimited));
    const unordered = clone(config); unordered.upload_policy.resume_pct = 85; err(() => validateCaptureConfig(unordered));
    const rawMetrics = clone(config); rawMetrics.capture_profile = 'metrics'; err(() => validateCaptureConfig(rawMetrics));
    const badSampling = clone(config); badSampling.raw_capture.sample_every_n = 0; err(() => validateCaptureConfig(badSampling));
    const date = clone(config); date.accept_until = '2026-02-30T00:00:00.000Z'; err(() => validateCaptureConfig(date));
  });
});
