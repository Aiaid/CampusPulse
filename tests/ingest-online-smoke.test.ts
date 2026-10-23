import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runOnlineSmoke, validateTarget, verifyAck, verifyDemoIsolation } from '../scripts/ingest-online-smoke.mjs';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../docs/specs/examples/${name}`, import.meta.url), 'utf8'));
const raw = fixture('ble-reports.request.json');
const hash = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
const goodAck = { node_id: raw.node_id, boot_id: raw.boot_id, stream: raw.stream,
  batch_id: raw.batch_id, body_sha256: hash, accepted_count: 1, durability: 'committed',
  receipt_id: '55555555-5555-4555-8555-555555555555', received_at: '2026-10-23T04:00:00.000Z' };
const ops = { node_id: 'cp-demo-01', capture_config_id: 'demo-capture-raw-v1', placement_id: 'demo-placement-01',
  place_id: 'library', device_token: 'synthetic-device-token', research_token: 'synthetic-research-token' };

describe('online smoke safeguards', () => {
  it('requires explicit guard and permits only the two exact HTTPS origins', async () => {
    expect(validateTarget('https://pulse.anend.net')).toBe('https://pulse.anend.net');
    expect(validateTarget('https://campuspulse.anend.workers.dev')).toBe('https://campuspulse.anend.workers.dev');
    for (const target of ['http://pulse.anend.net', 'https://pulse.anend.net.evil.test',
      'https://pulse.anend.net:8443', 'https://pulse.anend.net/path', 'https://user@pulse.anend.net'])
      expect(() => validateTarget(target)).toThrow();
    const mockFetch = vi.fn();
    await expect(runOnlineSmoke({ target: 'https://pulse.anend.net', ops, enabled: '0' }, { fetchImpl: mockFetch })).rejects.toThrow('run_guard_required');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects false ACKs even when HTTP says success', () => {
    expect(verifyAck(goodAck, raw, hash)).toEqual(goodAck);
    for (const changed of [
      { ...goodAck, body_sha256: '0'.repeat(64) },
      { ...goodAck, accepted_count: 2 },
      { ...goodAck, durability: 'queued' },
      { ...goodAck, batch_id: 'other' },
      { ...goodAck, receipt_id: 'not-a-uuid' },
      { ...goodAck, raw_object_key: 'leak' },
    ]) expect(() => verifyAck(changed, raw, hash)).toThrow('false_ack');
  });

  it('compares field projections before and after demo writes', () => {
    const baseline = { summary: { sensor: null, latest_observation: null, as_of: 'earlier' },
      history: { observations: [], sensor_windows: [], from: 'earlier' } };
    const after = { summary: { sensor: null, latest_observation: null, as_of: 'later' },
      history: { observations: [], sensor_windows: [], from: 'later' } };
    expect(verifyDemoIsolation(baseline, after)).toEqual({ sensor_windows: 0, observations: 0 });
    expect(() => verifyDemoIsolation(baseline, { ...after, history: { ...after.history,
      sensor_windows: [{ dataset: 'field', node_id: ops.node_id }] } })).toThrow('demo_isolation_failed');
  });

  it('uses injected fetch, stops on a false ACK and never logs credentials or raw evidence', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === '/api/v1/health') return Response.json({ status: 'ok', ingestion: 'implemented', raw_storage: 'configured' });
      if (path === '/api/v1/device/config') return Response.json({ expired: false, config: fixture('capture-config.fixture.json') });
      if (path.endsWith('/summary')) return Response.json({ sensor: null, latest_observation: null });
      if (path.endsWith('/history')) return Response.json({ observations: [], sensor_windows: [] });
      if (path === '/api/v1/ingest') return Response.json({ ...goodAck, body_sha256: '0'.repeat(64) });
      throw new Error('Unexpected mock route');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runOnlineSmoke({ target: 'https://pulse.anend.net', ops, enabled: '1' },
        { fetchImpl: mockFetch, uuid: () => '11111111-1111-4111-8111-111111111111', now: () => 1792728000000 })).rejects.toThrow('false_ack');
      expect(calls).toContain('/api/v1/ingest');
      expect(`${log.mock.calls.flat().join(' ')}${error.mock.calls.flat().join(' ')}`).not.toMatch(/synthetic-device-token|synthetic-research-token|0201060909/);
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});
