#!/usr/bin/env node
/** Explicit production preview, with synthetic provenance and session-only queue.
 * node scripts/v3-online-simulator.mjs --config /private/owned-0600.json [--phase prepare|run]
 * Private config: origin, operator_confirmed_production_simulation, nodeId,
 * placementId, deviceBearer, mqtt:{uri,username,password,namespace},
 * optional adminCookie (otherwise wait for ordinary administrator UI assignment),
 * optional cadenceMs (1000/30000/60000), durationMs (1000..1200000), scenario,
 * vehicleData (default false), vehicleCounts:{bikes,cars} (default3/2 when enabled).
 * continuous:true runs until stopped, renewing only at drained boundaries.
 * No device HTTP fallback, raw observations or automatic reboot.
 */
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readPrivateJson, httpsTransport } from './v3-device-integration.mjs';
import { createSimulatedV3Device, createSimulationPolicy, simulationVehicleProfile } from './lib/v3-simulated-device.mjs';
import { createMqttV3DeviceClient, validateMqttCredentials } from './lib/v3-mqtt-device-client.mjs';

export const ONLINE_SIMULATOR_ORIGIN = 'https://pulse.anend.net';
const check = (ok, message) => { if (!ok) throw new Error(message); };
export function validateOnlineSimulatorConfig(value) {
  check(value && Object.keys(value).every(k => ['origin', 'operator_confirmed_production_simulation', 'nodeId', 'placementId',
    'deviceBearer', 'adminCookie', 'mqtt', 'cadenceMs', 'durationMs', 'assignmentWaitMs', 'continuous', 'scenario', 'vehicleData', 'vehicleCounts'].includes(k)), 'Invalid online simulator configuration.');
  check(value.origin === ONLINE_SIMULATOR_ORIGIN && value.operator_confirmed_production_simulation === true,
    'Explicit pinned production simulation confirmation is required.');
  check(typeof value.nodeId === 'string' && /^sim-live-[a-z0-9_-]+$/.test(value.nodeId) && value.nodeId.length <= 64 &&
    typeof value.placementId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.placementId), 'Invalid virtual device scope.');
  for (const key of ['deviceBearer', ...(value.adminCookie === undefined ? [] : ['adminCookie'])]) check(typeof value[key] === 'string' && value[key].length >= 8 &&
    value[key].length <= 8192 && !/[\r\n\0]/.test(value[key]), 'Missing private authorization.');
  validateMqttCredentials(value.mqtt);
  const vehicleData = value.vehicleData === undefined ? false : value.vehicleData;
  simulationVehicleProfile(vehicleData, value.vehicleCounts);
  const cadenceMs = value.cadenceMs ?? 1000, durationMs = value.durationMs ?? 1200000, scenario = value.scenario ?? 'busy';
  const continuous = value.continuous ?? false, assignmentWaitMs = value.assignmentWaitMs ?? 1200000;
  check(typeof continuous === 'boolean' && Number.isInteger(assignmentWaitMs) && assignmentWaitMs >= 1000 && assignmentWaitMs <= 1200000,
    'Invalid continuous mode or initial assignment wait.');
  check([1000, 30000, 60000].includes(cadenceMs) && Number.isInteger(durationMs) && durationMs >= 1000 && durationMs <= 1200000 &&
    ['quiet', 'busy', 'loss'].includes(scenario), 'Invalid bounded simulation timing or scenario.');
  return { ...value, cadenceMs, durationMs, assignmentWaitMs, continuous, scenario, vehicleData };
}
export function parseOnlineSimulatorArgs(args) {
  check((args.length === 2 || args.length === 4) && args[0] === '--config' && path.isAbsolute(args[1]) &&
    (args.length === 2 || args[2] === '--phase' && ['prepare', 'run'].includes(args[3])),
  'Usage: node scripts/v3-online-simulator.mjs --config /private/config.json [--phase prepare|run]');
  return { configFile: args[1], phase: args[3] ?? 'run' };
}

