import { capabilityDigestV3, freezeDeviceConfigV3, type DeviceCapabilitiesV3, type DeviceConfigV3 } from '../../worker/device-v3-config';
import { sha256 } from '../../worker/ingest';
import { v3Ack, v3Capabilities, v3Policy } from './device-v3-fixtures';
import type { V3Envelope, V3FeatureItem, V3StatusItem, DeviceV3IngestEnv } from '../../worker/device-v3-ingest-validation';

export const INGEST_V3_FLAGS = { DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_INGEST_ENABLED: 'true',
  DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-only/1"]', DEVICE_V3_EXTRACTOR_VERSIONS: '["synthetic-extractor/1"]' };
export async function ingestV3Fixture(node = 'cp-demo-01', placement = 'library-node-01', now = Date.now(), generation = 1) {
  const caps = v3Capabilities(node, now);
  caps.summary = { max_addresses: 512, max_bins: 60, max_window_ms: 300000 };
  caps.features = { schemas: ['ble-feature-evidence/1'], extractor_versions: ['synthetic-extractor/1'], fields: ['company_ids', 'appearance', 'service_uuids'],
    populations: ['all_worker_reports', 'deterministic_sample'], max_reports_per_window: 100000, max_bytes_per_window: 2000000 };
  caps.uplink = { transports: ['https'], streams: ['feature_summaries', 'node_status'], max_batch_items: 128, max_body_bytes: 65536, max_sample_reports_per_window: 0, cpraw_archive: false };
  caps.queue = { media: [{ medium: 'flash_journal', usable_bytes: 1048576, max_items: 10000, power_loss_recovery: true }] };
  const policy = await v3Policy(caps, generation, now);
  policy.collection.mode = 'fixed_point';
  policy.collection.summary = { enabled: true, window_ms: 1000, bin_ms: 1000, max_addresses: 2 };
  policy.local_raw = { mode: 'off' };
  policy.evidence = { mode: 'features', schema: 'ble-feature-evidence/1', extractor_version: 'synthetic-extractor/1', population: 'all_worker_reports',
    sample_every_n: null, fields: [{ kind: 'company_ids', max_values_per_identifier: 16 }], max_reports_per_window: 100, max_bytes_per_window: 65536, overflow: 'count_and_mark_partial' };
  policy.uplink = { enabled: true, transport: 'https', streams: ['feature_summaries', 'node_status'], max_batch_items: 128, max_body_bytes: 65536,
    retry: { min_delay_ms: 1000, max_delay_ms: 5000, max_attempts: 3 }, raw_sample: { mode: 'off' }, archive: { mode: 'off' } };
  policy.local_queue = { mode: 'durable', medium: 'flash_journal', max_bytes: 262144, max_items: 128, control_reserve_bytes: 4096, control_reserve_items: 4,
    stream_reserves: [{ stream: 'feature_summaries', bytes: 65536, items: 4 }, { stream: 'node_status', bytes: 65536, items: 4 }],
    high_water_percent: 80, full_behavior: 'pause_collection', recovery: 'exact_frozen_batches' };
  policy.custody = { ...policy.custody, dataset: 'controlled_test', purpose: 'controlled_test', placement_id: placement, association_scope: 'window', max_upload_bytes_per_day: 262144 };
  policy.control.capability_sha256 = await capabilityDigestV3(caps);
  return { caps, policy, now, appliedAt: now - 10000 };
}
export type IngestV3Fixture = Awaited<ReturnType<typeof ingestV3Fixture>>;
/** Directly seed synthetic historical server events. No producer/physical claim. */
export async function seedIngestV3(db: D1Database, fixture: IngestV3Fixture, applied = true, closedWindow = 3, closedSegment = 2) {
  const { caps, policy: p, appliedAt } = fixture, frozen = await freezeDeviceConfigV3(p), digest = await capabilityDigestV3(caps);
  const ack = { ...await v3Ack(p, p.assignment_generation), node_id: p.node_id, closed_window_seq: closedWindow, closed_segment_seq: closedSegment };
  await db.batch([
    db.prepare('INSERT INTO device_boots_v3(node_id,boot_id,first_seen_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(p.node_id, caps.boot_id, new Date(appliedAt - 1000).toISOString()),
    db.prepare('INSERT INTO device_capabilities_v3(node_id,capability_id,boot_id,capability_sha256,capability_json,issued_at_ms,expires_at_ms,registered_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(p.node_id, caps.capability_id, caps.boot_id, digest, JSON.stringify(caps), Date.parse(caps.issued_at), Date.parse(caps.expires_at), new Date(appliedAt - 1000).toISOString()),
    db.prepare('INSERT INTO device_assignments_v3(node_id,generation,policy_id,revision,boot_id,capability_sha256,policy_sha256,envelope_json,placement_id,not_before_ms,expires_at_ms,assigned_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(p.node_id, p.assignment_generation, p.policy_id, p.revision, caps.boot_id, digest, frozen.policy_sha256, JSON.stringify(frozen), p.custody.placement_id,
        Date.parse(p.control.activation.not_before), Date.parse(p.control.activation.expires_at), new Date(appliedAt - 500).toISOString()),
    db.prepare(`INSERT INTO device_control_v3(node_id,boot_id,registration_seq,uptime_ms,registration_sha256,capability_sha256,registered_at,state_version,desired_generation,applied_generation,apply_seq)
      VALUES(?,?,1,1000,?,?,?,1,?,?,?) ON CONFLICT(node_id) DO UPDATE SET desired_generation=excluded.desired_generation,
      applied_generation=COALESCE(excluded.applied_generation,applied_generation),apply_seq=MAX(apply_seq,excluded.apply_seq),state_version=state_version+1`)
      .bind(p.node_id, caps.boot_id, '0'.repeat(64), digest, new Date(appliedAt - 1000).toISOString(), p.assignment_generation, applied ? p.assignment_generation : null, applied ? p.assignment_generation : 0),
    ...(applied ? [db.prepare('INSERT INTO device_acknowledgements_v3(node_id,generation,boot_id,apply_seq,state,body_sha256,acknowledgement_json,received_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(p.node_id, p.assignment_generation, caps.boot_id, p.assignment_generation, 'applied', await sha256(new TextEncoder().encode(JSON.stringify(ack))), JSON.stringify(ack), new Date(appliedAt).toISOString())] : []),
  ]);
  return frozen;
}
export async function featureBatchV3(f: IngestV3Fixture, seq = 1, windowSeq = 4): Promise<V3Envelope & { items: V3FeatureItem[] }> {
  const frozen = await freezeDeviceConfigV3(f.policy), known = (value: number) => ({ value, reason: null });
  return { protocol: 'campuspulse/3', schema: 'device-ingest/3', batch_id: crypto.randomUUID(), node_id: f.policy.node_id, boot_id: f.caps.boot_id,
    placement_id: f.policy.custody.placement_id!, policy_id: f.policy.policy_id, policy_sha256: frozen.policy_sha256, assignment_generation: f.policy.assignment_generation,
    dataset: 'controlled_test', producer_version: f.caps.producer_version, stream: 'feature_summaries', items: [{ seq, evidence: {
      schema: 'ble-feature-evidence/1', extractor_version: 'synthetic-extractor/1',
      scope: { node_id: f.policy.node_id, boot_id: f.caps.boot_id, placement_id: f.policy.custody.placement_id!, capture_config_id: f.policy.policy_id,
        policy_sha256: frozen.policy_sha256, dataset: 'controlled_test', window_seq: windowSeq },
      identity: { scheme: 'window_token', token: seq.toString(16).padStart(32, '0'), address_type: 'random' },
      observed_time: { start: { mono_ms: 5000, utc_ms: f.now - 5000, clock_epoch: 1, uncertainty_ms: 0 },
        end: { mono_ms: 6000, utc_ms: f.now - 4000, clock_epoch: 1, uncertainty_ms: 0 } },
      population: 'all_worker_reports', sampling: null, extraction_state: 'complete',
      reports: { available_reports: 2, examined_reports: 2, parsed_reports: 2, malformed_reports: 0, unsupported_reports: 0, unexamined_reports: 0, parsed_adv_reports: 1, parsed_scan_response_reports: 1 },
      source_counters: { identifier_worker_reports: known(2), window_reports_seen: known(100), window_reports_aggregated: known(100), window_queue_drops: known(0),
        window_address_overflow: known(0), identifier_intentional_skips: known(0), identifier_pressure_skips: known(0) },
      features: { company_ids: { values: [{ value: 76, support_reports: 2, adv_reports: 1, scan_response_reports: 1, conflicting: false }], unavailable_reason: null, overflow: 0, overflow_reason: null } }
    } }] };
}
export async function statusBatchV3(f: IngestV3Fixture, seq = 1): Promise<V3Envelope & { items: V3StatusItem[] }> {
  const base = await featureBatchV3(f);
  return { ...base, stream: 'node_status', items: [{ seq, schema: 'device-status/3', time: { mono_ms: 9000, utc_ms: f.now - 1000, clock_epoch: 1, uncertainty_ms: 0 },
    uptime_ms: 9000, collection_state: 'running', queue: { feature_summaries: { pending_items: 1, pending_bytes: 1000 }, node_status: { pending_items: 1, pending_bytes: 1000 } },
    losses: { feature_items_dropped: 0, feature_bytes_dropped: 0, status_samples_coalesced: 0, upload_failures: 0, ack_failures: 0 } }] };
}
