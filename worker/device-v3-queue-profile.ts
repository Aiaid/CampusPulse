import type { DeviceCapabilitiesV3, DeviceConfigV3, V3NegotiationResult } from './device-v3-config';

type QueueMedium = NonNullable<DeviceCapabilitiesV3['queue']>['media'][number];

/** Compatibility adapters for the existing firmware's fixed queue layouts.
 * Capabilities currently advertise ceilings, not per-stream reservations. */
export function isWaveshareSmallQueue(caps: DeviceCapabilitiesV3, medium: QueueMedium): boolean {
 return caps.producer_version === 'cp-v3-small/1' && medium.medium === 'tf_journal' &&
  medium.power_loss_recovery && medium.usable_bytes === 24576 && medium.max_items === 12 && caps.uplink?.max_body_bytes === 2048;
}

export function isTEnergySmallQueue(caps: DeviceCapabilitiesV3, medium: QueueMedium): boolean {
 return caps.producer_version === 'cp-v3-small/1' && medium.medium === 'flash_journal' &&
  medium.power_loss_recovery && medium.usable_bytes === 3072 && medium.max_items === 3 && caps.uplink?.max_body_bytes === 1024;
}

/** Explicit compatibility tiers for the two shipped TE budget declarations.
 * A larger claim alone never upgrades legacy geometry or a different producer. */
export function tEnergySmallBudgets(caps: DeviceCapabilitiesV3, medium: QueueMedium) {
 if(!isTEnergySmallQueue(caps,medium))return null;
 const sustained=caps.resources?.max_storage_write_bytes_per_day===201326592;
 return {storage:sustained?201326592:Math.min(1048576,caps.resources?.max_storage_write_bytes_per_day??0),
  uplink:sustained?8388608:131072};
}

/** New management policies only; retained assignments keep their original identity. */
export function fixedV3QueueProfileIssues(p: DeviceConfigV3, caps: DeviceCapabilitiesV3): V3NegotiationResult['issues'] {
 const q=p.local_queue;
 if(p.evidence.mode !== 'statistics' || caps.producer_version !== 'cp-v3-small/1' || q.mode === 'disabled') return [];
 const medium=caps.queue?.media.find(m=>m.medium === q.medium);
 const issues:V3NegotiationResult['issues']=[];
 const require=(ok:boolean,path:string)=>{if(!ok)issues.push({code:'unsupported_capability',path});};
 if(medium && isTEnergySmallQueue(caps,medium)) {
  const budget=tEnergySmallBudgets(caps,medium)!;
  require(p.uplink.enabled && p.uplink.max_body_bytes === 1024,'uplink.max_body_bytes');
  require(q.max_bytes === 3072,'local_queue.max_bytes');
  require(q.max_items === 3,'local_queue.max_items');
  require(q.control_reserve_bytes === 1024,'local_queue.control_reserve_bytes');
  require(q.control_reserve_items === 1,'local_queue.control_reserve_items');
  require(q.stream_reserves.length === 2,'local_queue.stream_reserves');
  for(const stream of ['window_statistics','node_status']) {
   const reserve=q.stream_reserves.find(r=>r.stream === stream);
   require(reserve?.bytes === 1024,`local_queue.stream_reserves.${stream}.bytes`);
   require(reserve?.items === 1,`local_queue.stream_reserves.${stream}.items`);
  }
  require(p.custody.max_upload_bytes_per_day <= budget.uplink,'custody.max_upload_bytes_per_day');
  require(p.resources.working_bytes <= 4194304,'resources.working_bytes');
  require(p.resources.storage_write_bytes_per_day <= budget.storage,'resources.storage_write_bytes_per_day');
  return issues;
 }
 if(q.medium !== 'tf_journal') return [];
 if(!medium || !isWaveshareSmallQueue(caps,medium)) {
  require(false,'local_queue');
  return issues;
 }
 require(p.uplink.enabled && p.uplink.max_body_bytes === 2048,'uplink.max_body_bytes');
 require(q.max_bytes === 24576,'local_queue.max_bytes');
 require(q.max_items === 12,'local_queue.max_items');
 require(q.control_reserve_bytes === 4096,'local_queue.control_reserve_bytes');
 require(q.control_reserve_items === 2,'local_queue.control_reserve_items');
 const events=p.uplink.enabled && p.uplink.streams.includes('candidate_events');
 const expected=[{stream:'window_statistics',bytes:8192,items:4},{stream:'node_status',bytes:4096,items:2},
  ...(events?[{stream:'candidate_events',bytes:8192,items:4}]:[])];
 require(q.stream_reserves.length === expected.length,'local_queue.stream_reserves');
 for(const e of expected) {
  const r=q.stream_reserves.find(r=>r.stream === e.stream);
  require(r?.bytes === e.bytes,`local_queue.stream_reserves.${e.stream}.bytes`);
  require(r?.items === e.items,`local_queue.stream_reserves.${e.stream}.items`);
 }
 return issues;
}
