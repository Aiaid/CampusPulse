import {MAX_ORIGINAL_BODY, MAX_V3_WIRE, V3_HEADER_BYTES, validV3Metadata} from './v3-frame.mjs';

const NODE = /^[a-z0-9_-]{1,64}$/;
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const OPS = new Set(['contact', 'config', 'activation', 'ingest']);
const KEY = 'rpc-guard-v1';
const MAX_BOOTS = 64;
const MAX_ATTEMPTS = 600;
const MAX_BYTES = 4 * 1024 * 1024;
const FRESHNESS_MS = 120_000;
const FUTURE_SKEW_MS = 10_000;
// Keep replay state slightly beyond the entire accepted publication window.
const RETAIN_MS = FRESHNESS_MS + FUTURE_SKEW_MS;
const STATUS = {invalid_rpc: 400, node_mismatch: 403, rpc_conflict: 409,
  stale_event: 400, boot_limit: 429, rate_limit: 429, guard_unavailable: 503};

export class RpcGuardError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RpcGuardError';
    this.code = code;
    this.status = STATUS[code] ?? 503;
  }
}

function uint32(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

function validEntry(entry) {
  return entry && typeof entry.boot === 'string' && BOOT.test(entry.boot) &&
    uint32(entry.rpc) && OPS.has(entry.op) &&
    typeof entry.digest === 'string' && DIGEST.test(entry.digest);
}

function validState(state) {
  return state && (state.version === 1 || state.version === 2) && typeof state.node === 'string' && NODE.test(state.node) &&
    Array.isArray(state.boots) && state.boots.length <= MAX_BOOTS &&
    state.boots.every(entry => validEntry(entry) && (state.version === 1 ||
      Number.isSafeInteger(entry.publishedAtMs) && entry.publishedAtMs > 0)) &&
    new Set(state.boots.map(entry => entry.boot)).size === state.boots.length &&
    state.rate && Number.isSafeInteger(state.rate.minute) && state.rate.minute >= 0 &&
    Number.isInteger(state.rate.attempts) && state.rate.attempts >= 0 && state.rate.attempts <= MAX_ATTEMPTS + 1 &&
    Number.isInteger(state.rate.bytes) && state.rate.bytes >= 0 && state.rate.bytes <= MAX_BYTES + 1;
}

/**
 * One instance's storage belongs to one allowlisted node. The caller computes
 * digest from the exact wire bytes (including the CPV3 header) and supplies the current MQTT topic
 * boot, which may differ from an old frozen ingest batch's body boot. The broker
 * supplies publishedAtMs; the authenticated webhook also checks its freshness.
 *
 * begin() only reserves replay/rate state, never a successful outcome. The outer
 * DO owns its one in-flight operation in memory and clears it in finally. After
 * eviction/crash an identical retry is allowed and must reach CF again, including
 * config requests: no lease, body, response or credentials are cached here.
 * Expired boot records may be pruned because their original broker events can
 * no longer pass freshness. Fresh republications still face API idempotency and
 * retired-boot checks; this guard does not promise lifetime RPC ordering.
 */
export class RpcGuard {
  constructor(storage, {now = Date.now} = {}) {
    this.storage = storage;
    this.now = now;
  }

  async begin(input) {
    const {node, boot, op, rpc, digest, bytes, publishedAtMs, v3} = input ?? {};
    const framed = v3 !== undefined;
    if (typeof node !== 'string' || !NODE.test(node) ||
        !validEntry({boot, op, rpc, digest}) ||
        (framed && (!validV3Metadata(v3) || op !== 'ingest')) ||
        !Number.isInteger(bytes) || bytes < (framed ? V3_HEADER_BYTES : 0) ||
        bytes > (framed ? MAX_V3_WIRE : MAX_ORIGINAL_BODY) ||
        (framed && v3.subop === 2 && bytes !== V3_HEADER_BYTES) ||
        !Number.isSafeInteger(publishedAtMs) || publishedAtMs <= 0 ||
        (op === 'config' && bytes !== 0)) throw new RpcGuardError('invalid_rpc');

    let result;
    try {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error();
      // Reject before touching storage: stale replay cannot prune/migrate state
      // or reset a rate window, including after an object restart.
      if (publishedAtMs < now - FRESHNESS_MS || publishedAtMs > now + FUTURE_SKEW_MS)
        throw new RpcGuardError('stale_event');
      const minute = Math.floor(now / 60000);
      // Use only txn storage APIs and no external I/O. A rejection is returned
      // from the callback so the attempted request's rate charge still commits.
      result = await this.storage.transaction(async txn => {
        let state = await txn.get(KEY);
        if (state !== undefined && !validState(state)) throw new Error();
        if (state === undefined) state = {version: 2, node, boots: [],
          rate: {minute, attempts: 0, bytes: 0}};
        if (state.node !== node) return {error: 'node_mismatch'};
        if (state.version === 1) {
          // The old schema has no timestamps. Conservatively retain every
          // high-water mark for a full window; never wipe existing counters.
          state.version = 2;
          for (const entry of state.boots) entry.publishedAtMs = Math.max(1, now);
        }
        state.boots = state.boots.filter(entry => entry.publishedAtMs >= now - RETAIN_MS);
        // Fixed UTC-minute window; clock rollback never creates a fresh budget.
        if (minute > state.rate.minute) state.rate = {minute, attempts: 0, bytes: 0};
        state.rate.attempts = Math.min(MAX_ATTEMPTS + 1, state.rate.attempts + 1);
        state.rate.bytes = Math.min(MAX_BYTES + 1, state.rate.bytes + bytes);

        let error;
        let duplicate = false;
        const previous = state.boots.find(entry => entry.boot === boot);
        if (state.rate.attempts > MAX_ATTEMPTS || state.rate.bytes > MAX_BYTES) error = 'rate_limit';
        else if (previous && (rpc < previous.rpc ||
            (rpc === previous.rpc && (op !== previous.op || digest !== previous.digest)))) error = 'rpc_conflict';
        else if (!previous && state.boots.length >= MAX_BOOTS) error = 'boot_limit';
        else if (previous) {
          duplicate = rpc === previous.rpc;
          if (!duplicate) Object.assign(previous, {rpc, op, digest});
          previous.publishedAtMs = Math.max(previous.publishedAtMs, publishedAtMs);
        } else state.boots.push({boot, rpc, op, digest, publishedAtMs});

        await txn.put(KEY, state);
        return error ? {error} : {duplicate};
      });
    } catch (error) {
      if (error instanceof RpcGuardError) throw error;
      // Storage failures fail closed without including possibly sensitive causes.
      throw new RpcGuardError('guard_unavailable');
    }
    if (result.error) throw new RpcGuardError(result.error);
    return result;
  }
}
