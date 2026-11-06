import type { AuthAssertion } from './admin-auth';
import type { Assignment, Control } from './device-v3-control';
import { capabilityDigestV3, freezeDeviceConfigV3, negotiateDeviceConfigV3, validateDeviceCapabilitiesV3,
  validateFrozenDeviceConfigV3, type DeviceConfigV3 } from './device-v3-config';
import { admitsV3SimulatorStatistics } from './device-v3-simulator-admission';
import { assertV3StatisticsPolicy, loadStatisticsAuthority, STATISTICS_NOW_SQL as NOW,
  type DeviceV3StatisticsEnv } from './device-v3-statistics-policy';
import { IngestError } from './strict-json';

export type SimulatorRenewalEnv = DeviceV3StatisticsEnv & { DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS?: string };
const NODE = /^sim-live-[a-z0-9][a-z0-9_-]{0,54}$/;
const PRODUCER = 'synthetic-statistics/1';
const unavailable = (code: string): never => { throw new IngestError(503, code, 'Continuous simulator renewal is unavailable. Retry the unchanged registration after resolving the condition.'); };

/** An explicit deployment grant, restricted to the existing exact simulator list. */
export function continuousSimulatorNodes(env: SimulatorRenewalEnv): string[] {
  const parse = (value: string | undefined): string[] => {
    let nodes: unknown;
    try { nodes = JSON.parse(value ?? '[]'); } catch { return unavailable('v3_simulator_continuous_config_invalid'); }
    if (!Array.isArray(nodes) || nodes.length > 16 || new Set(nodes).size !== nodes.length ||
      nodes.some(n => typeof n !== 'string' || !NODE.test(n))) return unavailable('v3_simulator_continuous_config_invalid');
    return nodes;
  };
  const continuous = parse(env.DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS);
  if (!continuous.length) return [];
  const admitted = parse(env.DEVICE_V3_SIMULATOR_NODE_IDS);
  if (continuous.some(node => !admitted.includes(node))) return unavailable('v3_simulator_continuous_config_invalid');
  return continuous;
}

async function check(env: SimulatorRenewalEnv, assertion: AuthAssertion): Promise<boolean> {
  return (await env.DB.prepare(`SELECT CASE WHEN (${assertion.sql}) THEN 1 ELSE 0 END AS ok`)
    .bind(...assertion.bindings).first<{ ok: number }>())?.ok === 1;
}
async function authorize(env: SimulatorRenewalEnv, assertion: AuthAssertion) {
  if (!await check(env, assertion)) throw new IngestError(401, 'unauthorized', 'MQTT authorization is no longer valid.');
}
async function capabilities(env: SimulatorRenewalEnv, node: string, hash: string, boot: string) {
  const row = await env.DB.prepare('SELECT * FROM device_capabilities_v3 WHERE node_id=? AND capability_sha256=?')
    .bind(node, hash).first<{ capability_json: string; boot_id: string; issued_at_ms: number; expires_at_ms: number }>();
  try {
    if (!row) throw Error('Missing capabilities');
    const caps = validateDeviceCapabilitiesV3(JSON.parse(row.capability_json));
    if (caps.node_id !== node || caps.boot_id !== boot || row.boot_id !== boot || await capabilityDigestV3(caps) !== hash ||
      Date.parse(caps.issued_at) !== row.issued_at_ms || Date.parse(caps.expires_at) !== row.expires_at_ms) throw Error('Capability mismatch');
    return caps;
  } catch { return unavailable('v3_registry_invalid'); }
}
async function envelope(row: Assignment) {
  try {
    const frozen = await validateFrozenDeviceConfigV3(JSON.parse(row.envelope_json)), p = frozen.policy;
    if (p.node_id !== row.node_id || p.assignment_generation !== row.generation || p.policy_id !== row.policy_id || p.revision !== row.revision ||
      frozen.policy_sha256 !== row.policy_sha256 || p.control.capability_sha256 !== row.capability_sha256 ||
      p.control.activation.boot_id !== row.boot_id || p.custody.placement_id !== row.placement_id ||
      Date.parse(p.control.activation.not_before) !== row.not_before_ms || Date.parse(p.control.activation.expires_at) !== row.expires_at_ms)
      throw Error('Assignment mismatch');
    return frozen;
  } catch { return unavailable('v3_registry_invalid'); }
}

