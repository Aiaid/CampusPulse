/** Experimental control-only protocol. Opt-in never enables v3 data ingestion. */
import type { Env } from './types';
import { adminOrigin, adminSecret, requireAdminSession, sessionAssertion, type AuthAssertion } from './admin-auth';
import { device, json, readBytes, sha256 } from './http';
import { IngestError } from './strict-json';
import { object, string, integer, choice } from './validation';
import { capabilityDigestV3, DeviceV3ConfigError, freezeDeviceConfigV3, negotiateDeviceConfigV3, parseDeviceV3Json,
  validateDeviceCapabilitiesV3, validateFrozenDeviceConfigV3, type DeviceConfigV3, type FrozenDeviceConfigV3 } from './device-v3-config';
import { assertV3IngestPolicy, supportsV3IngestPolicy, v3IngestEnabled, type V3IngestPolicy } from './device-v3-ingest-validation';
import { assertV3StatisticsPolicy, supportsV3StatisticsPolicy, v3StatisticsEnabled,
  type DeviceV3StatisticsEnv, type V3StatisticsPolicy } from './device-v3-statistics-policy';
import { readAdminDeviceV3Evidence } from './device-v3-admin-evidence';
import { fixedV3QueueProfileIssues } from './device-v3-queue-profile';
import { manageTransitions, onlineTransition, readyTransition, transitionAck, transitionAuthority } from './device-v3-transitions';

export type DeviceV3ControlEnv = DeviceV3StatisticsEnv & { DEVICE_V3_STARTUP_ENABLED?: string };
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const NOW_SQL = "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export interface Control {
  node_id: string; boot_id: string; registration_seq: number; uptime_ms: number; registration_sha256: string;
  capability_sha256: string; registered_at: string; state_version: number;
  desired_generation: number | null; applied_generation: number | null; apply_seq: number;
}
export interface Assignment {
  node_id: string; generation: number; policy_id: string; revision: number; boot_id: string; capability_sha256: string;
  policy_sha256: string; envelope_json: string; placement_id: string | null; not_before_ms: number; expires_at_ms: number; assigned_at: string;
}
interface Capability { capability_json: string; capability_sha256: string; issued_at_ms: number; expires_at_ms: number }
interface AckRow { body_sha256: string; acknowledgement_json: string; received_at: string }
interface StartupGrant {
  node_id: string; revision: number; enabled: number; source_generation: number | null; source_policy_sha256: string | null;
  grant_expires_at_ms: number | null; policy_ttl_ms: number | null; accept_grace_ms: number | null; created_at: string;
}
const startupGrant = (env: Env, node: string) => env.DB.prepare(`SELECT g.* FROM device_startup_state_v3 s
  JOIN device_startup_grants_v3 g ON g.node_id=s.node_id AND g.revision=s.revision WHERE s.node_id=?`).bind(node).first<StartupGrant>();
const startupVersion = (node: string, revision: number): AuthAssertion => ({ sql: 'COALESCE((SELECT revision FROM device_startup_state_v3 WHERE node_id=?),0)=?', bindings: [node, revision] });
function startupAuthority(env: DeviceV3ControlEnv, node: string, generation: number): AuthAssertion {
  const transition = transitionAuthority(node, generation);
  return { sql: `(NOT EXISTS(SELECT 1 FROM device_startup_assignments_v3 WHERE node_id=? AND generation=?) OR
    (?='true' AND EXISTS(SELECT 1 FROM device_startup_assignments_v3 a JOIN device_startup_state_v3 s ON s.node_id=a.node_id AND s.revision=a.grant_revision
      JOIN device_startup_grants_v3 g ON g.node_id=s.node_id AND g.revision=s.revision
      WHERE a.node_id=? AND a.generation=? AND g.enabled=1 AND g.grant_expires_at_ms>${NOW_SQL}))) AND (${transition.sql})`,
    bindings: [node, generation, env.DEVICE_V3_STARTUP_ENABLED ?? '', node, generation, ...transition.bindings] };
}
function conflict(code = 'v3_control_conflict'): never { throw new IngestError(409, code, 'Control state changed or conflicts with immutable evidence. Refresh before retrying.'); }
function bad(code: string): never { throw new IngestError(422, code, 'The requested v3 control operation is not supported or compatible.'); }
const current = (env: Env, node: string) => env.DB.prepare('SELECT * FROM device_control_v3 WHERE node_id=?').bind(node).first<Control>();
const assignment = (env: Env, node: string, generation: number) => env.DB.prepare('SELECT * FROM device_assignments_v3 WHERE node_id=? AND generation=?').bind(node, generation).first<Assignment>();
const acknowledgement = (env: Env, node: string, generation: number) => env.DB.prepare('SELECT body_sha256,acknowledgement_json,received_at FROM device_acknowledgements_v3 WHERE node_id=? AND generation=?').bind(node, generation).first<AckRow>();
const enabled = (node: string): AuthAssertion => ({ sql: 'EXISTS(SELECT 1 FROM device_nodes WHERE id=? AND enabled=1)', bindings: [node] });
const version = (node: string, old: Control | null): AuthAssertion => old
  ? { sql: 'EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND state_version=?)', bindings: [node, old.state_version] }
  : { sql: 'NOT EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=?)', bindings: [node] };
const activePlacement = (node: string, placement: string | null): AuthAssertion => placement === null
  ? { sql: '1', bindings: [] }
  : { sql: `EXISTS(SELECT 1 FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id
      WHERE p.id=? AND p.node_id=? AND p.valid_from_ms<=${NOW_SQL} AND COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)>${NOW_SQL})`, bindings: [placement, node] };
function assertControlUplink(p: DeviceConfigV3, env: DeviceV3ControlEnv, producer?: string): asserts p is V3IngestPolicy | V3StatisticsPolicy {
  if (p.evidence.mode === 'statistics') assertV3StatisticsPolicy(p, env, producer);
  else assertV3IngestPolicy(p, env, producer);
}
function endStatisticsSpans(env: Env, node: string, cutoff: AuthAssertion = { sql: NOW_SQL, bindings: [] }): D1PreparedStatement[] {
  return [env.DB.prepare(`UPDATE device_statistics_lease_spans_v3 SET end_ms=MAX(start_ms,${cutoff.sql}) WHERE node_id=? AND end_ms>${cutoff.sql}`).bind(...cutoff.bindings, node, ...cutoff.bindings),
    env.DB.prepare(`UPDATE device_statistics_authorizations_v3 SET lease_until_ms=${cutoff.sql},state_version=state_version+1 WHERE node_id=? AND lease_until_ms>${cutoff.sql}`).bind(...cutoff.bindings, node, ...cutoff.bindings)];
}
function leaseDeadline(p: V3StatisticsPolicy, capabilityExpires: number): AuthAssertion {
  return { sql: `MIN(${NOW_SQL}+?,?,?,COALESCE((SELECT COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)
    FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id WHERE p.id=? AND p.node_id=?),0))`,
    bindings: [p.control.lease.duration_ms, Date.parse(p.control.activation.expires_at), capabilityExpires, p.custody.placement_id, p.node_id] };
}
async function check(env: Env, assertion: AuthAssertion): Promise<boolean> {
  return (await env.DB.prepare(`SELECT CASE WHEN (${assertion.sql}) THEN 1 ELSE 0 END AS ok`).bind(...assertion.bindings).first<{ ok: number }>())?.ok === 1;
}
async function assertAuthorized(env: Env, authorization: AuthAssertion) {
  if (!await check(env, authorization)) throw new IngestError(401, 'unauthorized', 'Authentication is no longer valid.');
}
async function atomic(env: Env, authorization: AuthAssertion, assertions: AuthAssertion[], writes: D1PreparedStatement[], finalPermissions: AuthAssertion[] = []) {
  const guards = [authorization, ...assertions].map(a => ({ a, id: crypto.randomUUID() }));
  const finalGuards = [...finalPermissions, authorization].map(a => ({ a, id: crypto.randomUUID() }));
  const guard = ({ a, id }: { a: AuthAssertion; id: string }) => env.DB.prepare(`INSERT INTO admin_write_assertions(id,ok) SELECT ?,CASE WHEN (${a.sql}) THEN 1 ELSE 0 END`).bind(id, ...a.bindings);
  try {
    await env.DB.batch([
      ...guards.map(guard), ...writes, ...finalGuards.map(guard),
      ...[...guards, ...finalGuards].map(({ id }) => env.DB.prepare('DELETE FROM admin_write_assertions WHERE id=?').bind(id)),
    ]);
  } catch (error) {
    await assertAuthorized(env, authorization);
    let message = '';
    for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) message += e.message;
    if (/v3_capacity/.test(message)) conflict('v3_history_full');
    if (/constraint|unique|foreign key|v3_immutable/i.test(message)) conflict();
    throw error;
  }
}
async function readBody(request: Request) {
  const bytes = await readBytes(request, 32768);
  return { value: parseDeviceV3Json(bytes), hash: await sha256(bytes) };
}
const registrationReceipt = (row: Pick<Control, 'node_id' | 'boot_id' | 'registration_seq' | 'capability_sha256' | 'registered_at'>) => ({ protocol: 'campuspulse/3', node_id: row.node_id, boot_id: row.boot_id,
  registration_seq: row.registration_seq, capability_sha256: row.capability_sha256, registered_at: row.registered_at,
  applied: false, capability_evidence: 'device_claim' });
