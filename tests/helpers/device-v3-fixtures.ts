import { capabilityDigestV3, freezeDeviceConfigV3, type DeviceCapabilitiesV3, type DeviceConfigV3 } from '../../worker/device-v3-config';
export const V3_BOOT = '11111111-1111-4111-8111-111111111111';
/** Synthetic declarations only; no board support or physical capacity is implied. */
export function v3Capabilities(node = 'cp-demo-01', now = Date.now()): DeviceCapabilitiesV3 {
  return { schema: 'device-capabilities/1', capability_id: 'synthetic-caps', node_id: node, boot_id: V3_BOOT,
    producer_version: 'synthetic-only/1', policy_schemas: ['device-config/3'],
    issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(),
    scanner: { modes: ['passive'], phys: ['1m'], duplicate_filter: [false], min_interval_units: 4, max_interval_units: 16384 },
    local_raw: { formats: ['cpraw/1'], max_segment_bytes: 1048576, min_sync_interval_ms: 1000 },
    resources: { max_working_bytes: 1048576, max_storage_write_bytes_per_day: 16777216, tf_usable_bytes: 33554432 } };
}
export async function v3Policy(caps = v3Capabilities(), generation = 1, now = Date.now()): Promise<DeviceConfigV3> {
  return { schema: 'device-config/3', protocol: 'campuspulse/3', policy_id: `synthetic-policy-${generation}`, node_id: caps.node_id,
    revision: 1, assignment_generation: generation,
    collection: { enabled: true, mode: 'mobile_research', scan: { mode: 'passive', interval_units: 160, window_units: 160, duplicate_filter: false, phys: ['1m'] }, summary: { enabled: false } },
    local_raw: { mode: 'tf_cpraw', format: 'cpraw/1', max_segment_bytes: 1048576, max_total_bytes: 16777216, min_free_bytes: 1048576, sync_interval_ms: 1000, full_behavior: 'stop_recording' },
    evidence: { mode: 'off' }, uplink: { enabled: false }, local_queue: { mode: 'disabled' },
    resources: { working_bytes: 524288, storage_write_bytes_per_day: 1048576 },
    custody: { dataset: 'research_unassigned', purpose: 'research', placement_id: null, association_scope: 'segment',
      source_retention_hours: 1, derived_retention_hours: 1, accept_until: new Date(now + 7_200_000).toISOString(), max_upload_bytes_per_day: 0 },
    control: { capability_sha256: await capabilityDigestV3(caps), activation: { boot_id: caps.boot_id, boundary: 'closed_window_and_segment',
      after_window_seq: 3, after_segment_seq: 2, not_before: new Date(now - 30_000).toISOString(), expires_at: new Date(now + 1_800_000).toISOString() },
      lease: { duration_ms: 120000, on_collection_expiry: 'pause', on_raw_expiry: 'stop_recording', on_uplink_expiry: 'pause' } } };
}
export const v3Registration = (caps: DeviceCapabilitiesV3, seq = 1, uptime = 1000) => ({ protocol: 'campuspulse/3', registration_seq: seq, uptime_ms: uptime, capabilities: caps });
export async function v3Ack(p: DeviceConfigV3, seq = 1) {
  return { protocol: 'campuspulse/3', boot_id: p.control.activation.boot_id, policy_id: p.policy_id,
    policy_sha256: (await freezeDeviceConfigV3(p)).policy_sha256, assignment_generation: p.assignment_generation, apply_seq: seq, state: 'applied',
    closed_window_seq: 3, closed_segment_seq: 2, window_open: false, segment_open: false };
}
