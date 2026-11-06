/** Local synthetic V3 device. Queue lifetime is this process only: the durable
 * media advertised below is a simulated protocol capability, not hardware proof.
 * No timers or network clients are created here; the launcher owns both.
 */
import { createHash, randomUUID } from 'node:crypto';
import { statisticsTools, expectedStatisticsReceipt } from '../v3-statistics-integration.mjs';

const hash = body => createHash('sha256').update(body).digest('hex');
const check = (ok, message) => { if (!ok) throw new Error(message); };
export const SIMULATION_SCENARIOS = Object.freeze(['quiet', 'busy', 'loss', 'offline', 'failed']);
const cadence = n => { check([1000, 30000, 60000].includes(n), 'Cadence must be 1000, 30000 or 60000ms.'); return n; };
const transportMode = value => { check(['https', 'mqtt_tls'].includes(value), 'Unsupported simulation transport.'); return value; };
function simulationCustody(localConfiguration) {
  if (localConfiguration === undefined) return Object.freeze({ dataset: 'controlled_test', purpose: 'controlled_test' });
  check(localConfiguration?.storage === 'ephemeral-local-d1' && localConfiguration.dataset === 'field' &&
    localConfiguration.purpose === 'site_observation', 'Live simulation requires explicit ephemeral local field configuration.');
  return Object.freeze({ dataset: localConfiguration.dataset, purpose: localConfiguration.purpose });
}
function safePolicy(p, transport, custody) {
  check(p.custody.dataset === custody.dataset && p.custody.purpose === custody.purpose && p.local_raw.mode === 'off',
    'Simulation policy must match the configured dataset/purpose and keep raw disabled.');
  check(p.evidence.mode === 'statistics' && p.evidence.schema === 'window-statistics/1' && p.evidence.extractor_version === 'cp-v3-stats/1' &&
    p.evidence.ruleset_version === 'unclassified-v1' && (p.temporal?.mode === 'off' ||
      p.temporal?.mode === 'rolling' && p.temporal.report_mode === 'off'), 'Unsupported simulation statistics policy.');
  check(p.collection.enabled && p.collection.summary.enabled && p.uplink.enabled && p.uplink.transport === transport &&
    p.uplink.raw_sample.mode === 'off' && p.uplink.archive.mode === 'off' && p.uplink.streams.length === 2 &&
    p.uplink.streams.includes('window_statistics') && p.uplink.streams.includes('node_status'), 'Simulation only uploads compact windows and status.');
  check(p.local_queue.mode === 'durable' && p.local_queue.max_items - p.local_queue.control_reserve_items >= 2 &&
    p.local_queue.max_bytes - p.local_queue.control_reserve_bytes >= 2 * p.uplink.max_body_bytes,
  'Simulation needs reserved capacity for a window and status pair.');
  cadence(p.collection.summary.window_ms);
}

/** Build an assignment for the real administrator endpoint; never assigns it.
 * @param {any} capabilities
 * @param {any} options
 */
export async function createSimulationPolicy(capabilities, { placementId, cadenceMs = 1000, generation = 1, now = Date.now(), leaseDurationMs = 120000,
  transport = capabilities.uplink?.transports?.[0] ?? 'https', localConfiguration } = {}) {
  const custody = simulationCustody(localConfiguration);
  cadence(cadenceMs);
  transportMode(transport);
  check(capabilities.uplink?.transports?.includes(transport), 'Selected transport is absent from simulated capabilities.');
  const tools = await statisticsTools(), p = await tools.statisticsPolicy(capabilities, placementId, generation, now);
  p.policy_id = `sim-statistics-${randomUUID()}`;
  p.collection.summary.window_ms = cadenceMs;
  p.collection.summary.bin_ms = cadenceMs === 1000 ? 1000 : 5000;
  p.temporal = { mode: 'off' };
  p.control.activation.after_window_seq = 0;
  p.control.activation.after_segment_seq = 0;
  p.control.lease.duration_ms = leaseDurationMs;
  p.uplink.transport = transport;
  Object.assign(p.custody, custody);
  safePolicy(p, transport, custody);
  return (await tools.freezeDeviceConfigV3(p)).policy;
}

