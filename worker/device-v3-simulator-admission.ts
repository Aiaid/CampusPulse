import type { DeviceConfigV3 } from './device-v3-config';
import { V3_VEHICLE_CANDIDATE_RULESET } from './device-v3-statistics-validation';

/** A narrow production exception; never add this producer to the release list. */
export function admitsV3SimulatorStatistics(p: DeviceConfigV3, env: {
  DEVICE_V3_SIMULATOR_NODE_IDS?: string;
  DEVICE_V3_INGEST_ENABLED?: string;
  CPRAW_ARCHIVE_ENABLED?: string;
}, producer: string): boolean {
  let nodes: unknown;
  try { nodes = JSON.parse(env.DEVICE_V3_SIMULATOR_NODE_IDS ?? '[]'); } catch { return false; }
  if (!Array.isArray(nodes) || nodes.length > 16 || new Set(nodes).size !== nodes.length ||
    nodes.some(node => typeof node !== 'string' || !/^sim-live-[a-z0-9][a-z0-9_-]{0,54}$/.test(node))) return false;
  return producer === 'synthetic-statistics/1' && nodes.includes(p.node_id) &&
    env.DEVICE_V3_INGEST_ENABLED === 'false' && env.CPRAW_ARCHIVE_ENABLED === '0' &&
    p.custody.dataset === 'field' && p.custody.purpose === 'site_observation' &&
    p.collection.mode === 'fixed_point' && p.local_raw.mode === 'off' &&
    p.evidence.mode === 'statistics' && p.evidence.extractor_version === 'cp-v3-stats/1' &&
    ['unclassified-v1', V3_VEHICLE_CANDIDATE_RULESET].includes(p.evidence.ruleset_version) &&
    (p.temporal?.mode === 'off' || p.temporal?.mode === 'rolling' && p.temporal.report_mode === 'off') &&
    p.uplink.enabled && p.uplink.transport === 'mqtt_tls' &&
    p.uplink.streams.length === 2 && p.uplink.streams.includes('window_statistics') && p.uplink.streams.includes('node_status') &&
    p.uplink.raw_sample.mode === 'off' && p.uplink.archive.mode === 'off';
}