const assignmentReceipt = (row: Assignment) => ({ protocol: 'campuspulse/3', node_id: row.node_id,
  assignment_generation: row.generation, policy_id: row.policy_id, policy_sha256: row.policy_sha256,
  assigned_at: row.assigned_at, state: 'assigned', applied: false, requires_device_ack: true });
const ackReceipt = (row: AckRow) => ({ ...JSON.parse(row.acknowledgement_json), received_at: row.received_at, durability: 'committed', evidence: 'device_ack' });
async function trustedEnvelope(row: Assignment): Promise<FrozenDeviceConfigV3> {
  try {
    const envelope = await validateFrozenDeviceConfigV3(JSON.parse(row.envelope_json));
    const p = envelope.policy;
    if (p.node_id !== row.node_id || p.assignment_generation !== row.generation || p.policy_id !== row.policy_id || p.revision !== row.revision ||
      envelope.policy_sha256 !== row.policy_sha256 || p.control.capability_sha256 !== row.capability_sha256 ||
      p.control.activation.boot_id !== row.boot_id || p.custody.placement_id !== row.placement_id ||
      Date.parse(p.control.activation.not_before) !== row.not_before_ms || Date.parse(p.control.activation.expires_at) !== row.expires_at_ms ||
      p.uplink.enabled && !supportsV3IngestPolicy(p) && !supportsV3StatisticsPolicy(p))
      throw new Error('Registry mismatch');
    return envelope;
  } catch { throw new IngestError(503, 'v3_registry_invalid', 'Registered v3 policy failed integrity verification.'); }
}
async function trustedCapabilities(env: Env, node: string, hash: string) {
  const row = await env.DB.prepare('SELECT * FROM device_capabilities_v3 WHERE node_id=? AND capability_sha256=?').bind(node, hash).first<Capability>();
  try {
    if (!row) throw new Error('Missing snapshot');
    const caps = validateDeviceCapabilitiesV3(JSON.parse(row.capability_json));
    if (caps.node_id !== node || await capabilityDigestV3(caps) !== hash || Date.parse(caps.issued_at) !== row.issued_at_ms || Date.parse(caps.expires_at) !== row.expires_at_ms)
      throw new Error('Registry mismatch');
    return caps;
  } catch { throw new IngestError(503, 'v3_registry_invalid', 'Registered v3 capability failed integrity verification.'); }
}

async function register(request: Request, env: Env, node: string, authorization: AuthAssertion) {
  const { value, hash } = await readBody(request);
  const body = object(value, 'registration', ['protocol', 'registration_seq', 'uptime_ms', 'capabilities']);
  choice(body.protocol, 'registration.protocol', ['campuspulse/3']);
  const seq = integer(body.registration_seq, 'registration.registration_seq', 1, 0xffffffff);
  const uptime = integer(body.uptime_ms, 'registration.uptime_ms', 0, Number.MAX_SAFE_INTEGER);
  const caps = validateDeviceCapabilitiesV3(body.capabilities), digest = await capabilityDigestV3(caps);
  if (caps.node_id !== node) throw new IngestError(403, 'node_mismatch', 'Register capabilities only for the authenticated device.');
  const old = await current(env, node);
  if (old?.boot_id === caps.boot_id && old.registration_seq === seq) {
    if (old.registration_sha256 !== hash) conflict('v3_registration_conflict');
    await assertAuthorized(env, authorization);
    return json(registrationReceipt(old));
  }
  const now = Date.now();
  if (Date.parse(caps.issued_at) > now || Date.parse(caps.expires_at) <= now) bad('v3_capabilities_not_current');
  if (old?.boot_id === caps.boot_id && (seq <= old.registration_seq || uptime < old.uptime_ms)) conflict('v3_stale_registration');
  if (old?.boot_id !== caps.boot_id && await env.DB.prepare('SELECT 1 FROM device_boots_v3 WHERE node_id=? AND boot_id=?').bind(node, caps.boot_id).first()) conflict('v3_retired_boot');
  const prior = await env.DB.prepare('SELECT capability_sha256 FROM device_capabilities_v3 WHERE node_id=? AND capability_id=?').bind(node, caps.capability_id).first<{ capability_sha256: string }>();
  if (prior && prior.capability_sha256 !== digest) conflict('v3_capability_conflict');
  const registeredAt = new Date(now).toISOString();
  try {
    await atomic(env, authorization, [version(node, old),
      { sql: `?<=${NOW_SQL} AND ?>${NOW_SQL}`, bindings: [Date.parse(caps.issued_at), Date.parse(caps.expires_at)] },
      ...(old?.boot_id === caps.boot_id ? [] : [{ sql: 'NOT EXISTS(SELECT 1 FROM device_boots_v3 WHERE node_id=? AND boot_id=?)', bindings: [node, caps.boot_id] }]),
    ], [
      ...(old && (old.boot_id !== caps.boot_id || old.capability_sha256 !== digest) ? endStatisticsSpans(env, node) : []),
      env.DB.prepare('INSERT INTO device_boots_v3(node_id,boot_id,first_seen_at) VALUES(?,?,?) ON CONFLICT(node_id,boot_id) DO NOTHING').bind(node, caps.boot_id, registeredAt),
      env.DB.prepare(`INSERT INTO device_capabilities_v3(node_id,capability_id,boot_id,capability_sha256,capability_json,issued_at_ms,expires_at_ms,registered_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(node_id,capability_id) DO NOTHING`).bind(node, caps.capability_id, caps.boot_id, digest, JSON.stringify(caps), Date.parse(caps.issued_at), Date.parse(caps.expires_at), registeredAt),
      env.DB.prepare(`INSERT INTO device_control_v3(node_id,boot_id,registration_seq,uptime_ms,registration_sha256,capability_sha256,registered_at,state_version)
        VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(node_id) DO UPDATE SET boot_id=excluded.boot_id,registration_seq=excluded.registration_seq,
        uptime_ms=excluded.uptime_ms,registration_sha256=excluded.registration_sha256,capability_sha256=excluded.capability_sha256,
        registered_at=excluded.registered_at,state_version=device_control_v3.state_version+1,
        applied_generation=CASE WHEN device_control_v3.boot_id=excluded.boot_id THEN device_control_v3.applied_generation ELSE NULL END,
        apply_seq=CASE WHEN device_control_v3.boot_id=excluded.boot_id THEN device_control_v3.apply_seq ELSE 0 END`)
        .bind(node, caps.boot_id, seq, uptime, hash, digest, registeredAt),
    ], [{ sql: `?<=${NOW_SQL} AND ?>${NOW_SQL}`, bindings: [Date.parse(caps.issued_at), Date.parse(caps.expires_at)] },
      { sql: 'EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND boot_id=? AND capability_sha256=? AND state_version=?)',
        bindings: [node, caps.boot_id, digest, (old?.state_version ?? 0) + 1] }]);
  } catch (error) {
    if (error instanceof IngestError && error.status === 409) {
      const winner = await current(env, node);
      if (winner?.boot_id === caps.boot_id && winner.registration_seq === seq && winner.registration_sha256 === hash) {
        await assertAuthorized(env, authorization); return json(registrationReceipt(winner));
      }
    }
    throw error;
  }
  return json(registrationReceipt({ node_id: node, boot_id: caps.boot_id, registration_seq: seq, capability_sha256: digest, registered_at: registeredAt }));
}

