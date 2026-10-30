import type { Env } from './types';
import type { DeviceConfigV3 } from './device-v3-config';
import { validateFeatureEvidenceV3, type FeatureEvidenceV3 } from './device-v3-evidence';
import { IngestError } from './ingest-validation';

export type DeviceV3IngestEnv = Env & {
  DEVICE_V3_CONTROL_ENABLED?: string; DEVICE_V3_INGEST_ENABLED?: string;
  /** JSON arrays of reviewed exact version labels. Empty/missing fails closed. */
  DEVICE_V3_PRODUCER_VERSIONS?: string; DEVICE_V3_EXTRACTOR_VERSIONS?: string;
};
export type V3IngestPolicy = DeviceConfigV3 & {
  uplink: Extract<DeviceConfigV3['uplink'], { enabled: true }>;
  evidence: Extract<DeviceConfigV3['evidence'], { mode: 'features' }>;
  collection: DeviceConfigV3['collection'] & { summary: Extract<DeviceConfigV3['collection']['summary'], { enabled: true }> };
  local_queue: Exclude<DeviceConfigV3['local_queue'], { mode: 'disabled' }>;
};
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export function rejectV3(status: number, code: string): never {
  throw new IngestError(status, code, 'The v3 request cannot be accepted; preserve the original frozen batch.');
}
function versions(value: string | undefined): string[] {
  try {
    const list: unknown = JSON.parse(value ?? 'null');
    if (!Array.isArray(list) || list.length < 1 || list.length > 16 || list.some(v => typeof v !== 'string' || !LABEL.test(v)) || new Set(list).size !== list.length) return [];
    return list;
  } catch { return []; }
}
export function v3IngestEnabled(env: DeviceV3IngestEnv): boolean {
  return env.DEVICE_V3_CONTROL_ENABLED === 'true' && env.DEVICE_V3_INGEST_ENABLED === 'true';
}
export function supportsV3IngestPolicy(p: DeviceConfigV3): p is V3IngestPolicy {
  return p.uplink.enabled && p.uplink.transport === 'https' && p.uplink.streams.length === 2 &&
    p.uplink.streams.includes('feature_summaries') && p.uplink.streams.includes('node_status') &&
    p.uplink.raw_sample.mode === 'off' && p.uplink.archive.mode === 'off' && p.collection.enabled &&
    p.collection.summary.enabled && p.evidence.mode === 'features' && p.local_raw.mode === 'off' &&
    p.custody.association_scope === 'window' && p.custody.dataset !== 'research_unassigned' && p.custody.placement_id !== null &&
    p.local_queue.mode === 'durable' && p.control.lease.on_uplink_expiry === 'pause' &&
    p.control.lease.duration_ms > p.collection.summary.window_ms &&
    p.evidence.fields.every(f => ['service_uuids', 'company_ids', 'appearance'].includes(f.kind));
}
export function assertV3IngestPolicy(p: DeviceConfigV3, env: DeviceV3IngestEnv, producer?: string): asserts p is V3IngestPolicy {
  if (!v3IngestEnabled(env) || !supportsV3IngestPolicy(p)) rejectV3(422, 'v3_uplink_unavailable');
  if (!versions(env.DEVICE_V3_EXTRACTOR_VERSIONS).includes(p.evidence.extractor_version) ||
    producer !== undefined && !versions(env.DEVICE_V3_PRODUCER_VERSIONS).includes(producer)) rejectV3(422, 'v3_version_unavailable');
}
export function objectV3(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) rejectV3(422, 'invalid_v3_ingest');
  return v as Record<string, unknown>;
}
function string(v: unknown, re: RegExp): string { return typeof v === 'string' && re.test(v) ? v : rejectV3(422, 'invalid_v3_ingest'); }
export function numberV3(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : rejectV3(422, 'invalid_v3_ingest');
}
function choice<const T extends string>(v: unknown, choices: readonly T[]): T {
  return typeof v === 'string' && choices.includes(v as T) ? v as T : rejectV3(422, 'invalid_v3_ingest');
}
export interface V3IngestTime { mono_ms: number; utc_ms: number; clock_epoch: number; uncertainty_ms: number }
export function ingestTimeV3(value: unknown): V3IngestTime {
  const t = objectV3(value, ['mono_ms', 'utc_ms', 'clock_epoch', 'uncertainty_ms']);
  return { mono_ms: numberV3(t.mono_ms), utc_ms: numberV3(t.utc_ms, 0, 8640000000000000),
    clock_epoch: numberV3(t.clock_epoch), uncertainty_ms: numberV3(t.uncertainty_ms, 0, 5000) };
}
export const V3_LOSSES = ['feature_items_dropped', 'feature_bytes_dropped', 'status_samples_coalesced', 'upload_failures', 'ack_failures'] as const;
export interface V3StatusItem {
  seq: number; schema: 'device-status/3'; time: V3IngestTime; uptime_ms: number;
  collection_state: 'running' | 'paused' | 'failed';
  queue: Record<'feature_summaries' | 'node_status', { pending_items: number; pending_bytes: number }>;
  losses: Record<typeof V3_LOSSES[number], number>;
}
export interface V3FeatureItem { seq: number; evidence: FeatureEvidenceV3 }
export interface V3Envelope {
  protocol: 'campuspulse/3'; schema: 'device-ingest/3'; batch_id: string; node_id: string; boot_id: string; placement_id: string;
  policy_id: string; policy_sha256: string; assignment_generation: number;
  dataset: 'field' | 'demo' | 'controlled_test'; producer_version: string;
  stream: 'feature_summaries' | 'node_status'; items: unknown[];
}
export function validateV3Envelope(value: unknown): V3Envelope {
  const o = objectV3(value, ['protocol', 'schema', 'batch_id', 'node_id', 'boot_id', 'placement_id', 'policy_id', 'policy_sha256',
    'assignment_generation', 'dataset', 'producer_version', 'stream', 'items']);
  const stream = choice(o.stream, ['feature_summaries', 'node_status']);
  if (!Array.isArray(o.items) || o.items.length < 1 || o.items.length > 128 || stream === 'node_status' && o.items.length !== 1) rejectV3(422, 'invalid_v3_ingest');
  return { protocol: choice(o.protocol, ['campuspulse/3']), schema: choice(o.schema, ['device-ingest/3']),
    batch_id: string(o.batch_id, BOOT), node_id: string(o.node_id, ID), boot_id: string(o.boot_id, BOOT), placement_id: string(o.placement_id, ID),
    policy_id: string(o.policy_id, ID), policy_sha256: string(o.policy_sha256, HASH), assignment_generation: numberV3(o.assignment_generation, 1),
    dataset: choice(o.dataset, ['field', 'demo', 'controlled_test']), producer_version: string(o.producer_version, LABEL), stream, items: o.items };
}
export function validateV3Feature(value: unknown): V3FeatureItem {
  const o = objectV3(value, ['seq', 'evidence']);
  const evidence = validateFeatureEvidenceV3(o.evidence, { dictionary_version: 'unused/1', name_pattern_ids: [], template_ids: [] });
  if (evidence.ruleset !== undefined || evidence.dictionary !== undefined || evidence.features.name_pattern_ids !== undefined || evidence.features.template_ids !== undefined) rejectV3(422, 'invalid_v3_ingest');
  return { seq: numberV3(o.seq, 1, 0xffffffff), evidence };
}
export function validateV3Status(value: unknown): V3StatusItem {
  const o = objectV3(value, ['seq', 'schema', 'time', 'uptime_ms', 'collection_state', 'queue', 'losses']);
  const q = objectV3(o.queue, ['feature_summaries', 'node_status']), lo = objectV3(o.losses, [...V3_LOSSES]);
  const queue = (v: unknown) => { const p = objectV3(v, ['pending_items', 'pending_bytes']); return { pending_items: numberV3(p.pending_items), pending_bytes: numberV3(p.pending_bytes) }; };
  const losses = {} as V3StatusItem['losses'];
  for (const k of V3_LOSSES) losses[k] = numberV3(lo[k]);
  const time = ingestTimeV3(o.time), uptime_ms = numberV3(o.uptime_ms);
  if (time.mono_ms !== uptime_ms) rejectV3(422, 'invalid_v3_ingest');
  return { seq: numberV3(o.seq, 1, 0xffffffff), schema: choice(o.schema, ['device-status/3']), time, uptime_ms,
    collection_state: choice(o.collection_state, ['running', 'paused', 'failed']),
    queue: { feature_summaries: queue(q.feature_summaries), node_status: queue(q.node_status) }, losses };
}
/** Same sorted-key JSON convention as the v3 policy core; no digest prefix. */
export function canonicalV3Evidence(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalV3Evidence).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalV3Evidence((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
