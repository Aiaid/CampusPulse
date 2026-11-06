/** Bounded, administrator-approved same-boot scope transitions. HTTP authentication
 * belongs exclusively to device-v3-control; these entry points require its DB guard. */
import type { AuthAssertion } from './admin-auth';
import type { DeviceV3ControlEnv, TransitionContext, Control, Assignment } from './device-v3-control';
import { freezeDeviceConfigV3, negotiateDeviceConfigV3, type DeviceConfigV3 } from './device-v3-config';
import { assertV3StatisticsPolicy, STATISTICS_NOW_SQL as NOW } from './device-v3-statistics-policy';
import { json } from './http';
import { object, string, integer, choice, UUID, ID } from './validation';
import { IngestError } from './strict-json';
const HASH = /^[0-9a-f]{64}$/;
const GUARD_MS = 10000;
interface Intent {
  id: string; node_id: string; request_sha256: string; boot_id: string; capability_sha256: string;
  from_generation: number; source_policy_sha256: string; expected_startup_revision: number; old_placement_id: string;
  target_place_id: string; target_dataset: 'field' | 'controlled_test' | 'demo'; target_ruleset: string; target_kinds_json: string;
  grant_expires_at_ms: number; policy_ttl_ms: number; accept_grace_ms: number; created_at_ms: number; expires_at_ms: number;
  phase: string; state_version: number; cutover_ms: number | null; assignment_generation: number | null;
}
interface ReadyReceipt { body_sha256: string; receipt_json: string }
function conflict(code = 'v3_transition_conflict'): never { throw new IngestError(409, code, 'Transition authority or boundary changed. Refresh the current device state.'); }
function unsupported(): never { throw new IngestError(422, 'v3_transition_unsupported', 'A current applied normal MQTT statistics profile and approved online scope support are required.'); }
const SELECT = 'SELECT t.*,s.phase,s.state_version,s.cutover_ms,s.assignment_generation FROM device_scope_transitions_v3 t JOIN device_scope_transition_state_v3 s ON s.id=t.id';
const find = (env: DeviceV3ControlEnv, node: string, id: string) => env.DB.prepare(`${SELECT} WHERE t.node_id=? AND t.id=?`).bind(node,id).first<Intent>();
const receipt = (env: DeviceV3ControlEnv, node: string, id: string) => env.DB.prepare('SELECT body_sha256,receipt_json FROM device_scope_transition_receipts_v3 WHERE node_id=? AND id=?').bind(node,id).first<ReadyReceipt>();
const intentVersion = (t: Intent): AuthAssertion => ({ sql: 'EXISTS(SELECT 1 FROM device_scope_transition_state_v3 WHERE id=? AND node_id=? AND state_version=? AND phase=?)', bindings: [t.id,t.node_id,t.state_version,t.phase] });
const targetScope = (t: Pick<Intent,'target_place_id'|'target_kinds_json'>): AuthAssertion => ({
  sql: 'EXISTS(SELECT 1 FROM places WHERE id=? AND observation_kinds_json=?)', bindings: [t.target_place_id,t.target_kinds_json] });
const sourceIdentity = (t: Intent): AuthAssertion => ({ sql: `EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND boot_id=? AND capability_sha256=? AND desired_generation=? AND applied_generation=?)`,
  bindings: [t.node_id,t.boot_id,t.capability_sha256,t.from_generation,t.from_generation] });
const descriptor = (t: Intent) => ({ id:t.id, boot_id:t.boot_id, from_generation:t.from_generation,
  capability_sha256:t.capability_sha256, expires_at:new Date(t.expires_at_ms).toISOString(), phase:t.phase,
  target_place_id:t.target_place_id, target_dataset:t.target_dataset, target_ruleset:t.target_ruleset });
const status = (t: Intent) => ({ ...descriptor(t), state:t.phase, error_code:null, startup_grant_migrated:t.phase==='applied', expected_startup_revision:t.expected_startup_revision,
  assignment_generation:t.assignment_generation, cutover_ms:t.cutover_ms, created_at:new Date(t.created_at_ms).toISOString(),
  applied:t.phase==='applied', requires_device_ack:t.phase==='pending'||t.phase==='assigned' });

