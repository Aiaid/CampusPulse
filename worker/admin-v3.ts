import type { Env } from './types';
import { IngestError, parseIngestJson } from './strict-json';
import { json, readBytes } from './http';
import { capabilityDigestV3, freezeDeviceConfigV3, negotiateDeviceConfigV3, validateDeviceCapabilitiesV3, type DeviceConfigV3 } from './device-v3-config';
import { assertV3StatisticsPolicy } from './device-v3-statistics-policy';

function invalid(code: string, message: string): never { throw new IngestError(422, code, message); }
const body = async (request: Request) => {
 const value = parseIngestJson(await readBytes(request, 32768));
 if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('invalid_device_v3', 'Provide a V3 object.');
 return value as Record<string, unknown>;
};
async function snapshot(env: Env, node: string) {
 const row = await env.DB.prepare(`SELECT c.boot_id,c.desired_generation,c.capability_sha256,k.capability_json FROM device_control_v3 c
 JOIN device_capabilities_v3 k ON k.node_id=c.node_id AND k.capability_sha256=c.capability_sha256 WHERE c.node_id=?`).bind(node)
 .first<{boot_id:string;desired_generation:number|null;capability_sha256:string;capability_json:string}>();
 if (!row) throw new IngestError(409, 'v3_capabilities_required', 'The device must register its own V3 capabilities before policy preparation.');
 const caps = validateDeviceCapabilitiesV3(JSON.parse(row.capability_json));
 if (caps.node_id !== node || caps.boot_id !== row.boot_id || await capabilityDigestV3(caps) !== row.capability_sha256)
  throw new IngestError(503, 'v3_registry_invalid', 'Capability integrity verification failed.');
 return { ...row, caps, generation: row.desired_generation ?? 0 };
}
async function validate(env: Env, policy: unknown, expected: unknown) {
 const frozen = await freezeDeviceConfigV3(policy), p = frozen.policy;
 const state = await snapshot(env, p.node_id);
 if (expected !== state.generation || p.assignment_generation !== state.generation + 1)
  throw new IngestError(409, 'v3_generation_conflict', 'Refresh the current generation before preparing a new assignment.');
 assertV3StatisticsPolicy(p, env, state.caps.producer_version);
 if (!p.uplink.enabled || p.uplink.transport !== 'mqtt_tls' || p.local_raw.mode !== 'off')
  invalid('v3_admin_profile_unsupported', 'This management workflow supports native MQTT small statistics with raw recording off.');
 const negotiated = await negotiateDeviceConfigV3(frozen, state.caps, { node_id: p.node_id, boot_id: state.boot_id,
  now: new Date().toISOString(), last_assignment_generation: state.generation, closed_window_seq: 0, closed_segment_seq: 0, window_open: true, segment_open: true });
 const issues: {code:string;path:string}[] = negotiated.issues.filter(i => !['boundary_not_ready', 'policy_not_yet_valid'].includes(i.code));
 const placement = await env.DB.prepare(`SELECT p.id FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id
 WHERE p.id=? AND p.node_id=? AND p.valid_from_ms<=? AND COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)>?`)
 .bind(p.custody.placement_id,p.node_id,Date.now(),Date.now()).first();
 if (!placement) issues.push({ code: 'policy_incompatible', path: 'custody.placement_id' });
 if (Math.min(Date.parse(p.control.activation.expires_at),Date.parse(state.caps.expires_at))-Math.max(Date.now(),Date.parse(p.control.activation.not_before)) <= (p.collection.summary.enabled ? p.collection.summary.window_ms : 0))
  issues.push({ code: 'policy_expired', path: 'control.activation.expires_at' });
 return { valid: issues.length === 0, state: issues.length ? 'rejected' : 'compatible', issues,
  policy: p, policy_sha256: frozen.policy_sha256, expected_generation: state.generation, applied: false, requires_device_ack: true };
}
/** Called only after the administrator cookie and mutation origin have been verified. */
export async function handleAdminV3(request: Request, env: Env, route: string): Promise<Response | null> {
 if (!['/device-v3/prepare','/device-v3/validate'].includes(route)) return null;
 if (request.method !== 'POST') throw new IngestError(405,'method_not_allowed','Use POST.');
 const o = await body(request);
 if (route.endsWith('/validate')) {
  if (Object.keys(o).sort().join(',') !== 'expected_generation,policy') invalid('invalid_device_v3','Provide policy and expected_generation only.');
  return json(await validate(env,o.policy,o.expected_generation));
 }
 if (Object.keys(o).some(k => !['node_id','placement_id','dataset'].includes(k)) || typeof o.node_id !== 'string' || typeof o.placement_id !== 'string')
  invalid('invalid_device_v3','Provide node_id, placement_id and optional dataset.');
 const node = o.node_id as string, placement = o.placement_id as string;
 const state = await snapshot(env,node), c=state.caps, now=Date.now();
 const dataset=o.dataset??'controlled_test';
 if (!['field','controlled_test','demo'].includes(String(dataset))) invalid('invalid_device_v3','Unsupported dataset.');
 const medium=c.queue?.media.find(m=>m.power_loss_recovery && ['flash_journal','tf_journal'].includes(m.medium));
 if (!medium || !c.resources || !c.summary || !c.uplink || !c.scanner || !c.statistics || !c.temporal ||
  !c.uplink.transports.includes('mqtt_tls') || c.summary.max_window_ms<30000 || c.summary.max_bins<6 || medium.max_items<3)
  invalid('v3_policy_incompatible','The registered device does not support the native MQTT small-statistics profile.');
 const size=Math.min(c.uplink.max_body_bytes,2048), window=c.summary.max_window_ms>=60000&&c.summary.max_bins>=12?60000:30000, generation=state.generation+1;
 const p:DeviceConfigV3={schema:'device-config/3',protocol:'campuspulse/3',policy_id:`stats-${crypto.randomUUID()}`,node_id:node,revision:1,assignment_generation:generation,
 collection:{enabled:true,mode:'fixed_point',scan:{mode:'passive',interval_units:160,window_units:160,duplicate_filter:false,phys:['1m']},
  summary:{enabled:true,window_ms:window,bin_ms:5000,max_addresses:Math.min(512,c.summary.max_addresses)}},
 local_raw:{mode:'off'},evidence:{mode:'statistics',schema:'window-statistics/1',extractor_version:'cp-v3-stats/1',ruleset_version:'unclassified-v1'},
 temporal:{mode:'rolling',slice_ms:2000,history_ms:Math.min(600000,c.temporal.max_history_ms),max_tracks:Math.min(512,c.temporal.max_tracks),max_open_events:Math.min(64,c.temporal.max_open_events),max_event_ms:Math.min(3600000,c.temporal.max_event_ms),gap_ms:10000,report_mode:'off',min_update_ms:60000},
 uplink:{enabled:true,transport:'mqtt_tls',streams:['window_statistics','node_status'],max_batch_items:1,max_body_bytes:size,retry:{min_delay_ms:1000,max_delay_ms:60000,max_attempts:10},raw_sample:{mode:'off'},archive:{mode:'off'}},
 local_queue:{mode:'durable',medium:medium.medium,max_bytes:medium.usable_bytes,max_items:medium.max_items,control_reserve_bytes:size,control_reserve_items:1,
  stream_reserves:[{stream:'window_statistics',bytes:size,items:1},{stream:'node_status',bytes:size,items:1}],high_water_percent:80,full_behavior:'pause_collection',recovery:'exact_frozen_batches'},
 resources:{working_bytes:c.resources.max_working_bytes,storage_write_bytes_per_day:Math.min(8388608,c.resources.max_storage_write_bytes_per_day)},
 custody:{dataset:dataset as 'field'|'controlled_test'|'demo',purpose:dataset==='field'?'site_observation':dataset==='demo'?'demonstration':'controlled_test',placement_id:placement,association_scope:'window',source_retention_hours:24,derived_retention_hours:24,accept_until:new Date(now+86400000).toISOString(),max_upload_bytes_per_day:8388608},
 control:{capability_sha256:state.capability_sha256,activation:{boot_id:state.boot_id,boundary:'closed_window_and_segment',after_window_seq:0,after_segment_seq:0,not_before:new Date(now).toISOString(),expires_at:c.expires_at},lease:{duration_ms:120000,on_collection_expiry:'pause',on_raw_expiry:'stop_recording',on_uplink_expiry:'drain_frozen_until_accept_until'}}};
 return json(await validate(env,p,state.generation));
}
