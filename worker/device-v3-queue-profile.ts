import type { DeviceCapabilitiesV3, DeviceConfigV3, V3NegotiationResult } from './device-v3-config';

type QueueMedium = NonNullable<DeviceCapabilitiesV3['queue']>['media'][number];

/** Compatibility adapter for the existing firmware's fixed TF queue layout.
 * Capabilities currently advertise ceilings, not per-stream reservations. */
export function isWaveshareSmallQueue(caps: DeviceCapabilitiesV3, medium: QueueMedium): boolean {
 return caps.producer_version === 'cp-v3-small/1' && medium.medium === 'tf_journal' &&
  medium.power_loss_recovery && medium.usable_bytes === 24576 && medium.max_items === 12 && caps.uplink?.max_body_bytes === 2048;
}

/** New management policies only; retained assignments keep their original identity. */
export function fixedV3QueueProfileIssues(p: DeviceConfigV3, caps: DeviceCapabilitiesV3): V3NegotiationResult['issues'] {
 const q=p.local_queue;
 if(p.evidence.mode !== 'statistics' || caps.producer_version !== 'cp-v3-small/1' || q.mode === 'disabled' || q.medium !== 'tf_journal') return [];
 const medium=caps.queue?.media.find(m=>m.medium === q.medium);
 const issues:V3NegotiationResult['issues']=[];
 const require=(ok:boolean,path:string)=>{if(!ok)issues.push({code:'unsupported_capability',path});};
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