/** Applies to config, new ACK and lease, but never to immutable receipt recovery. */
export function transitionAuthority(node: string, generation: number): AuthAssertion {
  return { sql: `NOT EXISTS(SELECT 1 FROM device_scope_transition_state_v3 WHERE node_id=? AND assignment_generation=?) OR
    EXISTS(SELECT 1 FROM device_scope_transition_state_v3 s JOIN device_scope_transitions_v3 t ON t.id=s.id
      JOIN device_startup_state_v3 v ON v.node_id=t.node_id JOIN device_startup_grants_v3 g ON g.node_id=v.node_id AND g.revision=v.revision
      WHERE s.node_id=? AND s.assignment_generation=? AND t.grant_expires_at_ms>${NOW}
      AND ((s.phase='assigned' AND t.expires_at_ms>${NOW} AND v.revision=t.expected_startup_revision+1 AND g.enabled=0)
        OR (s.phase='applied' AND v.revision=t.expected_startup_revision+2 AND g.enabled=1 AND g.source_generation=s.assignment_generation)))`,
    bindings:[node,generation,node,generation] };
}

export async function onlineTransition(env: DeviceV3ControlEnv, old: Control, c: TransitionContext) {
  const caps = await c.trustedCapabilities(env,old.node_id,old.capability_sha256);
  if (!caps.online_control?.scope_rebind) return undefined;
  const t = await env.DB.prepare(`${SELECT} WHERE t.node_id=? AND s.phase IN ('pending','assigned')`).bind(old.node_id).first<Intent>();
  if (!t || t.expires_at_ms<=Date.now() || t.boot_id!==old.boot_id || t.capability_sha256!==old.capability_sha256) return undefined;
  const generation=t.phase==='pending'?t.from_generation:t.assignment_generation;
  if (generation!==old.desired_generation || t.phase==='pending' && old.applied_generation!==t.from_generation ||
      !await c.check(env,c.startupVersion(old.node_id,t.expected_startup_revision+(t.phase==='assigned'?1:0)))) return undefined;
  return descriptor(t);
}