/** request(pathname, RequestInit) must return a standard Response. */
export async function createSimulatedV3Device(options) {
  const tools = await statisticsTools(), now = options.now ?? Date.now;
  const caps = tools.statisticsCapabilities(options.nodeId, now());
  caps.uplink.transports = [transportMode(options.transport ?? 'https')];
  caps.boot_id = randomUUID(); caps.capability_id = `sim-statistics-${randomUUID()}`;
  return new SimulatedV3Device(options, tools, caps);
}

export class SimulatedV3Device {
  constructor({ nodeId, deviceBearer, request, cadenceMs = 1000, scenario = 'quiet', now = Date.now, transport = 'https', replay = null, localConfiguration }, tools, caps) {
    check(typeof request === 'function' && typeof nodeId === 'string' && typeof deviceBearer === 'string', 'A node, credential and injected request are required.');
    this.cadenceMs = cadence(cadenceMs); this.tools = tools; this.clock = now;
    this.transport = transportMode(transport);
    this.custody = simulationCustody(localConfiguration);
    check(!replay || this.custody.dataset === 'controlled_test', 'Historical replay cannot enter the local live view.');
    check(caps.uplink?.transports?.includes(this.transport), 'Selected transport is absent from simulated capabilities.');
    this.nodeId = nodeId; this.bearer = deviceBearer; this.request = request; this.caps = caps;
    this.bootAt = now(); this.running = false; this.registered = false; this.pending = [];
    this.applied = null; this.lastGeneration = 0; this.terminalGeneration = 0;
    this.windowSeq = 0; this.sequences = { window_statistics: 0, node_status: 0 };
    this.applySeq = 0; this.contactSeq = 0; this.leaseUntil = 0; this.nextStart = null;
    this.losses = [0, 0, 0, 0, 0, 0]; this.accepted = { window_statistics: 0, node_status: 0 };
    this.pendingAck = null; this.pendingLease = null; this.lastError = null; this.configReason = null; this.phase = 'stopped';
    this.replay = replay ? structuredClone(replay) : null; this.replayIndex = 0; this.replayRebasedStart = null;
    this.setScenario(scenario);
  }
  get capabilities() { return structuredClone(this.caps); }
  setScenario(value) { check(SIMULATION_SCENARIOS.includes(value), 'Unknown simulation scenario.'); this.scenario = value; return this.status(); }
  status() {
    return { nodeId: this.nodeId, bootId: this.caps.boot_id, producer: 'synthetic-statistics/1', dataset: this.custody.dataset,
      running: this.running, registered: this.registered, scenario: this.scenario, phase: this.phase, cadenceMs: this.cadenceMs, transport: this.transport,
      queuePersistence: 'session-only', powerLossRecovery: false, pendingItems: this.pending.length,
      pendingControlItems: Number(!!this.pendingAck) + Number(!!this.pendingLease),
      pendingBytes: this.pending.reduce((n, x) => n + Buffer.byteLength(x.body), 0),
      pendingBatches: this.pending.map(x => ({ batchId: x.batchId, stream: x.stream, sha256: hash(x.body), attempts: x.totalAttempts,
        nextAttemptAtMs: x.nextAttemptAt, retryExhausted: x.attempts >= x.retry.max_attempts })),
      appliedGeneration: this.lastGeneration, terminalGeneration: this.terminalGeneration, windowSeq: this.windowSeq,
      sequences: { ...this.sequences }, accepted: { ...this.accepted },
      losses: Object.fromEntries(['window_drops', 'event_drops', 'status_coalesced', 'upload_failures', 'ack_failures', 'retries'].map((k, i) => [k, this.losses[i]])),
      leaseUntilMs: this.leaseUntil || null, nextWindowEndMs: this.nextStart === null ? null : this.nextStart + this.cadenceMs,
      configReason: this.configReason, lastError: this.lastError,
      replay: this.replay ? { kind: 'historical_cpraw', total_windows: this.replay.windows.length, next_index: this.replayIndex,
        completed: this.replayIndex === this.replay.windows.length && this.pending.length === 0,
        rebased_start_utc_ms: this.replayRebasedStart, provenance: this.replay.provenance,
        source_start_mono_us: this.replay.windows[0].source_start_mono_us,
        source_end_mono_us: this.replay.windows.at(-1).source_end_mono_us } : null };
  }
  /** Explicit local operator retry; retained bytes and identities never change. */
  retryPending() {
    for (const batch of this.pending) { batch.attempts = 0; batch.nextAttemptAt = this.clock(); }
    this.lastError = null; if (this.phase === 'retry_exhausted') this.phase = 'retry_pending';
    return this.status();
  }
  async start() { this.running = true; return this.tick(); }
  stop() { this.running = false; this.phase = 'stopped'; return this.status(); }
  uptime(at = this.clock()) { return Math.max(1000, at - this.bootAt + 1000); }
  async call(pathname, value) {
    const body = value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value);
    let response;
    try { response = await this.request(pathname, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${this.bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Body-SHA256': hash(body) }) },
      ...(body === undefined ? {} : { body }) }); } catch { throw new Error('Local device transport failed.'); }
    check(response.status === 200, `Local device request rejected (HTTP ${response.status}).`);
    check(response.headers.get('cache-control') === 'no-store', 'Local device response lacks no-store.');
    try { return await response.json(); } catch { throw new Error('Local device response is not JSON.'); }
  }
  async register() {
    this.registrationBody ??= JSON.stringify(this.tools.v3Registration(this.caps));
    const r = await this.call('/api/v3/device/capabilities', this.registrationBody);
    check(r.protocol === 'campuspulse/3' && r.node_id === this.nodeId && r.boot_id === this.caps.boot_id && r.registration_seq === 1 &&
      r.capability_sha256 === await this.tools.capabilityDigestV3(this.caps) && r.applied === false, 'Capability receipt mismatch.');
    this.registered = true;
  }
  async acknowledge() {
    const pending = this.pendingAck, a = JSON.parse(pending.body), r = await this.call('/api/v3/device/config/ack', pending.body);
    check(Object.entries(a).every(([k, v]) => r[k] === v) && r.node_id === this.nodeId &&
      (pending.frozen.policy.evidence.mode !== 'statistics' || r.body_sha256 === hash(pending.body)) &&
      r.durability === 'committed' && r.evidence === 'device_ack', 'Configuration ACK receipt mismatch.');
    if (a.state === 'applied') {
      check(Number.isSafeInteger(r.lease_until_ms) && r.lease_until_ms > Date.parse(r.server_time), 'ACK lacks a committed lease.');
      this.applied = pending.frozen; this.lastGeneration = a.assignment_generation; this.leaseUntil = r.lease_until_ms;
      this.contactSeq = 0; this.pendingLease = null; this.cadenceMs = pending.frozen.policy.collection.summary.window_ms;
      this.nextStart = Math.max(this.clock(), Date.parse(r.server_time)) + 10;
      if (this.replay && this.replayRebasedStart === null) this.replayRebasedStart = this.nextStart;
      this.phase = 'applied';
    } else { this.phase = 'failed'; this.nextStart = null; }
    this.terminalGeneration = a.assignment_generation; this.pendingAck = null;
  }
  async configure() {
    if (this.pendingAck) return this.acknowledge();
    const delivered = await this.call(`/api/v3/device/config?boot_id=${this.caps.boot_id}`);
    check(delivered.protocol === 'campuspulse/3' && delivered.requires_device_ack === true &&
      typeof delivered.server_time === 'string' && Number.isFinite(Date.parse(delivered.server_time)), 'Configuration response mismatch.');
    this.configReason = delivered.reason ?? null;
    if (!delivered.config) { this.phase = delivered.reason === 'unassigned' ? 'unassigned' : 'unavailable'; this.nextStart = null; return; }
    const frozen = await this.tools.validateFrozenDeviceConfigV3(delivered.config), p = frozen.policy;
    if (p.assignment_generation <= this.terminalGeneration) return;
    // Drain retained older-policy bytes before a new activation closes its span.
    if (this.pending.length) return;
    let compatible = true;
    try {
      safePolicy(p, this.transport, this.custody);
      if (this.replay) check(p.collection.summary.window_ms === this.replay.window_ms && p.collection.summary.bin_ms === this.replay.bin_ms,
        'Replay cadence is immutable for this source.');
    } catch { compatible = false; }
    const boundary = { node_id: this.nodeId, boot_id: this.caps.boot_id, now: new Date(this.clock()).toISOString(),
      last_assignment_generation: this.lastGeneration, closed_window_seq: this.windowSeq, closed_segment_seq: 0, window_open: false, segment_open: false };
    const negotiation = await this.tools.negotiateDeviceConfigV3(frozen, this.caps, boundary);
    const failed = this.scenario === 'failed' || !compatible || negotiation.state !== 'compatible';
    const body = { protocol: 'campuspulse/3', boot_id: this.caps.boot_id, policy_id: p.policy_id, policy_sha256: frozen.policy_sha256,
      assignment_generation: p.assignment_generation, apply_seq: ++this.applySeq, state: failed ? 'failed' : 'applied',
      closed_window_seq: this.windowSeq, closed_segment_seq: 0, window_open: false, segment_open: false,
      ...(failed ? { error_code: this.scenario === 'failed' ? 'resource_exhausted' : 'unsupported_config' } : {}) };
    this.pendingAck = { body: JSON.stringify(body), frozen };
    try { await this.acknowledge(); } catch (error) { this.losses[4]++; throw error; }
  }
  async renew() {
    if (!this.applied || this.phase === 'failed' || this.phase === 'unavailable') return;
    const p = this.applied.policy, now = this.clock();
    if (!this.pendingLease && this.leaseUntil - now > p.control.lease.duration_ms / 2) return;
    this.pendingLease ??= JSON.stringify({ protocol: 'campuspulse/3', boot_id: this.caps.boot_id, policy_id: p.policy_id,
      policy_sha256: this.applied.policy_sha256, assignment_generation: p.assignment_generation,
      contact_seq: ++this.contactSeq, uptime_ms: this.uptime() });
    const a = JSON.parse(this.pendingLease), r = await this.call('/api/v3/device/lease', this.pendingLease);
    check(Object.entries(a).every(([k, v]) => r[k] === v) && r.schema === 'device-lease/3' && r.node_id === this.nodeId &&
      r.body_sha256 === hash(this.pendingLease) && r.durability === 'committed' && Number.isSafeInteger(r.lease_until_ms) &&
      r.lease_until_ms > Date.parse(r.server_time) && Number.isSafeInteger(r.span_seq) && typeof r.contiguous === 'boolean', 'Lease receipt mismatch.');
    if (!r.contiguous || this.nextStart === null) this.nextStart = Math.max(now, Date.parse(r.server_time)) + 10;
    this.leaseUntil = r.lease_until_ms; this.pendingLease = null;
  }
  envelope(stream, item) {
    const p = this.applied.policy;
    const value = { p: 3, z: 'statistics/1', b: randomUUID(), n: this.nodeId, o: this.caps.boot_id,
      c: p.policy_id, h: this.applied.policy_sha256, g: p.assignment_generation, d: this.custody.dataset, k: stream, x: [item] };
    const body = JSON.stringify(value);
    check(Buffer.byteLength(body) <= p.uplink.max_body_bytes, 'Synthetic batch exceeds negotiated body budget.');
    return { body, stream, batchId: value.b, attempts: 0, totalAttempts: 0, nextAttemptAt: 0, retry: { ...p.uplink.retry } };
  }
  collect() {
    if (this.replay && this.replayIndex >= this.replay.windows.length) {
      if (!this.pending.length && !this.pendingAck && !this.pendingLease && !['failed', 'unavailable'].includes(this.phase)) this.phase = 'replay_complete';
      return;
    }
    if (!this.applied || this.nextStart === null || ['failed', 'unavailable'].includes(this.phase) || this.scenario === 'failed') return;
    const now = this.clock(), p = this.applied.policy, duration = this.cadenceMs;
    if (this.nextStart + duration >= this.leaseUntil) { this.phase = 'lease_expired'; this.nextStart = null; return; }
    if (now < this.nextStart + duration) return;
    // One window+status pair occupies the two data slots; never silently evict.
    if (this.pending.length) { this.phase = 'queue_paused'; return; }
    const end = this.nextStart + duration, binMs = p.collection.summary.bin_ms, count = duration / binMs;
    const loss = this.scenario === 'loss', busy = this.scenario === 'busy';
    const reports = busy ? 48 : loss ? 32 : 4, identifiers = busy ? 12 : loss ? 8 : 2;
    const worker = reports * count, callback = loss ? 2 : 0, aggregation = loss ? 1 : 0;
    const time = [this.uptime(end), end, 1, 0];
    const synthetic = { d: duration, b: binMs,
      c: [0, 0, 0, 0, identifiers, 0], r: [worker + callback + aggregation, worker, worker - count, count],
      x: Array.from({ length: count }, () => [reports, identifiers, reports, -60 * reports]),
      s: [worker, -60 * worker, -60, -60], l: [loss ? duration - 100 : duration, callback, aggregation, 0],
      f: loss ? 52 : 0, v: ['cp-v3-stats/1', 'unclassified-v1'] };
    const source = this.replay ? this.replay.windows[this.replayIndex].item : synthetic;
    const window = { ...structuredClone(source), q: ++this.sequences.window_statistics, w: ++this.windowSeq, t: time,
      // This is the current replay clock mapping. Original clock evidence is
      // kept in the replay artifact, never promoted to current-time accuracy.
      f: source.f & ~2 };
    const stats = this.envelope('window_statistics', window); this.pending.push(stats);
    const status = { q: ++this.sequences.node_status, t: time, u: this.uptime(end), s: 'running',
      r: [null, null, null, null, null], j: [1, Buffer.byteLength(stats.body), 0, 0, 0, 0], l: [...this.losses] };
    this.pending.push(this.envelope('node_status', status));
    if (this.replay) this.replayIndex++;
    this.nextStart = Math.max(end, now); this.phase = 'collecting';
  }
  async flush() {
    while (this.pending.length) {
      const batch = this.pending[0];
      if (batch.attempts >= batch.retry.max_attempts) { this.phase = 'retry_exhausted'; return; }
      if (this.clock() < batch.nextAttemptAt) { this.phase = 'retry_pending'; return; }
      batch.attempts++; if (batch.totalAttempts++) this.losses[5]++;
      try {
        const receipt = await this.call('/api/v3/statistics/ingest', batch.body);
        expectedStatisticsReceipt(receipt, batch.body);
        this.accepted[batch.stream]++; this.pending.shift();
      } catch (error) {
        this.losses[3]++;
        batch.nextAttemptAt = this.clock() + Math.min(batch.retry.max_delay_ms, batch.retry.min_delay_ms * 2 ** (batch.attempts - 1));
        if (batch.attempts >= batch.retry.max_attempts) this.phase = 'retry_exhausted';
        throw error;
      }
    }
    if (this.phase === 'queue_paused') { this.nextStart = this.clock() + 10; this.phase = 'collecting'; }
  }
  async tick() {
    if (!this.running) return this.status();
    check(!this.inTick, 'Device ticks must be serialized.'); this.inTick = true;
    try {
      this.collect();
      if (this.scenario === 'offline') { this.phase = 'offline'; return this.status(); }
      if (!this.registered) await this.register();
      await this.flush(); await this.configure(); await this.renew(); this.collect(); await this.flush();
      if (!this.pending.length && !this.pendingAck && !this.pendingLease) this.lastError = null;
    } catch (error) { this.lastError = error.message; if (this.phase !== 'retry_exhausted') this.phase = 'retry_pending'; }
    finally { this.inTick = false; }
    return this.status();
  }
}