// Include compacted committed windows and previous applied boundaries: normal
// retention must not reset a long-running boot's sequence namespace.
const WINDOW_FLOOR = `SELECT COALESCE(MAX(seq),0) AS seq FROM (
  SELECT MAX(window_seq) AS seq FROM statistics_windows_v3 WHERE node_id=? AND boot_id=?
  UNION ALL SELECT MAX(window_seq_floor) FROM statistics_sequence_floors_v3 WHERE node_id=? AND boot_id=? AND stream='window_statistics'
  UNION ALL SELECT MAX(json_extract(acknowledgement_json,'$.closed_window_seq')) FROM device_acknowledgements_v3 WHERE node_id=? AND boot_id=? AND state='applied')`;

/** Called only after authenticated native MQTT registration, including receipt
 * retries. No public route, admin identity, new wire operation, ACK or lease.
 * A fresh self-declaration can only reduce support; it never supplies scope. */
export async function renewContinuousSimulatorPolicy(env: SimulatorRenewalEnv, node: string, boot: string,
  registrationHash: string, authorization: AuthAssertion): Promise<void> {
  // Do not make physical-device registration depend on simulator deployment flags.
  if (!NODE.test(node) || !continuousSimulatorNodes(env).includes(node)) return;
  await authorize(env, authorization);
  const control = await env.DB.prepare('SELECT * FROM device_control_v3 WHERE node_id=?').bind(node).first<Control>();
  if (!control || control.boot_id !== boot || control.registration_sha256 !== registrationHash)
    return unavailable('v3_simulator_registration_changed');
  // Initial onboarding remains an ordinary administrator assignment.
  if (control.desired_generation === null) { await authorize(env, authorization); return; }
  const row = await env.DB.prepare('SELECT * FROM device_assignments_v3 WHERE node_id=? AND generation=?')
    .bind(node, control.desired_generation).first<Assignment>();
  if (!row) return unavailable('v3_registry_invalid');
  const frozen = await envelope(row), source = frozen.policy;
  const caps = await capabilities(env, node, control.capability_sha256, boot), now = Date.now();
  if (caps.producer_version !== PRODUCER || !admitsV3SimulatorStatistics(source, env, caps.producer_version))
    return unavailable('v3_simulator_policy_unsupported');
  assertV3StatisticsPolicy(source, env, caps.producer_version);
  // An already minted generation is an idempotent success even before its ACK.
  // Never replace a still-current administrative assignment just to extend time.
  if (row.boot_id === boot && row.capability_sha256 === control.capability_sha256 && row.expires_at_ms > now) {
    await authorize(env, authorization); return;
  }
  // The desired generation itself must have been durably applied. Falling back
  // to an older applied generation would overwrite an operator's pending change.
  const authority = await loadStatisticsAuthority(env, { node_id: node, boot_id: row.boot_id,
    assignment_generation: row.generation, policy_id: row.policy_id, policy_sha256: row.policy_sha256 });
  if (authority.capabilities.producer_version !== PRODUCER || !admitsV3SimulatorStatistics(authority.policy, env, PRODUCER) ||
    source.control.activation.after_segment_seq !== 0) return unavailable('v3_simulator_policy_unsupported');
  const ack = await env.DB.prepare("SELECT body_sha256,acknowledgement_json FROM device_acknowledgements_v3 WHERE node_id=? AND generation=? AND state='applied'")
    .bind(node, row.generation).first<{ body_sha256: string; acknowledgement_json: string }>();
  if (!ack || JSON.parse(ack.acknowledgement_json).closed_segment_seq !== 0) return unavailable('v3_simulator_policy_unsupported');
  const placement = await env.DB.prepare(`SELECT p.valid_from_ms,COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807) AS expires
    FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id WHERE p.id=? AND p.node_id=?`)
    .bind(source.custody.placement_id, node).first<{ valid_from_ms: number; expires: number }>();
  if (!placement || placement.valid_from_ms > now || placement.expires <= now) return unavailable('v3_simulator_placement_inactive');
  const ttl = Math.min(1800000, row.expires_at_ms - row.not_before_ms);
  const expires = Math.min(now + ttl, Date.parse(caps.expires_at), placement.expires);
  const grace = Date.parse(source.custody.accept_until) - row.expires_at_ms;
  if (Date.parse(caps.issued_at) > now || expires - now <= source.collection.summary.window_ms || grace < 0)
    return unavailable('v3_simulator_renewal_interval_unavailable');
  const floorBindings = [node, boot, node, boot, node, boot];
  const floor = (await env.DB.prepare(WINDOW_FLOOR).bind(...floorBindings).first<{ seq: number }>())?.seq;
  if (!Number.isSafeInteger(floor) || floor! < 0 || floor! >= 0xffffffff || row.generation >= Number.MAX_SAFE_INTEGER)
    return unavailable('v3_simulator_history_full');
  const generation = row.generation + 1, assignedAt = new Date(now).toISOString();
  const policy: DeviceConfigV3 = { ...source, policy_id: `sim-renew-${generation}-${crypto.randomUUID()}`, revision: 1,
    assignment_generation: generation, custody: { ...source.custody, accept_until: new Date(expires + grace).toISOString() },
    control: { ...source.control, capability_sha256: control.capability_sha256,
      activation: { ...source.control.activation, boot_id: boot, after_window_seq: floor!, after_segment_seq: 0,
        not_before: assignedAt, expires_at: new Date(expires).toISOString() } } };
  const next = await freezeDeviceConfigV3(policy);
  const negotiation = await negotiateDeviceConfigV3(next, caps, { node_id: node, boot_id: boot, now: assignedAt,
    last_assignment_generation: row.generation, closed_window_seq: floor!, closed_segment_seq: 0, window_open: false, segment_open: false });
  if (negotiation.state !== 'compatible') return unavailable('v3_simulator_policy_incompatible');
  const state = (desired: number, version: number): AuthAssertion => ({ sql: `EXISTS(SELECT 1 FROM device_control_v3
    WHERE node_id=? AND boot_id=? AND capability_sha256=? AND registration_sha256=? AND desired_generation=? AND state_version=? AND applied_generation IS ?)`,
    bindings: [node, boot, control.capability_sha256, registrationHash, desired, version, control.applied_generation] });
  const permissions: AuthAssertion[] = [authorization,
    { sql: 'EXISTS(SELECT 1 FROM device_nodes WHERE id=? AND enabled=1)', bindings: [node] },
    { sql: `?<=${NOW} AND ?-${NOW}>?`, bindings: [Date.parse(caps.issued_at), expires, source.collection.summary.window_ms] },
    { sql: `EXISTS(SELECT 1 FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id
      WHERE p.id=? AND p.node_id=? AND p.valid_from_ms<=${NOW} AND COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)>=?)`,
      bindings: [source.custody.placement_id, node, expires] },
    { sql: `EXISTS(SELECT 1 FROM device_assignments_v3 a JOIN device_acknowledgements_v3 k ON k.node_id=a.node_id AND k.generation=a.generation
      WHERE a.node_id=? AND a.generation=? AND a.policy_sha256=? AND k.boot_id=a.boot_id AND k.state='applied' AND k.body_sha256=?)`,
      bindings: [node, row.generation, row.policy_sha256, ack.body_sha256] },
    { sql: `(${WINDOW_FLOOR})=?`, bindings: [...floorBindings, floor!] },
  ];
  const assertions = [...permissions, state(row.generation, control.state_version), ...permissions, state(generation, control.state_version + 1)]
    .map(a => ({ a, id: crypto.randomUUID() }));
  const guard = ({ a, id }: typeof assertions[number]) => env.DB.prepare(`INSERT INTO admin_write_assertions(id,ok) SELECT ?,CASE WHEN (${a.sql}) THEN 1 ELSE 0 END`)
    .bind(id, ...a.bindings);
  try {
    await env.DB.batch([
      ...assertions.slice(0, permissions.length + 1).map(guard),
      env.DB.prepare(`INSERT INTO device_assignments_v3(node_id,generation,policy_id,revision,boot_id,capability_sha256,policy_sha256,envelope_json,placement_id,not_before_ms,expires_at_ms,assigned_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(node, generation, policy.policy_id, policy.revision, boot, control.capability_sha256,
        next.policy_sha256, JSON.stringify(next), source.custody.placement_id, now, expires, assignedAt),
      env.DB.prepare(`UPDATE device_control_v3 SET desired_generation=?,state_version=state_version+1 WHERE node_id=? AND boot_id=?
        AND capability_sha256=? AND registration_sha256=? AND desired_generation=? AND state_version=?`)
        .bind(generation, node, boot, control.capability_sha256, registrationHash, row.generation, control.state_version),
      ...assertions.slice(permissions.length + 1).map(guard),
      ...assertions.map(({ id }) => env.DB.prepare('DELETE FROM admin_write_assertions WHERE id=?').bind(id)),
    ]);
  } catch {
    // Registration may already be committed. Return a retryable failure so an
    // exact frozen-registration retry runs this hook again instead of losing it.
    await authorize(env, authorization);
    return unavailable('v3_simulator_renewal_conflict');
  }
}