export async function manageTransitions(request: Request, env: DeviceV3ControlEnv, node: string, authorization: AuthAssertion,
  c: TransitionContext, cancelId?: string): Promise<Response> {
  if (new URL(request.url).search) unsupported();
  if (cancelId) {
    string(cancelId,'transition.id',UUID);
    const { value }=await c.readBody(request); object(value,'transition.cancel',[]);
    const t=await find(env,node,cancelId); if (!t) conflict();
    if (t.phase==='cancelled') { await c.assertAuthorized(env,authorization); return json({protocol:'campuspulse/3',node_id:node,transition:status(t)}); }
    if (t.phase!=='pending') conflict('v3_transition_already_assigned');
    await c.atomic(env,authorization,[intentVersion(t)],[
      env.DB.prepare("UPDATE device_scope_transition_state_v3 SET phase='cancelled',state_version=state_version+1 WHERE id=?").bind(t.id),
      env.DB.prepare('INSERT INTO admin_audit(action,target,detail_json,created_at) VALUES(?,?,?,?)').bind('device_v3.transition_cancel',node,JSON.stringify({id:t.id}),new Date().toISOString()),
    ]);
    return json({protocol:'campuspulse/3',node_id:node,transition:status({...t,phase:'cancelled'})});
  }
  if (request.method==='GET') {
    const rows=await env.DB.prepare(`${SELECT} WHERE t.node_id=? ORDER BY t.created_at_ms DESC,t.id DESC LIMIT 64`).bind(node).all<Intent>();
    await c.assertAuthorized(env,authorization);
    const transitions=rows.results.map(t=>status(t.expires_at_ms<=Date.now()&&['pending','assigned'].includes(t.phase)?{...t,phase:'expired'}:t));
    return json({protocol:'campuspulse/3',node_id:node,transition:transitions[0]??null,transitions});
  }
  const {value,hash}=await c.readBody(request);
  const b=object(value,'transition',['request_id','expected_boot_id','expected_capability_sha256','expected_generation','expected_startup_revision',
    'target_place_id','target_dataset','target_ruleset','migrate_startup']);
  const id=string(b.request_id,'transition.request_id',UUID), boot=string(b.expected_boot_id,'transition.expected_boot_id',UUID),
    cap=string(b.expected_capability_sha256,'transition.expected_capability_sha256',HASH), generation=integer(b.expected_generation,'transition.expected_generation',1,Number.MAX_SAFE_INTEGER-1),
    revision=integer(b.expected_startup_revision,'transition.expected_startup_revision',1,Number.MAX_SAFE_INTEGER-2),
    place=string(b.target_place_id,'transition.target_place_id',ID), dataset=choice(b.target_dataset,'transition.target_dataset',['field','controlled_test','demo']),
    rules=string(b.target_ruleset,'transition.target_ruleset',/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/);
  if (b.migrate_startup!==true || env.DEVICE_V3_STARTUP_ENABLED!=='true') unsupported();
  const prior=await find(env,node,id);
  if (prior) { if (prior.request_sha256!==hash) conflict(); await c.assertAuthorized(env,authorization); return json({protocol:'campuspulse/3',node_id:node,transition:status(prior)}); }
  const old=await c.current(env,node), grant=await c.startupGrant(env,node);
  if (!old || old.boot_id!==boot || old.capability_sha256!==cap || old.desired_generation!==generation || old.applied_generation!==generation ||
      !grant?.enabled || grant.revision!==revision) conflict();
  const source=await c.assignment(env,node,generation), ack=await c.acknowledgement(env,node,generation);
  if (!source || !ack || JSON.parse(ack.acknowledgement_json).state!=='applied') conflict();
  const p=(await c.trustedEnvelope(source)).policy, caps=await c.trustedCapabilities(env,node,cap);
  assertV3StatisticsPolicy(p,env,caps.producer_version);
  if (!caps.online_control?.scope_rebind || p.uplink.transport!=='mqtt_tls' || !caps.statistics?.ruleset_versions.includes(rules)) unsupported();
  assertV3StatisticsPolicy({...p,evidence:{...p.evidence,ruleset_version:rules}},env,caps.producer_version);
  const lineage=await env.DB.prepare('SELECT grant_revision FROM device_startup_assignments_v3 WHERE node_id=? AND generation=?').bind(node,generation).first<{grant_revision:number}>();
  if (grant.source_generation===generation ? grant.source_policy_sha256!==source.policy_sha256 : lineage?.grant_revision!==revision) conflict();
  if (await c.unavailableReason(env,source,old,Date.now())) conflict();
  const target=await env.DB.prepare('SELECT observation_kinds_json FROM places WHERE id=?').bind(place).first<{observation_kinds_json:string}>();
  if (!target || !JSON.parse(target.observation_kinds_json).includes('activity')) unsupported();
  const now=Date.now(), remaining=Math.min(Date.parse(caps.expires_at),grant.grant_expires_at_ms!,source.expires_at_ms)-now;
  if (remaining<=2*p.collection.summary.window_ms+GUARD_MS) conflict('v3_transition_renew_first');
  const t: Intent={id,node_id:node,request_sha256:hash,boot_id:boot,capability_sha256:cap,from_generation:generation,source_policy_sha256:source.policy_sha256,
    expected_startup_revision:revision,old_placement_id:p.custody.placement_id!,target_place_id:place,target_dataset:dataset,target_ruleset:rules,
    target_kinds_json:target.observation_kinds_json,grant_expires_at_ms:grant.grant_expires_at_ms!,policy_ttl_ms:grant.policy_ttl_ms!,accept_grace_ms:grant.accept_grace_ms!,
    created_at_ms:now,expires_at_ms:Math.min(now+300000,now+remaining-2*p.collection.summary.window_ms-GUARD_MS),phase:'pending',state_version:1,cutover_ms:null,assignment_generation:null};
  const guards=[c.version(node,old),c.enabled(node),c.startupVersion(node,revision),c.startupAuthority(env,node,generation),c.activePlacement(node,t.old_placement_id),targetScope(t),
    {sql:`MIN(?,?,?)-${NOW}>?`,bindings:[Date.parse(caps.expires_at),t.grant_expires_at_ms,source.expires_at_ms,2*p.collection.summary.window_ms+GUARD_MS]}];
  await c.atomic(env,authorization,guards,[
    // Retain stale intent history; only release its bounded active slot.
    env.DB.prepare(`UPDATE device_scope_transition_state_v3 SET phase='expired',state_version=state_version+1 WHERE node_id=? AND phase IN ('pending','assigned')
      AND id IN (SELECT id FROM device_scope_transitions_v3 WHERE expires_at_ms<=${NOW})`).bind(node),
    env.DB.prepare(`UPDATE device_scope_transition_state_v3 SET phase='conflicted',state_version=state_version+1 WHERE node_id=? AND phase='pending'
      AND id IN (SELECT id FROM device_scope_transitions_v3 WHERE boot_id<>? OR capability_sha256<>? OR from_generation<>? OR expected_startup_revision<>?)`).bind(node,boot,cap,generation,revision),
    env.DB.prepare(`INSERT INTO device_scope_transitions_v3(id,node_id,request_sha256,boot_id,capability_sha256,from_generation,source_policy_sha256,
      expected_startup_revision,old_placement_id,target_place_id,target_dataset,target_ruleset,target_kinds_json,grant_expires_at_ms,policy_ttl_ms,accept_grace_ms,created_at_ms,expires_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,node,hash,boot,cap,generation,source.policy_sha256,revision,t.old_placement_id,place,dataset,rules,t.target_kinds_json,
      t.grant_expires_at_ms,t.policy_ttl_ms,t.accept_grace_ms,now,t.expires_at_ms),
    env.DB.prepare("INSERT INTO device_scope_transition_state_v3(id,node_id,phase) VALUES(?,?,'pending')").bind(id,node),
    env.DB.prepare('INSERT INTO admin_audit(action,target,detail_json,created_at) VALUES(?,?,?,?)').bind('device_v3.transition_create',node,JSON.stringify({id,from_generation:generation,expected_startup_revision:revision,target_place_id:place,target_dataset:dataset,target_ruleset:rules}),new Date(now).toISOString()),
  ],guards);
  return json({protocol:'campuspulse/3',node_id:node,transition:status(t)},201);
}

export async function readyTransition(request: Request, env: DeviceV3ControlEnv, node: string, authorization: AuthAssertion,c: TransitionContext,parsed?: Awaited<ReturnType<TransitionContext['readBody']>>): Promise<Response> {
  if (new URL(request.url).search) unsupported();
  if (new URL(request.url).protocol!=='https:') throw new IngestError(403,'https_required','HTTPS is required.');
  const {value,hash}=parsed ?? await c.readBody(request);
  const b=object(value,'ready',['protocol','schema','transition_id','boot_id','from_generation','capability_sha256','closed_window_seq','closed_segment_seq','clock_epoch','uptime_ms','observation_upper_ms']);
  choice(b.protocol,'ready.protocol',['campuspulse/3']); choice(b.schema,'ready.schema',['scope-transition-ready/1']);
  const id=string(b.transition_id,'ready.transition_id',UUID),boot=string(b.boot_id,'ready.boot_id',UUID),cap=string(b.capability_sha256,'ready.capability_sha256',HASH),
    generation=integer(b.from_generation,'ready.from_generation',1,Number.MAX_SAFE_INTEGER-1),window=integer(b.closed_window_seq,'ready.closed_window_seq',0,0xffffffff),
    segment=integer(b.closed_segment_seq,'ready.closed_segment_seq',0,0xffffffff),epoch=integer(b.clock_epoch,'ready.clock_epoch',1,0xffffffff),
    uptime=integer(b.uptime_ms,'ready.uptime_ms'),upper=integer(b.observation_upper_ms,'ready.observation_upper_ms',0,8640000000000000);
  const previous=await receipt(env,node,id);
  if (previous) { if(previous.body_sha256!==hash) conflict('v3_transition_ready_conflict'); await c.assertAuthorized(env,authorization); return json(JSON.parse(previous.receipt_json)); }
  if(request.headers.get('X-Receipt-Only')==='1') conflict('v3_receipt_not_committed');
  const t=await find(env,node,id),old=await c.current(env,node);
  if(!t || !old || t.phase!=='pending' || t.boot_id!==boot || t.capability_sha256!==cap || t.from_generation!==generation ||
    old.boot_id!==boot || old.capability_sha256!==cap || old.desired_generation!==generation || old.applied_generation!==generation || uptime<old.uptime_ms) conflict();
  const grant=await c.startupGrant(env,node),source=await c.assignment(env,node,generation);
  if(!source || source.policy_sha256!==t.source_policy_sha256 || !grant?.enabled || grant.revision!==t.expected_startup_revision) conflict();
  const p=(await c.trustedEnvelope(source)).policy,caps=await c.trustedCapabilities(env,node,cap);
  assertV3StatisticsPolicy(p,env,caps.producer_version);
  if(!caps.online_control?.scope_rebind || p.uplink.transport!=='mqtt_tls') unsupported();
  if(await c.unavailableReason(env,source,old,Date.now())) conflict();
  const now=Date.now(),expires=Math.min(now+t.policy_ttl_ms,t.grant_expires_at_ms,Date.parse(caps.expires_at)),next=generation+1,
    placement=`online-${id}`,policy:DeviceConfigV3={...p,policy_id:`online-${id}`,revision:1,assignment_generation:next,
      evidence:{...p.evidence,ruleset_version:t.target_ruleset},
      custody:{...p.custody,placement_id:placement,dataset:t.target_dataset,purpose:t.target_dataset==='field'?'site_observation':t.target_dataset==='demo'?'demonstration':'controlled_test',accept_until:new Date(expires+t.accept_grace_ms).toISOString()},
      control:{...p.control,activation:{...p.control.activation,not_before:new Date(now).toISOString(),expires_at:new Date(expires).toISOString(),after_window_seq:window,after_segment_seq:segment}}};
  assertV3StatisticsPolicy(policy,env,caps.producer_version);
  const frozen=await freezeDeviceConfigV3(policy),result=await negotiateDeviceConfigV3(frozen,caps,{node_id:node,boot_id:boot,now:new Date(now).toISOString(),
    last_assignment_generation:generation,closed_window_seq:window,closed_segment_seq:segment,window_open:false,segment_open:false});
  if(result.state!=='compatible') unsupported();
  const time:AuthAssertion={sql:`?<=${NOW} AND ?>${NOW} AND MIN(?,?,?)-${NOW}>? AND ?>${NOW}`,bindings:[upper,t.expires_at_ms,Date.parse(caps.expires_at),source.expires_at_ms,t.grant_expires_at_ms,2*p.collection.summary.window_ms+GUARD_MS,expires]};
  const boundary:AuthAssertion={sql:`NOT EXISTS(SELECT 1 FROM device_acknowledgements_v3 WHERE node_id=? AND boot_id=? AND state='applied'
      AND (json_extract(acknowledgement_json,'$.closed_window_seq')>? OR json_extract(acknowledgement_json,'$.closed_segment_seq')>?))
    AND NOT EXISTS(SELECT 1 FROM statistics_windows_v3 WHERE node_id=? AND boot_id=? AND (window_seq>? OR end_utc_ms+uncertainty_ms>? OR end_mono_ms>? OR clock_epoch>?))
    AND NOT EXISTS(SELECT 1 FROM statistics_sequence_floors_v3 WHERE node_id=? AND boot_id=? AND (window_seq_floor>? OR window_end_utc_ms+window_uncertainty_ms>? OR uptime_ms>? OR clock_epoch>?))
    AND NOT EXISTS(SELECT 1 FROM statistics_status_v3 WHERE node_id=? AND boot_id=? AND (uptime_ms>? OR clock_epoch>?
      OR json_extract(item_json,'$.time.utc_ms')+json_extract(item_json,'$.time.uncertainty_ms')>?))
    AND NOT EXISTS(SELECT 1 FROM statistics_events_v3 e,json_each(e.item_json) point WHERE e.node_id=? AND e.boot_id=?
      AND point.key IN ('start','last_seen','observed_until','end') AND point.type='object'
      AND (json_extract(point.value,'$.utc_ms')+json_extract(point.value,'$.uncertainty_ms')>? OR json_extract(point.value,'$.mono_ms')>? OR json_extract(point.value,'$.clock_epoch')>?))
    AND NOT EXISTS(SELECT 1 FROM device_statistics_authorizations_v3 WHERE node_id=? AND boot_id=? AND uptime_ms>?)`,
    bindings:[node,boot,window,segment,node,boot,window,upper,uptime,epoch,node,boot,window,upper,uptime,epoch,node,boot,uptime,epoch,upper,node,boot,upper,uptime,epoch,node,boot,uptime]};
  // One persisted database-clock instant governs both placement intervals.
  const cutover='(SELECT cutover_ms FROM device_scope_transition_state_v3 WHERE id=?)';
  const response={protocol:'campuspulse/3',schema:'scope-transition-ready-receipt/1',transition_id:id,node_id:node,boot_id:boot,from_generation:generation,
    closed_window_seq:window,closed_segment_seq:segment,clock_epoch:epoch,uptime_ms:uptime,body_sha256:hash,assignment_generation:next,
    policy_sha256:frozen.policy_sha256,durability:'committed',evidence:'device_pause'};
  const checks=[intentVersion(t),sourceIdentity(t),c.version(node,old),c.startupVersion(node,t.expected_startup_revision),c.startupAuthority(env,node,generation),
    c.activePlacement(node,t.old_placement_id),targetScope(t),time,boundary];
  try { await c.atomic(env,authorization,checks,[
    env.DB.prepare(`UPDATE device_scope_transition_state_v3 SET cutover_ms=${NOW},state_version=state_version+1 WHERE id=?`).bind(id),
    env.DB.prepare(`INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,${cutover},strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(t.old_placement_id,node,id),
    env.DB.prepare(`INSERT INTO placements(id,node_id,place_id,valid_from_ms,observation_kinds_json) VALUES(?,?,?,${cutover},?)`).bind(placement,node,t.target_place_id,id,t.target_kinds_json),
    ...c.endStatisticsSpans(env,node,{sql:cutover,bindings:[id]}),
    ...c.writeStartupGrant(env,c.revokedStartupGrant(node,t.expected_startup_revision+1)),
    env.DB.prepare(`INSERT INTO device_assignments_v3(node_id,generation,policy_id,revision,boot_id,capability_sha256,policy_sha256,envelope_json,placement_id,not_before_ms,expires_at_ms,assigned_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(node,next,policy.policy_id,1,boot,cap,frozen.policy_sha256,JSON.stringify(frozen),placement,now,expires,new Date(now).toISOString()),
    env.DB.prepare("UPDATE device_scope_transition_state_v3 SET phase='assigned',assignment_generation=? WHERE id=?").bind(next,id),
    env.DB.prepare('UPDATE device_control_v3 SET desired_generation=?,uptime_ms=?,state_version=state_version+1 WHERE node_id=?').bind(next,uptime,node),
    env.DB.prepare(`INSERT INTO device_scope_transition_receipts_v3(id,node_id,body_sha256,body_json,receipt_json)
      VALUES(?,?,?,?,json_set(?,'$.server_time',strftime('%Y-%m-%dT%H:%M:%fZ','now')))` ).bind(id,node,hash,JSON.stringify(b),JSON.stringify(response)),
  ],[targetScope(t),boundary,c.activePlacement(node,placement),c.startupVersion(node,t.expected_startup_revision+1),transitionAuthority(node,next),
    {sql:'EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND boot_id=? AND capability_sha256=? AND desired_generation=? AND applied_generation=? AND state_version=?)',bindings:[node,boot,cap,next,generation,old.state_version+1]}]);
  }catch(error){ if(error instanceof IngestError&&error.status===409){const winner=await receipt(env,node,id);if(winner?.body_sha256===hash){await c.assertAuthorized(env,authorization);return json(JSON.parse(winner.receipt_json));}} throw error; }
  return json(JSON.parse((await receipt(env,node,id))!.receipt_json));
}

/** These writes execute in the very same atomic batch as the real device ACK. */
export async function transitionAck(env:DeviceV3ControlEnv,node:string,row:Assignment,state:string,c:TransitionContext) {
  const t=await env.DB.prepare(`${SELECT} WHERE t.node_id=? AND s.assignment_generation=?`).bind(node,row.generation).first<Intent>();
  const checks:AuthAssertion[]=[],finalChecks:AuthAssertion[]=[],writes:D1PreparedStatement[]=[];
  if(!t) return {checks,finalChecks,writes};
  checks.push(intentVersion(t));
  if(state==='applied') {
    if(t.phase!=='assigned' || t.boot_id!==row.boot_id || t.capability_sha256!==row.capability_sha256 || env.DEVICE_V3_STARTUP_ENABLED!=='true') conflict();
    checks.push(transitionAuthority(node,row.generation));
    writes.push(...c.writeStartupGrant(env,{node_id:node,revision:t.expected_startup_revision+2,enabled:1,source_generation:row.generation,source_policy_sha256:row.policy_sha256,
      grant_expires_at_ms:t.grant_expires_at_ms,policy_ttl_ms:t.policy_ttl_ms,accept_grace_ms:t.accept_grace_ms,created_at:new Date().toISOString()}),
      env.DB.prepare('INSERT INTO device_startup_assignments_v3(node_id,generation,grant_revision) VALUES(?,?,?)').bind(node,row.generation,t.expected_startup_revision+2));
    finalChecks.push(c.startupVersion(node,t.expected_startup_revision+2),transitionAuthority(node,row.generation));
  }
  writes.push(env.DB.prepare('UPDATE device_scope_transition_state_v3 SET phase=?,state_version=state_version+1 WHERE id=?').bind(state==='applied'?'applied':'failed',t.id));
  return {checks,finalChecks,writes};
}