/** Dependencies permit testing without broker connections or production mutation. */
export async function runOnlineSimulator(rawConfig, phase = 'run', dependencies = {}) {
  const config = validateOnlineSimulatorConfig(rawConfig);
  check(['prepare', 'run'].includes(phase), 'Invalid online simulator phase.');
  check(phase !== 'prepare' || config.adminCookie, 'Prepare requires a private administrator session; otherwise use run and assign through the administrator UI.');
  const now = dependencies.now ?? Date.now, sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const adminTransport = dependencies.adminTransport ?? httpsTransport();
  const onlineConfiguration = { origin: config.origin, operator_confirmed_production_simulation: true,
    nodeId: config.nodeId, placementId: config.placementId, dataset: 'field', purpose: 'site_observation' };
  let client, device, stopping = false, runStartedAt = null, runDeadline = null, waitDeadline = null;
  let lastRpc = 0, reconnects = 0, reconnectFailures = 0, nextConnectAt = 0;
  const priorCounts = { requests: 0, replies: 0, timeouts: 0, rejectedReplies: 0 };
  const stop = () => { stopping = true; };
  const forceRenew = () => { if (config.continuous) device?.requestCapabilityRenewal('operator_requested'); };
  dependencies.signal?.addEventListener('abort', stop, { once: true });
  dependencies.renewSignal?.addEventListener('renew', forceRenew);
  function transportStatus() {
    const current = client?.status() ?? {};
    return { ...current, ...Object.fromEntries(Object.keys(priorCounts).map(k => [k, priorCounts[k] + (current[k] ?? 0)])),
      lastRpc: Math.max(lastRpc, current.lastRpc ?? 0), connected: current.connected ?? Boolean(client), reconnects, reconnectFailures, nextConnectAtMs: nextConnectAt || null };
  }
  async function connect() {
    if (client && client.status().connected !== false) return true;
    if (now() < nextConnectAt) return false;
    if (client) {
      const old = client.status(); lastRpc = Math.max(lastRpc, old.lastRpc ?? 0);
      for (const k of Object.keys(priorCounts)) priorCounts[k] += old[k] ?? 0;
      await client.close(); client = null; reconnects++;
    }
    try {
      client = await (dependencies.createClient ?? createMqttV3DeviceClient)({ mqtt: config.mqtt, nodeId: config.nodeId,
        bootId: device.capabilities.boot_id, initialRpc: lastRpc });
      reconnectFailures = 0; nextConnectAt = 0;
      // Reconnect never changes retained bytes, batch identities or boot clocks.
      if (device.status().pendingBatches.some(batch => batch.retryExhausted)) device.retryPending();
      return true;
    } catch {
      reconnectFailures++; nextConnectAt = now() + Math.min(30000, 1000 * 2 ** Math.min(5, reconnectFailures - 1));
      return false;
    }
  }
  async function adminCall(pathname, body) {
    const response = await adminTransport(config.origin + pathname, { method: body === undefined ? 'GET' : 'POST',
      redirect: 'error', headers: { Cookie: config.adminCookie, Origin: config.origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    check(response.status === 200 && response.headers.get('cache-control') === 'no-store', 'Scoped administrator request failed.');
    try { return await response.json(); } catch { throw new Error('Invalid administrator response.'); }
  }
  function summary(outcome) {
    const state = device.status();
    return { schema: 'v3-online-simulator-report/1', outcome, nodeId: config.nodeId, producer: 'synthetic-statistics/1',
      dataset: 'field', transport: 'mqtt_tls', queuePersistence: 'session-only', physicalValidation: false,
      continuous: config.continuous, runPhase: outcome === 'stopped' ? 'stopped' :
        ['initial_assignment_timeout', 'bounded_run_complete'].includes(outcome) ? 'complete' : runStartedAt === null ? 'waiting_for_assignment' : 'running',
      runStartedAtMs: runStartedAt, runDeadlineMs: runDeadline, assignmentWaitDeadlineMs: waitDeadline,
      reason: state.renewalReason ?? state.configReason ?? null,
      phase: state.phase, accepted: state.accepted, losses: state.losses, pendingItems: state.pendingItems,
      pendingControlItems: state.pendingControlItems, pendingBytes: state.pendingBytes,
      appliedGeneration: state.appliedGeneration, registrationSeq: state.registrationSeq, capabilityId: state.capabilityId,
      capabilityExpiresAt: state.capabilityExpiresAt, awaitingCapabilityAssignment: state.awaitingCapabilityAssignment,
      registrationPending: state.registrationPending,
      deviceError: Boolean(state.lastError), transportCounts: transportStatus() };
  }
  try {
    device = await createSimulatedV3Device({ nodeId: config.nodeId, deviceBearer: config.deviceBearer, transport: 'mqtt_tls',
      onlineConfiguration, cadenceMs: config.cadenceMs, scenario: config.scenario, now,
      vehicleData: config.vehicleData, vehicleCounts: config.vehicleCounts,
      continuous: config.continuous, request: (...args) => {
        check(client, 'MQTT device connection is unavailable.'); return client.request(...args);
      } });
    await connect();
    await device.start();
    if (!config.continuous || config.adminCookie)
      check(device.status().registered && !device.status().lastError, 'Virtual capability registration failed.');
    if (config.adminCookie) {
      const inspection = await adminCall(`/api/v1/admin/device-v3/nodes/${config.nodeId}`);
      check(inspection.capabilities?.boot_id === device.capabilities.boot_id &&
        inspection.capabilities?.producer_version === 'synthetic-statistics/1', 'Registered virtual capabilities differ.');
      const previous = inspection.desired?.policy?.assignment_generation ?? 0;
      check(Number.isSafeInteger(previous) && previous >= 0, 'Invalid assignment generation.');
      const policy = await createSimulationPolicy(device.capabilities, { placementId: config.placementId,
        cadenceMs: config.cadenceMs, generation: previous + 1, now: now(), transport: 'mqtt_tls', onlineConfiguration,
        vehicleData: config.vehicleData, vehicleCounts: config.vehicleCounts });
      const assigned = await adminCall('/api/v1/admin/device-v3/assignments', { policy, expected_generation: previous });
      const frozen = await device.tools.freezeDeviceConfigV3(policy);
      check(assigned.policy_sha256 === frozen.policy_sha256 && assigned.applied === false && assigned.requires_device_ack === true,
        'Virtual policy assignment receipt differs.');
      if (phase === 'prepare') return summary('prepared_awaiting_synthetic_ack');
      await device.tick();
      check(device.status().appliedGeneration === previous + 1 && !device.status().lastError, 'Virtual policy activation failed.');
    }
    function updateRunClock() {
      if (runStartedAt === null && device.status().appliedGeneration > 0) {
        runStartedAt = now(); runDeadline = config.continuous ? null : runStartedAt + config.durationMs;
      }
    }
    waitDeadline = config.continuous ? null : now() + config.assignmentWaitMs;
    updateRunClock();
    dependencies.onProgress?.(summary(runStartedAt !== null ? 'running' : 'waiting_for_assignment'));
    let lastProgress = now();
    while (!stopping && !dependencies.signal?.aborted && (runDeadline ?? waitDeadline ?? Infinity) > now()) {
      await sleep(Math.min(1000, (runDeadline ?? waitDeadline ?? Infinity) - now()));
      if (stopping || dependencies.signal?.aborted) break;
      if (await connect()) await device.tick();
      updateRunClock();
      if (now() - lastProgress >= 30000) {
        dependencies.onProgress?.(summary(device.status().appliedGeneration ? 'running' : 'waiting_for_assignment')); lastProgress = now();
      }
    }
    return summary(stopping || dependencies.signal?.aborted ? 'stopped' : runStartedAt === null ? 'initial_assignment_timeout' : 'bounded_run_complete');
  } finally {
    dependencies.signal?.removeEventListener('abort', stop);
    dependencies.renewSignal?.removeEventListener('renew', forceRenew);
    if (device) {
      device.stop();
      // Retain original frozen bytes for operator recovery/audit. This snapshot
      // is not a restart implementation and does not assert durable queue media.
      try {
        await dependencies.preserveState?.({ schema: 'v3-online-simulator-session/1', origin: config.origin,
          nodeId: config.nodeId, placementId: config.placementId, queuePersistence: 'session-only', restartRecovery: false,
          capabilities: device.capabilities, policy: device.applied, pending: device.pending,
          registrationBody: device.registrationBody, pendingAck: device.pendingAck, pendingLease: device.pendingLease,
          transport: transportStatus(), status: device.status() });
      } finally { await client?.close(); }
    } else await client?.close();
  }
}

async function main() {
  const args = parseOnlineSimulatorArgs(process.argv.slice(2)), config = await readPrivateJson(args.configFile);
  const controller = new AbortController(), stop = () => controller.abort();
  const renewSignal = new EventTarget(), forceRenew = () => renewSignal.dispatchEvent(new Event('renew'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.on('SIGUSR1', forceRenew);
  const pidFile = `${args.configFile}.pid`, pidHandle = await open(pidFile, 'wx', 0o600);
  await pidHandle.writeFile(String(process.pid) + '\n'); await pidHandle.close();
  try {
    const report = await runOnlineSimulator(config, args.phase, { signal: controller.signal, renewSignal,
      onProgress: value => process.stdout.write(JSON.stringify(value) + '\n'),
      preserveState: async state => {
        const handle = await open(`${args.configFile}.${randomUUID()}.session-state.json`, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(state) + '\n'); } finally { await handle.close(); }
      } });
    process.stdout.write(JSON.stringify(report) + '\n');
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('SIGUSR1', forceRenew);
    await unlink(pidFile);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main().catch(() => { process.stderr.write('Online simulator failed; inspect private configuration and scoped authorization.\n'); process.exitCode = 1; });
