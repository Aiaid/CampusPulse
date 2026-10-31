import { capabilityDigestV3, freezeDeviceConfigV3 } from '../../worker/device-v3-config';
import { ingestV3Fixture, seedIngestV3 } from './v3-ingest-fixtures';
export const STATISTICS_FLAGS = { DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true', DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-only/1"]' };
/** Synthetic declarations and server history only, not physical acceptance. */
export async function statisticsFixture(node: string, placement: string, now = Date.now(), events = false) {
  const f = await ingestV3Fixture(node, placement, now);
  f.caps.statistics = { schemas: ['window-statistics/1'], extractor_versions: ['cp-v3-stats/1'], ruleset_versions: ['unclassified-v1'] };
  f.caps.temporal = { slice_ms: [1000, 2000], max_history_ms: 600000, max_tracks: 16, max_open_events: 16, max_event_ms: 600000,
    event_schemas: ['candidate-event/1'], report_modes: ['off', 'terminal_only', 'revisions'] };
  f.policy.evidence = { mode: 'statistics', schema: 'window-statistics/1', extractor_version: 'cp-v3-stats/1', ruleset_version: 'unclassified-v1' };
  f.policy.temporal = events ? { mode: 'rolling', slice_ms: 1000, history_ms: 600000, max_tracks: 16, max_open_events: 16, max_event_ms: 600000,
    gap_ms: 2000, report_mode: 'revisions', min_update_ms: 1000 } : { mode: 'off' };
  if (f.policy.uplink.enabled && f.caps.uplink && f.policy.local_queue.mode !== 'disabled') {
    f.policy.uplink.streams = events ? ['window_statistics', 'candidate_events', 'node_status'] : ['window_statistics', 'node_status'];
    f.policy.uplink.max_body_bytes = 8192;
    f.caps.uplink.streams = f.policy.uplink.streams; f.caps.uplink.max_body_bytes = 8192;
    f.policy.local_queue.stream_reserves = f.policy.uplink.streams.map(stream => ({ stream, bytes: 32768, items: 16 }));
  }
  f.policy.control.lease.on_uplink_expiry = 'drain_frozen_until_accept_until';
  f.policy.control.capability_sha256 = await capabilityDigestV3(f.caps);
  return f;
}
export type StatisticsFixture = Awaited<ReturnType<typeof statisticsFixture>>;
export async function seedStatistics(db: D1Database, f: StatisticsFixture, applied = true) {
  const frozen = await seedIngestV3(db, f, applied);
  if (applied) await db.batch([
    db.prepare(`INSERT INTO device_statistics_authorizations_v3(node_id,generation,boot_id,policy_sha256,accept_until_ms,lease_until_ms,uptime_ms,span_count)
      VALUES(?,?,?,?,?,?,0,1)`).bind(f.policy.node_id, f.policy.assignment_generation, f.caps.boot_id, frozen.policy_sha256,
        Date.parse(f.policy.custody.accept_until), f.appliedAt + f.policy.control.lease.duration_ms),
    db.prepare(`INSERT INTO device_statistics_lease_spans_v3(node_id,generation,span_seq,start_ms,end_ms,accept_until_ms) VALUES(?,?,1,?,?,?)`)
      .bind(f.policy.node_id, f.policy.assignment_generation, f.appliedAt, f.appliedAt + f.policy.control.lease.duration_ms, Date.parse(f.policy.custody.accept_until)),
  ]);
  return frozen;
}
export async function statisticsBatch(f: StatisticsFixture, seq = 1) {
  const frozen = await freezeDeviceConfigV3(f.policy);
  return { p: 3, z: 'statistics/1', b: crypto.randomUUID(), n: f.policy.node_id, o: f.caps.boot_id,
    c: f.policy.policy_id, h: frozen.policy_sha256, g: f.policy.assignment_generation, d: f.policy.custody.dataset, k: 'window_statistics',
    x: [{ q: seq, w: seq + 3, t: [6000 + seq * 1000, f.now - 4000 + seq * 1000, 1, 0] as (number | null)[], d: 1000, b: 1000,
      c: [0, 0, 0, 0, 2, 0], r: [4, 4, 3, 1], x: [[4, 2, 4, -240]], s: [4, -240, -60, -60], l: [1000, 0, 0, 0], f: 0, v: ['cp-v3-stats/1', 'unclassified-v1'] }] };
}
export async function statisticsStatus(f: StatisticsFixture, seq = 1, loss = 0) {
  const b = await statisticsBatch(f, seq);
  return { ...b, k: 'node_status', x: [{ q: seq, t: [6000 + seq * 1000, f.now - 4000 + seq * 1000, 1, 0], u: 6000 + seq * 1000,
    s: 'running', r: [100000, 90000, 50000, null, 4000], j: [1, 512, 0, 0, 1, 512], l: [loss, loss, loss, loss, loss, loss] }] };
}
export async function statisticsEvent(f: StatisticsFixture, seq = 1, revision = 1, eventId = crypto.randomUUID(), terminal = false) {
  const b = await statisticsBatch(f, seq), time = (ms: number) => [ms, f.now - 10000 + ms, 1, 0];
  return { ...b, k: 'candidate_events', x: [{ q: seq, i: eventId, v: revision, k: 'visibility_segment', s: terminal ? 'closed' : 'open',
    a: time(1000), l: time(4000), u: time(terminal ? 6000 : 4000), e: terminal ? time(6000) : null, r: [4, 4, terminal ? 2 : 0, terminal ? 5000 : 3000, 4, -240, -60, -60],
    c: terminal ? 'observed_gap' : 'snapshot', f: 0, x: ['cp-v3-stats/1', 'unclassified-v1'] }] };
}