function writeStartupGrant(env: Env, row: StartupGrant): D1PreparedStatement[] {
  return [env.DB.prepare(`INSERT INTO device_startup_grants_v3(node_id,revision,enabled,source_generation,source_policy_sha256,grant_expires_at_ms,policy_ttl_ms,accept_grace_ms,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(row.node_id, row.revision, row.enabled, row.source_generation, row.source_policy_sha256,
    row.grant_expires_at_ms, row.policy_ttl_ms, row.accept_grace_ms, row.created_at),
  env.DB.prepare(`INSERT INTO device_startup_state_v3(node_id,revision) VALUES(?,?)
    ON CONFLICT(node_id) DO UPDATE SET revision=excluded.revision`).bind(row.node_id, row.revision)];
}
const revokedStartupGrant = (node: string, revision: number): StartupGrant => ({ node_id: node, revision, enabled: 0,
  source_generation: null, source_policy_sha256: null, grant_expires_at_ms: null, policy_ttl_ms: null, accept_grace_ms: null, created_at: new Date().toISOString() });
async function manageStartupGrant(request: Request, env: DeviceV3ControlEnv, node: string, authorization: AuthAssertion) {
  const prior = await startupGrant(env, node);
  if (request.method === 'GET') {
    await assertAuthorized(env, authorization);
    return json({ protocol: 'campuspulse/3', node_id: node, startup_grant: prior,
      service_enabled: env.DEVICE_V3_STARTUP_ENABLED === 'true', applied: false });
  }
  const { value } = await readBody(request);
  const body = object(value, 'startup_grant', ['expected_revision', 'enabled'], ['source_generation', 'grant_expires_at', 'policy_ttl_ms', 'accept_grace_ms']);
  const expected = integer(body.expected_revision, 'startup_grant.expected_revision', 0, Number.MAX_SAFE_INTEGER - 1);
  if (typeof body.enabled !== 'boolean') bad('v3_startup_invalid');
  if ((prior?.revision ?? 0) !== expected) conflict('v3_startup_revision_conflict');
  let row = revokedStartupGrant(node, expected + 1);
  const old = await current(env, node), guards: AuthAssertion[] = [startupVersion(node, expected)], finalGuards: AuthAssertion[] = [];
  if (!old) conflict('v3_current_assignment_required');
  // Approval pins authority below, not lease/contact bookkeeping. The first
  // lease can legitimately advance state_version while approval is in flight.
  if (!body.enabled) guards.push(version(node, old));
  if (body.enabled) {
    if (env.DEVICE_V3_STARTUP_ENABLED !== 'true') bad('v3_startup_disabled');
    const sourceGeneration = integer(body.source_generation, 'startup_grant.source_generation', 1);
    if (old.desired_generation !== sourceGeneration || old.applied_generation !== sourceGeneration) conflict('v3_startup_applied_source_required');
    const source = await assignment(env, node, sourceGeneration), ack = await acknowledgement(env, node, sourceGeneration);
    if (!source || !ack || JSON.parse(ack.acknowledgement_json).state !== 'applied') conflict('v3_startup_applied_source_required');
    const p = (await trustedEnvelope(source)).policy;
    assertV3StatisticsPolicy(p, env);
    if (p.uplink.transport !== 'mqtt_tls' || await unavailableReason(env, source, old, Date.now())) bad('v3_startup_source_unsupported');
    const caps = await trustedCapabilities(env, node, source.capability_sha256);
    const expiresText = string(body.grant_expires_at, 'startup_grant.grant_expires_at', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const expiry = Date.parse(expiresText), now = Date.now();
    if (!Number.isSafeInteger(expiry) || new Date(expiry).toISOString() !== expiresText || expiry <= now || expiry > now + 30 * 86400000) bad('v3_startup_expiry_invalid');
    const ttl = integer(body.policy_ttl_ms, 'startup_grant.policy_ttl_ms', Math.max(60000, p.collection.summary.window_ms * 2), 1800000);
    const grace = integer(body.accept_grace_ms, 'startup_grant.accept_grace_ms', 0,
      Math.min(86400000, Date.parse(p.custody.accept_until) - Date.parse(p.control.activation.expires_at)));
    row = { node_id: node, revision: expected + 1, enabled: 1, source_generation: sourceGeneration, source_policy_sha256: source.policy_sha256,
      grant_expires_at_ms: expiry, policy_ttl_ms: ttl, accept_grace_ms: grace, created_at: new Date(now).toISOString() };
    finalGuards.push(enabled(node), activePlacement(node, p.custody.placement_id),
      { sql: `EXISTS(SELECT 1 FROM device_control_v3 c JOIN device_acknowledgements_v3 a
          ON a.node_id=c.node_id AND a.generation=c.applied_generation
          WHERE c.node_id=? AND c.boot_id=? AND c.capability_sha256=?
          AND c.desired_generation=? AND c.applied_generation=? AND a.body_sha256=?
          AND json_extract(a.acknowledgement_json,'$.state')='applied')`,
        bindings: [node, old.boot_id, old.capability_sha256, sourceGeneration, sourceGeneration, ack.body_sha256] },
      { sql: `?>${NOW_SQL} AND ?<=${NOW_SQL} AND MIN(?,?)>${NOW_SQL}`,
        bindings: [expiry, source.not_before_ms, source.expires_at_ms, Date.parse(caps.expires_at)] });
    guards.push(...finalGuards);
  } else if (Object.keys(body).some(k => !['expected_revision', 'enabled'].includes(k))) bad('v3_startup_invalid');
  await atomic(env, authorization, guards, [
    ...(prior?.enabled ? endStatisticsSpans(env, node) : []), ...writeStartupGrant(env, row),
    env.DB.prepare('UPDATE device_control_v3 SET state_version=state_version+1 WHERE node_id=?').bind(node),
    env.DB.prepare('INSERT INTO admin_audit(action,target,detail_json,created_at) VALUES(?,?,?,?)')
      .bind(row.enabled ? 'device_v3.startup_approve' : 'device_v3.startup_revoke', node,
        JSON.stringify({ revision: row.revision, source_generation: row.source_generation, grant_expires_at_ms: row.grant_expires_at_ms }), row.created_at),
  ], [startupVersion(node, row.revision), ...finalGuards,
    ...(!body.enabled ? [{ sql: 'EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND state_version=? AND boot_id=? AND desired_generation IS ?)',
      bindings: [node, old.state_version + 1, old.boot_id, old.desired_generation] }] : [])]);
  return json({ protocol: 'campuspulse/3', node_id: node, startup_grant: row, applied: false, requires_device_ack: true });
}

/** Mint only from explicit still-current approval. No ACK/lease/capture is fabricated. */
async function resumeStartup(env: DeviceV3ControlEnv, node: string, old: Control, authorization: AuthAssertion): Promise<Control> {
  if (env.DEVICE_V3_STARTUP_ENABLED !== 'true') return old;
  const grant = await startupGrant(env, node), now = Date.now();
  if (!grant?.enabled || !grant.source_generation || !grant.grant_expires_at_ms || grant.grant_expires_at_ms <= now) return old;
  const desired = old.desired_generation === null ? null : await assignment(env, node, old.desired_generation);
  if (!desired) return old;
  const lineage = await env.DB.prepare('SELECT grant_revision FROM device_startup_assignments_v3 WHERE node_id=? AND generation=?')
    .bind(node, desired.generation).first<{ grant_revision: number }>();
  if (desired.generation !== grant.source_generation && lineage?.grant_revision !== grant.revision) return old;
  const unavailable = await unavailableReason(env, desired, old, now);
  if (!unavailable || unavailable === 'placement_inactive' || unavailable === 'capabilities_expired') return old;
  const source = await assignment(env, node, grant.source_generation);
  if (!source || source.policy_sha256 !== grant.source_policy_sha256) throw new IngestError(503, 'v3_registry_invalid', 'Startup source failed integrity verification.');
  const sourcePolicy = (await trustedEnvelope(source)).policy, caps = await trustedCapabilities(env, node, old.capability_sha256);
  assertV3StatisticsPolicy(sourcePolicy, env, caps.producer_version);
  if (sourcePolicy.uplink.transport !== 'mqtt_tls') bad('v3_startup_source_unsupported');
  const expires = Math.min(now + grant.policy_ttl_ms!, grant.grant_expires_at_ms, Date.parse(caps.expires_at));
  if (Date.parse(caps.issued_at) > now || expires - now <= sourcePolicy.collection.summary.window_ms) return old;
  if (old.desired_generation! >= Number.MAX_SAFE_INTEGER) conflict('v3_history_full');
  const generation = old.desired_generation! + 1;
  const p: DeviceConfigV3 = { ...sourcePolicy, policy_id: `startup-${generation}-${crypto.randomUUID()}`, revision: 1, assignment_generation: generation,
    custody: { ...sourcePolicy.custody, accept_until: new Date(expires + grant.accept_grace_ms!).toISOString() },
    control: { ...sourcePolicy.control, capability_sha256: old.capability_sha256,
      activation: { ...sourcePolicy.control.activation, boot_id: old.boot_id, after_window_seq: 0, after_segment_seq: 0,
        not_before: new Date(now).toISOString(), expires_at: new Date(expires).toISOString() } } };
  const frozen = await freezeDeviceConfigV3(p);
  const negotiated = await negotiateDeviceConfigV3(frozen, caps, { node_id: node, boot_id: old.boot_id, now: new Date(now).toISOString(),
    last_assignment_generation: generation - 1, closed_window_seq: 0, closed_segment_seq: 0, window_open: true, segment_open: true });
  if (negotiated.issues.some(i => i.code !== 'boundary_not_ready')) bad('v3_startup_policy_incompatible');
  const grantGuard: AuthAssertion = { sql: `EXISTS(SELECT 1 FROM device_startup_state_v3 s JOIN device_startup_grants_v3 g
    ON g.node_id=s.node_id AND g.revision=s.revision WHERE s.node_id=? AND s.revision=? AND g.enabled=1 AND g.grant_expires_at_ms>${NOW_SQL})`, bindings: [node, grant.revision] };
  const timeGuard: AuthAssertion = { sql: `?<=${NOW_SQL} AND ?>${NOW_SQL} AND ?-${NOW_SQL}>?`,
    bindings: [Date.parse(caps.issued_at), Date.parse(caps.expires_at), expires, sourcePolicy.collection.summary.window_ms] };
  await atomic(env, authorization, [version(node, old), enabled(node), grantGuard, timeGuard, activePlacement(node, p.custody.placement_id)], [
    env.DB.prepare(`INSERT INTO device_assignments_v3(node_id,generation,policy_id,revision,boot_id,capability_sha256,policy_sha256,envelope_json,placement_id,not_before_ms,expires_at_ms,assigned_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(node, generation, p.policy_id, p.revision, old.boot_id, old.capability_sha256, frozen.policy_sha256,
      JSON.stringify(frozen), p.custody.placement_id, now, expires, new Date(now).toISOString()),
    env.DB.prepare('INSERT INTO device_startup_assignments_v3(node_id,generation,grant_revision) VALUES(?,?,?)').bind(node, generation, grant.revision),
    env.DB.prepare('UPDATE device_control_v3 SET desired_generation=?,state_version=state_version+1 WHERE node_id=?').bind(generation, node),
  ], [grantGuard, timeGuard, enabled(node), activePlacement(node, p.custody.placement_id),
    { sql: 'EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND boot_id=? AND capability_sha256=? AND desired_generation=? AND state_version=?)',
      bindings: [node, old.boot_id, old.capability_sha256, generation, old.state_version + 1] }]);
  return { ...old, desired_generation: generation, state_version: old.state_version + 1 };
}

async function assign(request: Request, env: DeviceV3ControlEnv, authorization: AuthAssertion) {
  const { value } = await readBody(request);
  const body = object(value, 'assignment', ['policy', 'expected_generation'], ['expected_startup_revision']);
  const expected = integer(body.expected_generation, 'assignment.expected_generation', 0, Number.MAX_SAFE_INTEGER - 1);
  const expectedStartup = body.expected_startup_revision === undefined ? null :
    integer(body.expected_startup_revision,'assignment.expected_startup_revision',0,Number.MAX_SAFE_INTEGER-1);
  const frozen = await freezeDeviceConfigV3(body.policy), p = frozen.policy, node = p.node_id;
  if (p.assignment_generation !== expected + 1) bad('v3_generation_mismatch');
  if (p.uplink.enabled) assertControlUplink(p, env);
  const prior = await assignment(env, node, p.assignment_generation);
  if (prior) {
    if (prior.policy_sha256 !== frozen.policy_sha256) conflict('v3_assignment_conflict');
    await trustedEnvelope(prior); await assertAuthorized(env, authorization);
    return json(assignmentReceipt(prior));
  }
  const old = await current(env, node);
  if (!old || (old.desired_generation ?? 0) !== expected) conflict('v3_generation_conflict');
  const caps = await trustedCapabilities(env, node, old.capability_sha256);
  // Only new manual assignments are checked; exact retained retries above keep
  // their original receipt even if a firmware compatibility rule has changed.
  if (fixedV3QueueProfileIssues(p, caps).length) bad('v3_policy_incompatible');
  if (p.uplink.enabled) {
    assertControlUplink(p, env, caps.producer_version);
    if (Math.min(Date.parse(p.control.activation.expires_at), Date.parse(caps.expires_at)) -
      Math.max(Date.now(), Date.parse(p.control.activation.not_before)) <= p.collection.summary.window_ms) bad('v3_window_interval_unavailable');
  }
  const result = await negotiateDeviceConfigV3(frozen, caps, { node_id: node, boot_id: old.boot_id, now: new Date().toISOString(),
    last_assignment_generation: expected, closed_window_seq: 0, closed_segment_seq: 0, window_open: true, segment_open: true });
  // Assignment is only a static compatibility preflight. Future start and device
  // boundary readiness are checked on delivery/ACK, never fabricated here.
  if (result.issues.some(i => !['boundary_not_ready', 'policy_not_yet_valid'].includes(i.code))) bad('v3_policy_incompatible');
  // A future policy still needs a nonempty interval in which its exact bound
  // snapshot is valid; refreshing capabilities changes that snapshot's digest.
  if (Date.parse(p.control.activation.not_before) >= Date.parse(caps.expires_at)) bad('v3_capability_interval_disjoint');
  if (!await check(env, activePlacement(node, p.custody.placement_id))) bad('v3_placement_inactive');
  const assignedAt = new Date().toISOString();
  const startup = await startupGrant(env, node);
  if(expectedStartup !== null && (startup?.revision??0) !== expectedStartup) conflict('v3_startup_revision_conflict');
  const row: Assignment = { node_id: node, generation: p.assignment_generation, policy_id: p.policy_id, revision: p.revision,
    boot_id: old.boot_id, capability_sha256: old.capability_sha256, policy_sha256: frozen.policy_sha256,
    envelope_json: JSON.stringify(frozen), placement_id: p.custody.placement_id, not_before_ms: Date.parse(p.control.activation.not_before),
    expires_at_ms: Date.parse(p.control.activation.expires_at), assigned_at: assignedAt };
  try {
    await atomic(env, authorization, [enabled(node), version(node, old), startupVersion(node, startup?.revision ?? 0), activePlacement(node, p.custody.placement_id),
      ...(supportsV3IngestPolicy(p) || supportsV3StatisticsPolicy(p) ? [{ sql: `MIN(?,?)-MAX(${NOW_SQL},?)>?`, bindings: [row.expires_at_ms, Date.parse(caps.expires_at), row.not_before_ms, p.collection.summary.window_ms] }] : []),
      { sql: `?>${NOW_SQL} AND ?<=${NOW_SQL} AND ?>${NOW_SQL}`, bindings: [row.expires_at_ms, Date.parse(caps.issued_at), Date.parse(caps.expires_at)] },
    ], [
      ...(startup?.enabled ? [...endStatisticsSpans(env, node), ...writeStartupGrant(env, revokedStartupGrant(node, startup.revision + 1))] : []),
      env.DB.prepare(`INSERT INTO device_assignments_v3(node_id,generation,policy_id,revision,boot_id,capability_sha256,policy_sha256,envelope_json,placement_id,not_before_ms,expires_at_ms,assigned_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(node, row.generation, row.policy_id, row.revision, row.boot_id, row.capability_sha256, row.policy_sha256, row.envelope_json, row.placement_id, row.not_before_ms, row.expires_at_ms, assignedAt),
      env.DB.prepare('UPDATE device_control_v3 SET desired_generation=?,state_version=state_version+1 WHERE node_id=?').bind(row.generation, node),
      env.DB.prepare('INSERT INTO admin_audit(action,target,detail_json,created_at) VALUES(?,?,?,?)').bind('device_v3.assign', node, JSON.stringify({ generation: row.generation, policy_id: p.policy_id }), assignedAt),
    ], [enabled(node), activePlacement(node, row.placement_id), startupVersion(node, startup ? startup.revision + (startup.enabled ? 1 : 0) : 0),
      { sql: `?>${NOW_SQL} AND ?<=${NOW_SQL} AND ?>${NOW_SQL}`, bindings: [row.expires_at_ms, Date.parse(caps.issued_at), Date.parse(caps.expires_at)] },
      { sql: 'EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND boot_id=? AND desired_generation=? AND state_version=?)',
        bindings: [node, old.boot_id, row.generation, old.state_version + 1] }]);
  } catch (error) {
    if (error instanceof IngestError && error.status === 409) {
      const winner = await assignment(env, node, row.generation);
      if (winner?.policy_sha256 === row.policy_sha256) {
        await assertAuthorized(env, authorization); return json(assignmentReceipt(winner));
      }
    }
    throw error;
  }
  // This transition is known only for the transaction this request committed.
  // Retained retries above never invent historic grant revision metadata.
  const response=json(assignmentReceipt(row));
  response.headers.set('X-CP-Startup-Revision-Before',String(startup?.revision??0));
  response.headers.set('X-CP-Startup-Revision-After',String(startup?(startup.revision+(startup.enabled?1:0)):0));
  response.headers.set('X-CP-Startup-Revoked',startup?.enabled===1?'1':'0');
  return response;
}

async function unavailableReason(env: DeviceV3ControlEnv, row: Assignment, control: Control, now: number) {
  if (row.boot_id !== control.boot_id) return 'boot_changed';
  if (row.capability_sha256 !== control.capability_sha256) return 'capabilities_changed';
  if (row.expires_at_ms <= now) return 'policy_expired';
  if (!await check(env, startupAuthority(env, row.node_id, row.generation))) return 'startup_grant_inactive';
  if (!await check(env, activePlacement(row.node_id, row.placement_id))) return 'placement_inactive';
  const caps = await trustedCapabilities(env, row.node_id, row.capability_sha256);
  if (Date.parse(caps.issued_at) > now || Date.parse(caps.expires_at) <= now) return 'capabilities_expired';
  return null;
}
async function getConfig(request: Request, env: DeviceV3ControlEnv, node: string, authorization: AuthAssertion) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== 'boot_id') || query.getAll('boot_id').length !== 1) bad('v3_boot_required');
  const boot = string(query.get('boot_id'), 'config.boot_id', UUID);
  let old = await current(env, node);
  if (!old || old.boot_id !== boot) conflict('v3_current_boot_required');
  old = await resumeStartup(env, node, old, authorization);
  const now = Date.now(), common = { protocol: 'campuspulse/3', server_time: new Date(now).toISOString(), data_ingestion_available: v3IngestEnabled(env) || v3StatisticsEnabled(env), requires_device_ack: true };
  const row = old.desired_generation === null ? null : await assignment(env, node, old.desired_generation);
  let config: FrozenDeviceConfigV3 | null = null, reason: string | null = 'unassigned';
  if (row) { config = await trustedEnvelope(row); reason = await unavailableReason(env, row, old, now); if (reason) config = null; }
  const transition = await onlineTransition(env, old, transitionContext);
  // Recheck the read snapshot and principal after asynchronous integrity checks.
  await assertAuthorized(env, authorization);
  if (!await check(env, version(node, old))) conflict();
  return json({ ...common, config, reason, applied_generation: old.applied_generation,
    activation_not_before: config?.policy.control.activation.not_before ?? null,
    ...(transition ? { online_transition: transition } : {}) });
}

function boundary(value: unknown, path: string) {
  if (typeof value !== 'boolean') throw new DeviceV3ConfigError(path);
  return value;
}
async function acknowledge(request: Request, env: DeviceV3ControlEnv, node: string, authorization: AuthAssertion) {
  const { value, hash } = await readBody(request);
  const body = object(value, 'ack', ['protocol', 'boot_id', 'policy_id', 'policy_sha256', 'assignment_generation', 'apply_seq', 'state',
    'closed_window_seq', 'closed_segment_seq', 'window_open', 'segment_open'], ['error_code']);
  choice(body.protocol, 'ack.protocol', ['campuspulse/3']);
  const boot = string(body.boot_id, 'ack.boot_id', UUID), id = string(body.policy_id, 'ack.policy_id', ID), digest = string(body.policy_sha256, 'ack.policy_sha256', HASH);
  const generation = integer(body.assignment_generation, 'ack.assignment_generation', 1, Number.MAX_SAFE_INTEGER);
  const seq = integer(body.apply_seq, 'ack.apply_seq', 1, 0xffffffff), state = choice(body.state, 'ack.state', ['applied', 'failed']);
  const windowSeq = integer(body.closed_window_seq, 'ack.closed_window_seq', 0, 0xffffffff), segmentSeq = integer(body.closed_segment_seq, 'ack.closed_segment_seq', 0, 0xffffffff);
  const windowOpen = boundary(body.window_open, 'ack.window_open'), segmentOpen = boundary(body.segment_open, 'ack.segment_open');
  if (state === 'failed') choice(body.error_code, 'ack.error_code', ['unsupported_config', 'boundary_failed', 'resource_exhausted', 'storage_failed', 'internal_error']);
  else if (Object.hasOwn(body, 'error_code')) bad('v3_invalid_ack');
  const previous = await acknowledgement(env, node, generation);
  if (previous) {
    if (previous.body_sha256 !== hash) conflict('v3_ack_conflict');
    await assertAuthorized(env, authorization); return json(ackReceipt(previous));
  }
  // Pre-registration queue recovery may retrieve a committed old-boot receipt,
  // but must never turn an uncertain old ACK into a new capture authorization.
  if (request.headers.get('X-Receipt-Only') === '1') conflict('v3_receipt_not_committed');
  const old = await current(env, node);
  if (!old || old.boot_id !== boot || old.desired_generation !== generation) conflict('v3_current_assignment_required');
  if (seq <= old.apply_seq) conflict('v3_stale_ack');
  const row = await assignment(env, node, generation);
  if (!row || row.boot_id !== boot || row.policy_id !== id || row.policy_sha256 !== digest) conflict('v3_assignment_mismatch');
  const frozen = await trustedEnvelope(row);
  const checks: AuthAssertion[] = [version(node, old)];
  const finalChecks: AuthAssertion[] = [{ sql: `EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND boot_id=? AND desired_generation=? AND apply_seq=? AND state_version=?)`,
    bindings: [node, boot, generation, seq, old.state_version + 1] }];
  let statisticsWrites: D1PreparedStatement[] = [];
  if (state === 'applied') {
    checks.push(startupAuthority(env, node, generation));
    finalChecks.push(startupAuthority(env, node, generation));
    if (await unavailableReason(env, row, old, Date.now())) conflict('v3_assignment_unavailable');
    const caps = await trustedCapabilities(env, node, row.capability_sha256);
    if (frozen.policy.uplink.enabled) {
      assertControlUplink(frozen.policy, env, caps.producer_version);
      checks.push({ sql: `MIN(?,?)-${NOW_SQL}>?`, bindings: [row.expires_at_ms, Date.parse(caps.expires_at), frozen.policy.collection.summary.window_ms] });
    }
    // An applied boundary cannot retract prior successful acknowledgements or
    // already committed feature windows. Evaluate in the same D1 transaction:
    // ingestion binds state_version, so neither ordering can admit a race.
    const monotonic: AuthAssertion = { sql: `NOT EXISTS(SELECT 1 FROM device_acknowledgements_v3
      WHERE node_id=? AND boot_id=? AND state='applied' AND
      (json_extract(acknowledgement_json,'$.closed_window_seq')>? OR json_extract(acknowledgement_json,'$.closed_segment_seq')>?))
      AND NOT EXISTS(SELECT 1 FROM ingestion_windows_v3 WHERE node_id=? AND boot_id=? AND window_seq>?)`,
      bindings: [node, boot, windowSeq, segmentSeq, node, boot, windowSeq] };
    // Statistics schema is installed separately. Without that table no committed
    // statistics window exists; do not make old control depend on migration 0017.
    if (supportsV3StatisticsPolicy(frozen.policy) && await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='statistics_windows_v3'").first()) {
      monotonic.sql += ' AND NOT EXISTS(SELECT 1 FROM statistics_windows_v3 WHERE node_id=? AND boot_id=? AND window_seq>?)';
      monotonic.bindings.push(node, boot, windowSeq);
    }
    if (supportsV3StatisticsPolicy(frozen.policy) && await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='statistics_sequence_floors_v3'").first()) {
      monotonic.sql += " AND NOT EXISTS(SELECT 1 FROM statistics_sequence_floors_v3 WHERE node_id=? AND boot_id=? AND stream='window_statistics' AND window_seq_floor>?)";
      monotonic.bindings.push(node, boot, windowSeq);
    }
    if (!await check(env, monotonic)) conflict('v3_boundary_regression');
    checks.push(monotonic);
    finalChecks.push(monotonic);
    const result = await negotiateDeviceConfigV3(frozen, caps, { node_id: node, boot_id: boot, now: new Date().toISOString(),
      last_assignment_generation: old.applied_generation ?? 0, closed_window_seq: windowSeq, closed_segment_seq: segmentSeq, window_open: windowOpen, segment_open: segmentOpen });
    if (result.state !== 'compatible') bad('v3_activation_rejected');
    checks.push(activePlacement(node, row.placement_id), { sql: `?<=${NOW_SQL} AND ?>${NOW_SQL} AND ?<=${NOW_SQL} AND ?>${NOW_SQL}`,
      bindings: [row.not_before_ms, row.expires_at_ms, Date.parse(caps.issued_at), Date.parse(caps.expires_at)] });
    finalChecks.push(activePlacement(node, row.placement_id), { sql: `?<=${NOW_SQL} AND ?>${NOW_SQL} AND ?<=${NOW_SQL} AND ?>${NOW_SQL}`,
      bindings: [row.not_before_ms, row.expires_at_ms, Date.parse(caps.issued_at), Date.parse(caps.expires_at)] });
    statisticsWrites = endStatisticsSpans(env, node);
    if (supportsV3StatisticsPolicy(frozen.policy)) {
      const until = leaseDeadline(frozen.policy, Date.parse(caps.expires_at));
      statisticsWrites.push(
        env.DB.prepare(`INSERT INTO device_statistics_authorizations_v3(node_id,generation,boot_id,policy_sha256,accept_until_ms,lease_until_ms,uptime_ms,span_count)
          SELECT ?,?,?,?,?,${until.sql},?,1`).bind(node, generation, boot, digest, Date.parse(frozen.policy.custody.accept_until), ...until.bindings, old.uptime_ms),
        env.DB.prepare(`INSERT INTO device_statistics_lease_spans_v3(node_id,generation,span_seq,start_ms,end_ms,accept_until_ms)
          SELECT node_id,generation,1,${NOW_SQL},lease_until_ms,accept_until_ms FROM device_statistics_authorizations_v3 WHERE node_id=? AND generation=?`).bind(node, generation),
      );
      finalChecks.push({ sql: `EXISTS(SELECT 1 FROM device_statistics_authorizations_v3 WHERE node_id=? AND generation=? AND boot_id=? AND policy_sha256=? AND lease_until_ms>${NOW_SQL})`,
        bindings: [node, generation, boot, digest] });
      // The stored immutable ACK and its retries include the original committed lease.
      // Insert via SELECT below after constructing authority, rather than UPDATE.
    }
  }
  const receivedAt = new Date().toISOString(), ack = { ...body, node_id: node,
    ...(frozen.policy.evidence.mode === 'statistics' ? { body_sha256: hash } : {}) };
  const stored: AckRow = { body_sha256: hash, acknowledgement_json: JSON.stringify(ack), received_at: receivedAt };
  const transition = await transitionAck(env, node, row, state, transitionContext);
  checks.push(...transition.checks); finalChecks.push(...transition.finalChecks);
  try {
    await atomic(env, authorization, checks, [
      ...statisticsWrites,
      state === 'applied' && supportsV3StatisticsPolicy(frozen.policy)
        ? env.DB.prepare(`INSERT INTO device_acknowledgements_v3(node_id,generation,boot_id,apply_seq,state,body_sha256,acknowledgement_json,received_at)
          SELECT ?,?,?,?,?,?,json_set(?,'$.server_time',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'$.lease_until_ms',lease_until_ms,'$.contact_seq',0),?
          FROM device_statistics_authorizations_v3 WHERE node_id=? AND generation=?`)
          .bind(node, generation, boot, seq, state, hash, stored.acknowledgement_json, receivedAt, node, generation)
        : env.DB.prepare(`INSERT INTO device_acknowledgements_v3(node_id,generation,boot_id,apply_seq,state,body_sha256,acknowledgement_json,received_at)
          VALUES(?,?,?,?,?,?,?,?)`).bind(node, generation, boot, seq, state, hash, stored.acknowledgement_json, receivedAt),
      env.DB.prepare(`UPDATE device_control_v3 SET apply_seq=?,state_version=state_version+1,
        applied_generation=CASE WHEN ?='applied' THEN ? ELSE applied_generation END WHERE node_id=?`).bind(seq, state, generation, node),
      ...transition.writes,
    ], finalChecks);
  } catch (error) {
    if (error instanceof IngestError && error.status === 409) {
      const winner = await acknowledgement(env, node, generation);
      if (winner?.body_sha256 === hash) { await assertAuthorized(env, authorization); return json(ackReceipt(winner)); }
    }
    throw error;
  }
  return json(ackReceipt(state === 'applied' && supportsV3StatisticsPolicy(frozen.policy) ? (await acknowledgement(env, node, generation))! : stored));
}

interface LeaseState {
  boot_id: string; policy_sha256: string; lease_until_ms: number; contact_seq: number; uptime_ms: number;
  state_version: number; span_count: number; body_sha256: string | null; receipt_json: string | null;
}
const leaseState = (env: Env, node: string, generation: number) => env.DB.prepare('SELECT * FROM device_statistics_authorizations_v3 WHERE node_id=? AND generation=?').bind(node, generation).first<LeaseState>();
async function renewStatisticsLease(request: Request, env: DeviceV3ControlEnv, node: string, authorization: AuthAssertion, parsed?: Awaited<ReturnType<typeof readBody>>) {
  if (!v3StatisticsEnabled(env)) throw new IngestError(503, 'v3_statistics_disabled', 'Statistics service is disabled.');
  if (new URL(request.url).search) bad('v3_invalid_lease');
  if (new URL(request.url).protocol !== 'https:') throw new IngestError(403, 'https_required', 'HTTPS is required.');
  const { value, hash } = parsed ?? await readBody(request);
  const b = object(value, 'lease', ['protocol', 'boot_id', 'policy_id', 'policy_sha256', 'assignment_generation', 'contact_seq', 'uptime_ms']);
  choice(b.protocol, 'lease.protocol', ['campuspulse/3']);
  const boot = string(b.boot_id, 'lease.boot_id', UUID), id = string(b.policy_id, 'lease.policy_id', ID), digest = string(b.policy_sha256, 'lease.policy_sha256', HASH);
  const generation = integer(b.assignment_generation, 'lease.assignment_generation', 1, Number.MAX_SAFE_INTEGER),
    seq = integer(b.contact_seq, 'lease.contact_seq', 1, 0xffffffff), uptime = integer(b.uptime_ms, 'lease.uptime_ms', 0, Number.MAX_SAFE_INTEGER);
  const previous = await leaseState(env, node, generation);
  if (previous?.contact_seq === seq) {
    if (previous.body_sha256 !== hash || !previous.receipt_json) conflict('v3_lease_conflict');
    await assertAuthorized(env, authorization); return json(JSON.parse(previous.receipt_json));
  }
  if (request.headers.get('X-Receipt-Only') === '1') conflict('v3_receipt_not_committed');
  const old = await current(env, node), row = await assignment(env, node, generation);
  if (!old || !row || !previous || old.boot_id !== boot || old.desired_generation !== generation || old.applied_generation !== generation ||
    row.boot_id !== boot || previous.boot_id !== boot || row.policy_id !== id || row.policy_sha256 !== digest || previous.policy_sha256 !== digest) conflict('v3_current_assignment_required');
  if (seq <= previous.contact_seq || uptime < Math.max(old.uptime_ms, previous.uptime_ms)) conflict('v3_stale_lease');
  const frozen = await trustedEnvelope(row), caps = await trustedCapabilities(env, node, row.capability_sha256);
  assertV3StatisticsPolicy(frozen.policy, env, caps.producer_version);
  if (await unavailableReason(env, row, old, Date.now())) conflict('v3_assignment_unavailable');
  const until = leaseDeadline(frozen.policy, Date.parse(caps.expires_at));
  const receiptBase = JSON.stringify({ protocol: 'campuspulse/3', schema: 'device-lease/3', node_id: node, boot_id: boot,
    policy_id: id, policy_sha256: digest, assignment_generation: generation, contact_seq: seq, uptime_ms: uptime, body_sha256: hash, durability: 'committed' });
  try {
    await atomic(env, authorization, [version(node, old), activePlacement(node, row.placement_id), startupAuthority(env, node, generation),
      { sql: `EXISTS(SELECT 1 FROM device_statistics_authorizations_v3 WHERE node_id=? AND generation=? AND state_version=? AND contact_seq=? AND boot_id=? AND policy_sha256=?)`,
        bindings: [node, generation, previous.state_version, previous.contact_seq, boot, digest] },
      { sql: `?<=${NOW_SQL} AND ?>${NOW_SQL} AND ?<=${NOW_SQL} AND ?>${NOW_SQL}`, bindings: [row.not_before_ms, row.expires_at_ms, Date.parse(caps.issued_at), Date.parse(caps.expires_at)] },
    ], [
      env.DB.prepare(`UPDATE device_statistics_authorizations_v3 SET
        receipt_json=json_set(?,'$.server_time',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'$.lease_until_ms',${until.sql},
          '$.span_seq',span_count+CASE WHEN lease_until_ms<${NOW_SQL} THEN 1 ELSE 0 END,
          '$.contiguous',json(CASE WHEN lease_until_ms>=${NOW_SQL} THEN 'true' ELSE 'false' END)),
        span_count=span_count+CASE WHEN lease_until_ms<${NOW_SQL} THEN 1 ELSE 0 END,
        lease_until_ms=${until.sql},contact_seq=?,uptime_ms=?,body_sha256=?,state_version=state_version+1 WHERE node_id=? AND generation=?`)
        .bind(receiptBase, ...until.bindings, ...until.bindings, seq, uptime, hash, node, generation),
      env.DB.prepare(`INSERT INTO device_statistics_lease_spans_v3(node_id,generation,span_seq,start_ms,end_ms,accept_until_ms)
        SELECT node_id,generation,span_count,${NOW_SQL},lease_until_ms,accept_until_ms FROM device_statistics_authorizations_v3 WHERE node_id=? AND generation=?
        ON CONFLICT(node_id,generation,span_seq) DO UPDATE SET end_ms=excluded.end_ms`).bind(node, generation),
      env.DB.prepare('UPDATE device_control_v3 SET state_version=state_version+1 WHERE node_id=?').bind(node),
    ], [activePlacement(node, row.placement_id), startupAuthority(env, node, generation),
      { sql: `?<=${NOW_SQL} AND ?>${NOW_SQL} AND ?<=${NOW_SQL} AND ?>${NOW_SQL}`, bindings: [row.not_before_ms, row.expires_at_ms, Date.parse(caps.issued_at), Date.parse(caps.expires_at)] },
      { sql: `EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND boot_id=? AND desired_generation=? AND applied_generation=? AND state_version=?)`,
        bindings: [node, boot, generation, generation, old.state_version + 1] },
      { sql: `EXISTS(SELECT 1 FROM device_statistics_authorizations_v3 WHERE node_id=? AND generation=? AND boot_id=? AND policy_sha256=? AND contact_seq=? AND state_version=? AND lease_until_ms>${NOW_SQL})`,
        bindings: [node, generation, boot, digest, seq, previous.state_version + 1] }]);
  } catch (error) {
    if (error instanceof IngestError && error.status === 409) {
      const winner = await leaseState(env, node, generation);
      if (winner?.contact_seq === seq && winner.body_sha256 === hash && winner.receipt_json) {
        await assertAuthorized(env, authorization); return json(JSON.parse(winner.receipt_json));
      }
    }
    throw error;
  }
  const saved = await leaseState(env, node, generation);
  if (!saved?.receipt_json || saved.contact_seq !== seq || saved.body_sha256 !== hash) conflict();
  return json(JSON.parse(saved.receipt_json));
}

async function inspect(env: DeviceV3ControlEnv, node: string, authorization: AuthAssertion) {
  const old = await current(env, node);
  if (!await env.DB.prepare('SELECT id FROM device_nodes WHERE id=?').bind(node).first()) throw new IngestError(404, 'device_not_found', 'Unknown device.');
  const desired = old?.desired_generation ? await assignment(env, node, old.desired_generation) : null;
  const actual = old?.applied_generation ? await assignment(env, node, old.applied_generation) : null;
  const ack = old?.desired_generation ? await acknowledgement(env, node, old.desired_generation) : null;
  const caps = old ? await trustedCapabilities(env, node, old.capability_sha256) : null;
  const desiredEnvelope = desired ? await trustedEnvelope(desired) : null;
  const unavailable = old && desired ? await unavailableReason(env, desired, old, Date.now()) : null;
  await assertAuthorized(env, authorization);
  if (!await check(env, version(node, old))) conflict();
  return json({ protocol: 'campuspulse/3', node_id: node, capability_evidence: 'device_claim', capabilities: caps,
    registered_at: old?.registered_at ?? null, desired: desiredEnvelope, desired_unavailable_reason: unavailable,
    state: !desired ? 'unassigned' : unavailable ? 'unavailable' : ack ? (JSON.parse(ack.acknowledgement_json) as { state: string }).state : 'pending',
    applied_generation: old?.applied_generation ?? null, last_applied_policy: actual ? await trustedEnvelope(actual) : null,
    acknowledgement: ack ? ackReceipt(ack) : null, data_ingestion_available: v3IngestEnabled(env) || v3StatisticsEnabled(env) });
}

/** All authentication lives inside the handler. No header-trusted internal bypass. */
export async function handleDeviceV3Control(request: Request, env: DeviceV3ControlEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const devicePath = ['/api/v3/device/capabilities', '/api/v3/device/config', '/api/v3/device/config/ack', '/api/v3/device/lease'].includes(path);
  const adminAssignment = path === '/api/v1/admin/device-v3/assignments';
  const adminNode = /^\/api\/v1\/admin\/device-v3\/nodes\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(path);
  const adminEvidence = /^\/api\/v1\/admin\/device-v3\/nodes\/([a-z0-9][a-z0-9_-]{0,63})\/evidence$/.exec(path);
  const adminStartup = /^\/api\/v1\/admin\/device-v3\/nodes\/([a-z0-9][a-z0-9_-]{0,63})\/startup-grant$/.exec(path);
  const adminTransition = /^\/api\/v1\/admin\/device-v3\/nodes\/([a-z0-9][a-z0-9_-]{0,63})\/transitions(?:\/([0-9a-f-]{36})\/cancel)?$/.exec(path);
  if (!devicePath && !adminAssignment && !adminNode && !adminEvidence && !adminStartup && !adminTransition) return null;
  try {
    if (!adminEvidence && env.DEVICE_V3_CONTROL_ENABLED !== 'true') throw new IngestError(503, 'v3_control_disabled', 'Experimental v3 control is disabled.');
    const receiptOnly = request.headers.get('X-Receipt-Only');
    if (receiptOnly !== null && (receiptOnly !== '1' || !['/api/v3/device/config/ack', '/api/v3/device/lease'].includes(path))) {
      throw new IngestError(422, 'v3_invalid_receipt_only', 'Receipt-only mode is valid only for exact ACK or lease recovery.');
    }
    const method = adminNode || adminEvidence || ((adminStartup || adminTransition && !adminTransition[2]) && request.method === 'GET') || path === '/api/v3/device/config' ? 'GET' : 'POST';
    if (request.method !== method) throw new IngestError(405, 'method_not_allowed', `Use ${method}.`);
    if (adminAssignment || adminNode || adminEvidence || adminStartup || adminTransition) {
      const secret = adminSecret(env); adminOrigin(request, method !== 'GET');
      const session = await requireAdminSession(request, env, secret), initial = sessionAssertion(session);
      // sessionAssertion also binds the account/auth version. Its JS cutoff is
      // insufficient after a slow body or D1 call, so expiry is checked against
      // the database clock in every final authorization check and transaction.
      const authorization = { sql: `(${initial.sql}) AND EXISTS(SELECT 1 FROM admin_sessions WHERE token_sha256=? AND expires_at_ms>${NOW_SQL})`,
        bindings: [...initial.bindings, session.hash] };
      return adminTransition ? await manageTransitions(request, env, adminTransition[1], authorization, transitionContext, adminTransition[2]) :
        adminStartup ? await manageStartupGrant(request, env, adminStartup[1], authorization) :
        adminEvidence ? await readAdminDeviceV3Evidence(request, env, adminEvidence[1], authorization) :
        adminNode ? await inspect(env, adminNode[1], authorization) : await assign(request, env, authorization);
    }
    const node = await device(request, env);
    const hash = await sha256(new TextEncoder().encode(request.headers.get('Authorization')!.slice(7)));
    return await handleAuthenticatedDeviceV3Control(request, env, node, {
      sql: 'EXISTS(SELECT 1 FROM device_nodes WHERE id=? AND credential_sha256=? AND enabled=1)', bindings: [node, hash],
    });
  } catch (error) {
    return controlError(error);
  }
}

function controlError(error: unknown): Response {
  if (error instanceof DeviceV3ConfigError) return json({ error: { code: error.code, message: error.message, retryable: false } }, 422);
  if (error instanceof IngestError) return json({ error: { code: error.code, message: error.message, retryable: error.status >= 500 } }, error.status);
  return json({ error: { code: 'storage_unavailable', message: 'Service temporarily unavailable.', retryable: true } }, 503);
}

/** Module-only authenticated principal. Callers supply a storage-backed assertion;
 * public HTTP always authenticates a device bearer before reaching this entry. */
export async function handleAuthenticatedDeviceV3Control(request: Request, env: DeviceV3ControlEnv,
  node: string, authorization: AuthAssertion): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (!['/api/v3/device/capabilities', '/api/v3/device/config', '/api/v3/device/config/ack', '/api/v3/device/lease'].includes(path)) {
      throw new IngestError(404, 'not_found', 'Unknown device control route.');
    }
    if (env.DEVICE_V3_CONTROL_ENABLED !== 'true') throw new IngestError(503, 'v3_control_disabled', 'Experimental v3 control is disabled.');
    const receiptOnly = request.headers.get('X-Receipt-Only');
    if (receiptOnly !== null && (receiptOnly !== '1' || !['/api/v3/device/config/ack', '/api/v3/device/lease'].includes(path))) {
      throw new IngestError(422, 'v3_invalid_receipt_only', 'Receipt-only mode is valid only for exact ACK or lease recovery.');
    }
    const method = path === '/api/v3/device/config' ? 'GET' : 'POST';
    if (request.method !== method) throw new IngestError(405, 'method_not_allowed', `Use ${method}.`);
    await assertAuthorized(env, authorization);
    if (path.endsWith('/capabilities')) return await register(request, env, node, authorization);
    if (path.endsWith('/ack')) return await acknowledge(request, env, node, authorization);
    if (path.endsWith('/lease')) {
      // Strict bounded parse, keeping ordinary lease semantics and exact bytes.
      const parsed = await readBody(request), { value } = parsed;
      if (value && typeof value === 'object' && !Array.isArray(value) && 'schema' in value && value.schema === 'scope-transition-ready/1') {
        return await readyTransition(request, env, node, authorization, transitionContext, parsed);
      }
      return await renewStatisticsLease(request, env, node, authorization, parsed);
    }
    return await getConfig(request, env, node, authorization);
  } catch (error) {
    return controlError(error);
  }
}

const transitionContext = { current, assignment, acknowledgement, startupGrant, startupVersion, startupAuthority,
  enabled, version, activePlacement, endStatisticsSpans, check, assertAuthorized, atomic, readBody,
  trustedEnvelope, trustedCapabilities, unavailableReason, writeStartupGrant, revokedStartupGrant };
export type TransitionContext = typeof transitionContext;
