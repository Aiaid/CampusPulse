import { capabilityDigestV3, type DeviceCapabilitiesV3, type DeviceConfigV3 } from '../../worker/device-v3-config';
import { v3Capabilities, v3Policy } from './device-v3-fixtures';
/** Synthetic negotiation values only. Never register as an actual device claim. */
export function statisticsCapabilities(node = 'synthetic-stats-notregister', now = Date.now()): DeviceCapabilitiesV3 {
  return { ...v3Capabilities(node, now), capability_id: 'synthetic-stats-notregister', producer_version: 'synthetic-statistics/1',
    summary: { max_addresses: 512, max_bins: 12, max_window_ms: 60000 },
    statistics: { schemas: ['window-statistics/1'], extractor_versions: ['cp-v3-stats/1'], ruleset_versions: ['unclassified-v1'] },
    temporal: { slice_ms: [1000, 2000, 5000], max_history_ms: 600000, max_tracks: 512, max_open_events: 64, max_event_ms: 3600000,
      event_schemas: ['candidate-event/1'], report_modes: ['off', 'terminal_only', 'revisions'] },
    uplink: { transports: ['https'], streams: ['window_statistics', 'node_status', 'candidate_events'], max_batch_items: 1, max_body_bytes: 2048,
      max_sample_reports_per_window: 0, cpraw_archive: false },
    queue: { media: [{ medium: 'flash_journal', usable_bytes: 8192, max_items: 4, power_loss_recovery: true }] },
    resources: { max_working_bytes: 4194304, max_storage_write_bytes_per_day: 16777216, tf_usable_bytes: 33554432 } };
}
export async function statisticsPolicy(caps = statisticsCapabilities(), placement = 'synthetic-place-notregister', generation = 1, now = Date.now()): Promise<DeviceConfigV3> {
  const p = await v3Policy(caps, generation, now);
  return { ...p, policy_id: `synthetic-stats-notregister-${generation}`,
    collection: { ...p.collection, mode: 'fixed_point', summary: { enabled: true, window_ms: 60000, bin_ms: 5000, max_addresses: 512 } },
    local_raw: { mode: 'off' }, evidence: { mode: 'statistics', schema: 'window-statistics/1', extractor_version: 'cp-v3-stats/1', ruleset_version: 'unclassified-v1' },
    temporal: { mode: 'rolling', slice_ms: 2000, history_ms: 600000, max_tracks: 512, max_open_events: 64, max_event_ms: 3600000,
      gap_ms: 10000, report_mode: 'off', min_update_ms: 60000 },
    uplink: { enabled: true, transport: 'https', streams: ['window_statistics', 'node_status'], max_batch_items: 1, max_body_bytes: 2048,
      retry: { min_delay_ms: 1000, max_delay_ms: 60000, max_attempts: 10 }, raw_sample: { mode: 'off' }, archive: { mode: 'off' } },
    local_queue: { mode: 'durable', medium: 'flash_journal', max_bytes: 6144, max_items: 3, control_reserve_bytes: 2048, control_reserve_items: 1,
      stream_reserves: [{ stream: 'window_statistics', bytes: 2048, items: 1 }, { stream: 'node_status', bytes: 2048, items: 1 }],
      high_water_percent: 80, full_behavior: 'pause_collection', recovery: 'exact_frozen_batches' },
    resources: { working_bytes: 4194304, storage_write_bytes_per_day: 8388608 },
    custody: { dataset: 'controlled_test', purpose: 'controlled_test', placement_id: placement, association_scope: 'window', source_retention_hours: 1,
      derived_retention_hours: 1, accept_until: new Date(now + 7200000).toISOString(), max_upload_bytes_per_day: 8388608 },
    control: { ...p.control, capability_sha256: await capabilityDigestV3(caps), lease: { ...p.control.lease, on_uplink_expiry: 'drain_frozen_until_accept_until' } } };
}
