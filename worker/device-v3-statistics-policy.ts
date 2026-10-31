import type { Env } from './types';
import type { AuthAssertion } from './admin-auth';
import { IngestError } from './ingest-validation';
import { capabilityDigestV3, negotiateDeviceConfigV3, validateDeviceCapabilitiesV3, validateFrozenDeviceConfigV3,
  type DeviceCapabilitiesV3, type DeviceConfigV3 } from './device-v3-config';
import type { DeviceV3IngestEnv } from './device-v3-ingest-validation';

export type DeviceV3StatisticsEnv = DeviceV3IngestEnv & { DEVICE_V3_STATISTICS_ENABLED?: string };
export type V3StatisticsPolicy = DeviceConfigV3 & {
  evidence: Extract<DeviceConfigV3['evidence'], { mode: 'statistics' }>;
  uplink: Extract<DeviceConfigV3['uplink'], { enabled: true }>;
  collection: DeviceConfigV3['collection'] & { summary: Extract<DeviceConfigV3['collection']['summary'], { enabled: true }> };
  local_queue: Extract<DeviceConfigV3['local_queue'], { mode: 'durable' | 'best_effort_research' }>;
  temporal: NonNullable<DeviceConfigV3['temporal']>;
};
export const STATISTICS_NOW_SQL = "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export function v3StatisticsEnabled(env: DeviceV3StatisticsEnv): boolean {
  return env.DEVICE_V3_CONTROL_ENABLED === 'true' && env.DEVICE_V3_STATISTICS_ENABLED === 'true';
}
export function supportsV3StatisticsPolicy(p: DeviceConfigV3): p is V3StatisticsPolicy {
  return p.evidence.mode === 'statistics' && p.evidence.schema === 'window-statistics/1' &&
    p.evidence.extractor_version === 'cp-v3-stats/1' && p.evidence.ruleset_version === 'unclassified-v1' &&
    p.collection.enabled && p.collection.summary.enabled && p.temporal !== undefined &&
    p.uplink.enabled && ['https', 'mqtt_tls'].includes(p.uplink.transport) && p.uplink.max_body_bytes <= 8192 &&
    p.uplink.streams.includes('window_statistics') && p.uplink.streams.includes('node_status') &&
    p.uplink.streams.every(s => ['window_statistics', 'candidate_events', 'node_status'].includes(s)) &&
    p.uplink.raw_sample.mode === 'off' && p.uplink.archive.mode === 'off' &&
    p.local_queue.mode === 'durable' && p.custody.dataset !== 'research_unassigned' && p.custody.placement_id !== null &&
    p.custody.association_scope === 'window' && p.control.lease.on_collection_expiry === 'pause' &&
    p.control.lease.on_raw_expiry === 'stop_recording' && p.control.lease.on_uplink_expiry === 'drain_frozen_until_accept_until' &&
    p.control.lease.duration_ms > p.collection.summary.window_ms;
}
export function assertV3StatisticsPolicy(p: DeviceConfigV3, env: DeviceV3StatisticsEnv, producer?: string): asserts p is V3StatisticsPolicy {
  if (!v3StatisticsEnabled(env) || !supportsV3StatisticsPolicy(p)) throw new IngestError(422, 'v3_statistics_unavailable', 'Statistics policy is not enabled or supported.');
  if (producer !== undefined) {
    let versions: unknown;
    try { versions = JSON.parse(env.DEVICE_V3_PRODUCER_VERSIONS ?? 'null'); } catch { versions = null; }
    if (!Array.isArray(versions) || versions.length < 1 || versions.length > 16 || new Set(versions).size !== versions.length ||
      versions.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/.test(v)) || !versions.includes(producer)) {
      throw new IngestError(422, 'v3_statistics_version_unavailable', 'Statistics producer version is not enabled.');
    }
  }
}
export interface StatisticsIdentity { node_id: string; boot_id: string; assignment_generation: number; policy_id: string; policy_sha256: string }
export interface StatisticsAuthority {
  identity: StatisticsIdentity; policy: V3StatisticsPolicy; capabilities: DeviceCapabilitiesV3;
  applied_at_ms: number; accept_until_ms: number; state_version: number;
}
interface StoredAuthority {
  envelope_json: string; capability_json: string; capability_sha256: string; boot_id: string; policy_id: string; policy_sha256: string;
  revision: number; placement_id: string | null; not_before_ms: number; expires_at_ms: number; issued_at_ms: number; capability_expires_at_ms: number;
  received_at: string; acknowledgement_json: string; apply_seq: number; accept_until_ms: number; state_version: number;
}
/** Resolve immutable original identity, including retired boots, never current desired pointers. */
export async function loadStatisticsAuthority(env: DeviceV3StatisticsEnv, identity: StatisticsIdentity): Promise<StatisticsAuthority> {
  const row = await env.DB.prepare(`SELECT a.envelope_json,a.capability_sha256,a.boot_id,a.policy_id,a.policy_sha256,a.revision,a.placement_id,
    a.not_before_ms,a.expires_at_ms,c.capability_json,c.issued_at_ms,c.expires_at_ms AS capability_expires_at_ms,
    k.received_at,k.acknowledgement_json,k.apply_seq,s.accept_until_ms,s.state_version FROM device_assignments_v3 a
    JOIN device_capabilities_v3 c ON c.node_id=a.node_id AND c.capability_sha256=a.capability_sha256
    JOIN device_acknowledgements_v3 k ON k.node_id=a.node_id AND k.generation=a.generation AND k.state='applied' AND k.boot_id=a.boot_id
    JOIN device_statistics_authorizations_v3 s ON s.node_id=a.node_id AND s.generation=a.generation AND s.boot_id=a.boot_id AND s.policy_sha256=a.policy_sha256
    WHERE a.node_id=? AND a.generation=? AND a.boot_id=? AND a.policy_id=? AND a.policy_sha256=?`)
    .bind(identity.node_id, identity.assignment_generation, identity.boot_id, identity.policy_id, identity.policy_sha256).first<StoredAuthority>();
  if (!row) throw new IngestError(409, 'v3_statistics_authority_missing', 'Original applied statistics authority is unavailable.');
  let policy: DeviceConfigV3, capabilities: DeviceCapabilitiesV3;
  try {
    const frozen = await validateFrozenDeviceConfigV3(JSON.parse(row.envelope_json)); policy = frozen.policy;
    capabilities = validateDeviceCapabilitiesV3(JSON.parse(row.capability_json));
    const ack = JSON.parse(row.acknowledgement_json) as Record<string, unknown>;
    if (frozen.policy_sha256 !== identity.policy_sha256 || policy.policy_id !== identity.policy_id || policy.node_id !== identity.node_id || policy.revision !== row.revision ||
      policy.assignment_generation !== identity.assignment_generation || policy.control.activation.boot_id !== identity.boot_id ||
      capabilities.boot_id !== identity.boot_id || capabilities.node_id !== identity.node_id ||
      await capabilityDigestV3(capabilities) !== row.capability_sha256 || policy.control.capability_sha256 !== row.capability_sha256 ||
      policy.custody.placement_id !== row.placement_id || Date.parse(policy.control.activation.not_before) !== row.not_before_ms ||
      Date.parse(policy.control.activation.expires_at) !== row.expires_at_ms || Date.parse(policy.custody.accept_until) !== row.accept_until_ms ||
      Date.parse(capabilities.issued_at) !== row.issued_at_ms || Date.parse(capabilities.expires_at) !== row.capability_expires_at_ms ||
      !Number.isFinite(Date.parse(row.received_at)) || !ack || typeof ack !== 'object' || Array.isArray(ack) ||
      ack.protocol !== 'campuspulse/3' || ack.node_id !== identity.node_id || ack.boot_id !== identity.boot_id ||
      ack.policy_id !== identity.policy_id || ack.policy_sha256 !== identity.policy_sha256 || ack.assignment_generation !== identity.assignment_generation ||
      ack.apply_seq !== row.apply_seq || ack.state !== 'applied') throw new Error('Registry mismatch');
    const negotiated = await negotiateDeviceConfigV3(frozen, capabilities, { node_id: identity.node_id, boot_id: identity.boot_id,
      now: row.received_at, last_assignment_generation: identity.assignment_generation - 1,
      closed_window_seq: ack.closed_window_seq, closed_segment_seq: ack.closed_segment_seq, window_open: ack.window_open, segment_open: ack.segment_open });
    if (negotiated.state !== 'compatible') throw new Error('Historical applied capability mismatch');
  } catch { throw new IngestError(503, 'v3_registry_invalid', 'Registered statistics authority failed integrity verification.'); }
  assertV3StatisticsPolicy(policy, env, capabilities.producer_version);
  return { identity, policy, capabilities, applied_at_ms: Date.parse(row.received_at), accept_until_ms: row.accept_until_ms, state_version: row.state_version };
}
/** Caller supplies conservative UTC bounds, already including uncertainty. Re-evaluate inside commit. */
export function statisticsCaptureAssertion(authority: StatisticsAuthority, startMs: number, endMs: number): AuthAssertion {
  const { identity: i, policy: p, capabilities: c } = authority;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs < startMs) {
    throw new IngestError(422, 'v3_statistics_time_unprovable', 'Known conservative observation time is required.');
  }
  return { sql: `EXISTS(SELECT 1 FROM device_statistics_authorizations_v3 a
    JOIN device_acknowledgements_v3 k ON k.node_id=a.node_id AND k.generation=a.generation AND k.boot_id=a.boot_id AND k.state='applied'
    JOIN device_statistics_lease_spans_v3 s ON s.node_id=a.node_id AND s.generation=a.generation
    JOIN placements p ON p.id=? AND p.node_id=a.node_id
    LEFT JOIN placement_closures pc ON pc.placement_id=p.id AND pc.node_id=p.node_id
    WHERE a.node_id=? AND a.generation=? AND a.boot_id=? AND a.policy_sha256=? AND a.accept_until_ms>${STATISTICS_NOW_SQL}
    AND s.start_ms<=? AND s.end_ms>=? AND s.end_ms>?
    AND p.valid_from_ms<=? AND COALESCE(pc.valid_until_ms,p.valid_until_ms,9223372036854775807)>=?
    AND ?>=? AND ?<=? AND ?>=? AND ?<=? AND ?<=${STATISTICS_NOW_SQL})`,
    bindings: [p.custody.placement_id, i.node_id, i.assignment_generation, i.boot_id, i.policy_sha256,
      startMs, endMs, startMs, startMs, endMs, startMs, Date.parse(p.control.activation.not_before), endMs, Date.parse(p.control.activation.expires_at),
      startMs, Date.parse(c.issued_at), endMs, Date.parse(c.expires_at), endMs] };
}
/** Safe to run independently of gates and other cleanup jobs; lifetime span_count is retained. */
export async function cleanupStatisticsLeaseSpans(env: Env): Promise<void> {
  if (!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_statistics_lease_spans_v3'").first()) return;
  await env.DB.prepare(`DELETE FROM device_statistics_lease_spans_v3 WHERE rowid IN
    (SELECT rowid FROM device_statistics_lease_spans_v3 WHERE accept_until_ms<=${STATISTICS_NOW_SQL} ORDER BY accept_until_ms LIMIT 256)`).run();
}
