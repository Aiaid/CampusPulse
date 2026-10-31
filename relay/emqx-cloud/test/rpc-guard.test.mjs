import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {RpcGuard, RpcGuardError} from '../rpc-guard.mjs';

const boot = value => `${value.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const hash = value => createHash('sha256').update(value).digest('hex');
const request = (overrides = {}) => ({node: 'node1', boot: boot(1), op: 'ingest',
  rpc: 1, digest: hash('synthetic'), bytes: 9, v3:{subop:5,receiptOnly:false}, publishedAtMs: 120000, ...overrides});
const rejected = (code, status) => error => {
  assert.ok(error instanceof RpcGuardError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.status, status);
  return true;
};

// The clone and commit/rollback behavior models the injected DO KV interface.
// This is a host unit test, not evidence of a deployed Cloudflare DO instance.
class FakeStorage {
  data = new Map();
  tail = Promise.resolve();
  failPut = false;
  transactions = 0;
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  transaction(callback) {
    const work = this.tail.then(async () => {
      this.transactions++;
      const staged = structuredClone(this.data);
      const result = await callback({
        get: async key => structuredClone(staged.get(key)),
        put: async (key, value) => {
          if (this.failPut) throw new Error('synthetic-private-storage-detail');
          staged.set(key, structuredClone(value));
        },
      });
      this.data = staged;
      return result;
    });
    this.tail = work.catch(() => {});
    return work;
  }
}

function fixture() {
  const storage = new FakeStorage();
  let time = 120000;
  const options = {now: () => time};
  return {storage, options, guard: new RpcGuard(storage, options),
    setTime(value) { time = value; },
    restart() { return new RpcGuard(storage, options); },
    state() { return structuredClone([...storage.data.values()][0]); }};
}

test('latest RPC survives restart and permits only identical retries', async () => {
  const f = fixture();
  assert.deepEqual(await f.guard.begin(request({rpc: 7})), {duplicate: false});
  const restarted = f.restart();
  assert.deepEqual(await restarted.begin(request({rpc: 7})), {duplicate: true});
  await assert.rejects(restarted.begin(request({rpc: 6})), rejected('rpc_conflict', 409));
  await assert.rejects(restarted.begin(request({rpc: 7, digest: hash('changed')})), rejected('rpc_conflict', 409));
  await assert.rejects(restarted.begin(request({rpc: 7, digest:hash('other frame subop')})), rejected('rpc_conflict', 409));
  assert.deepEqual(await restarted.begin(request({rpc: 8, digest: hash('changed')})), {duplicate: false});
  await assert.rejects(f.restart().begin(request({rpc: 7})), rejected('rpc_conflict', 409));
  assert.equal(f.state().rate.attempts, 7);
});

test('guard persists only replay digests and bounded rate state', async () => {
  const f = fixture();
  await f.guard.begin(request({body: 'untrusted-private-body', token: 'untrusted-private-token',
    response: 'untrusted-config-lease'}));
  const state = f.state();
  assert.deepEqual(Object.keys(state).sort(), ['boots', 'node', 'rate', 'version']);
  assert.equal(state.version, 2);
  assert.deepEqual(state.boots, [{boot: boot(1), rpc: 1, op: 'ingest', digest: hash('synthetic'), publishedAtMs: 120000}]);
  assert.ok(!JSON.stringify(state).includes('private'));
  assert.deepEqual(await f.restart().begin(request()), {duplicate: true});
});

test('current topic boot owns replay state even when ingest contains an old frozen batch', async () => {
  const f = fixture();
  const frozen = JSON.stringify({node_id: 'node1', boot_id: boot(1), seq: 2});
  const digest = hash(frozen);
  const bytes = Buffer.byteLength(frozen);
  await f.guard.begin(request({boot: boot(1), rpc: 99, digest, bytes}));
  await f.guard.begin(request({boot: boot(2), rpc: 1, digest, bytes}));
  assert.deepEqual(f.state().boots.map(row => [row.boot, row.rpc]), [[boot(1), 99], [boot(2), 1]]);
  assert.deepEqual(await f.restart().begin(request({boot: boot(2), rpc: 1, digest, bytes})), {duplicate: true});
  await assert.rejects(f.guard.begin(request({boot: boot(1), rpc: 1, digest, bytes})), rejected('rpc_conflict', 409));
});

test('64 active boots stay bounded but a legitimate 65th boot works after the replay window', async () => {
  const f = fixture();
  for (let i = 1; i <= 64; i++) await f.guard.begin(request({boot: boot(i)}));
  await assert.rejects(f.restart().begin(request({boot: boot(65)})), rejected('boot_limit', 429));
  f.setTime(250000);
  await assert.rejects(f.restart().begin(request({boot: boot(65), publishedAtMs: 250000})), rejected('boot_limit', 429));
  assert.equal(f.state().boots.length, 64);
  f.setTime(250001);
  assert.deepEqual(await f.restart().begin(request({boot: boot(65), publishedAtMs: 250001})), {duplicate: false});
  assert.deepEqual(f.state().boots.map(entry => entry.boot), [boot(65)]);
  // A newly published old frozen batch uses its current topic boot and fresh
  // broker time. API validation/idempotency still owns the application body.
  assert.deepEqual(await f.guard.begin(request({boot: boot(1), publishedAtMs: 250001})), {duplicate: false});
});

test('stale and future broker events cannot prune, migrate or reset persisted state', async () => {
  const f = fixture();
  await f.guard.begin(request({rpc: 9}));
  const before = f.state(), transactions = f.storage.transactions;
  f.setTime(250001);
  await assert.rejects(f.restart().begin(request()), rejected('stale_event', 400));
  await assert.rejects(f.restart().begin(request({publishedAtMs: 260002})), rejected('stale_event', 400));
  assert.equal(f.storage.transactions, transactions);
  assert.deepEqual(f.state(), before);
  await f.guard.begin(request({boot: boot(2), publishedAtMs: 250001}));
  const pruned = f.state();
  await assert.rejects(f.restart().begin(request({rpc: 9})), rejected('stale_event', 400));
  assert.deepEqual(f.state(), pruned);
});

test('timestamp boundaries and accepted duplicate high-water timestamps preserve the active replay window', async () => {
  const f = fixture();
  f.setTime(240000);
  await f.guard.begin(request()); // exactly 120 seconds old
  await f.guard.begin(request({publishedAtMs: 250000})); // exactly 10 seconds ahead
  assert.equal(f.state().boots[0].publishedAtMs, 250000);
  await f.guard.begin(request({publishedAtMs: 240000}));
  assert.equal(f.state().boots[0].publishedAtMs, 250000);
  await assert.rejects(f.guard.begin(request({rpc: 1, digest: hash('changed'), publishedAtMs: 250000})), rejected('rpc_conflict', 409));
  f.setTime(380000);
  await assert.rejects(f.restart().begin(request({rpc: 1, digest: hash('changed'), publishedAtMs: 380000})), rejected('rpc_conflict', 409));
  f.setTime(380001);
  assert.deepEqual(await f.restart().begin(request({rpc: 1, digest: hash('changed'), publishedAtMs: 380001})), {duplicate: false});
});

test('legacy v1 state migrates conservatively without clearing replay or rate history', async () => {
  const f = fixture();
  for (let i = 1; i <= 64; i++) await f.guard.begin(request({boot: boot(i), rpc: 8}));
  const [key, legacy] = [...f.storage.data.entries()][0];
  legacy.version = 1;
  for (const entry of legacy.boots) delete entry.publishedAtMs;
  f.storage.data.set(key, legacy);
  const before = f.state();
  f.setTime(1000000);
  await assert.rejects(f.restart().begin(request()), rejected('stale_event', 400));
  assert.deepEqual(f.state(), before);
  await assert.rejects(f.restart().begin(request({boot: boot(65), publishedAtMs: 1000000})), rejected('boot_limit', 429));
  assert.equal(f.state().version, 2);
  assert.equal(f.state().boots.length, 64);
  assert.ok(f.state().boots.every(entry => entry.publishedAtMs === 1000000 && entry.rpc === 8));
  await assert.rejects(f.restart().begin(request({rpc: 7, publishedAtMs: 1000000})), rejected('rpc_conflict', 409));
  f.setTime(1130001);
  await f.restart().begin(request({boot: boot(65), publishedAtMs: 1130001}));
  assert.equal(f.state().boots.length, 1);
  // Migration inside the same minute preserves an exhausted admission budget.
  const blocked = fixture();
  await blocked.guard.begin(request());
  const [blockedKey, state] = [...blocked.storage.data.entries()][0];
  state.version = 1; state.rate.attempts = 600;
  delete state.boots[0].publishedAtMs;
  blocked.storage.data.set(blockedKey, state);
  await assert.rejects(blocked.restart().begin(request()), rejected('rate_limit', 429));
  assert.equal(blocked.state().rate.attempts, 601);
  assert.equal(blocked.state().boots[0].rpc, 1);
});

test('600 attempts per fixed minute include duplicates and survive restart', async () => {
  const f = fixture();
  const input = request({op:'ingest',v3:{subop:2,receiptOnly:false},bytes:8,digest:hash('CPV3 config')});
  for (let i = 0; i < 600; i++) await f.guard.begin(input);
  await assert.rejects(f.restart().begin(input), rejected('rate_limit', 429));
  assert.equal(f.state().rate.attempts, 601);
  await assert.rejects(f.guard.begin(input), rejected('rate_limit', 429));
  assert.equal(f.state().rate.attempts, 601); // counter saturates, budget stays exhausted
  f.setTime(179999);
  await assert.rejects(f.restart().begin(input), rejected('rate_limit', 429));
  f.setTime(180000);
  assert.deepEqual(await f.restart().begin(input), {duplicate: true});
  assert.equal(f.state().rate.attempts, 1);
  assert.equal(f.state().boots[0].rpc, 1);
});

test('4 MiB per fixed minute counts exact body lengths and duplicate attempts', async () => {
  const f = fixture();
  const input = request({bytes: 8192});
  for (let i = 0; i < 512; i++) await f.guard.begin(input);
  assert.equal(f.state().rate.bytes, 4 * 1024 * 1024);
  await assert.rejects(f.restart().begin(request({rpc: 2, bytes: 8})), rejected('rate_limit', 429));
  assert.equal(f.state().boots[0].rpc, 1); // rejected request cannot advance replay state
  assert.equal(f.state().rate.bytes, 4 * 1024 * 1024 + 1);
  f.setTime(180000);
  assert.deepEqual(await f.restart().begin(request({rpc: 2, bytes: 8})), {duplicate: false});
});

test('CPV3 guard accepts only framed ingest and charges full wire lengths',async()=>{
  const f=fixture();const v3={subop:5,receiptOnly:false};
  await f.guard.begin(request({v3,bytes:8200}));
  assert.equal(f.state().rate.bytes,8200);
  assert.deepEqual(await f.restart().begin(request({v3,bytes:8200})),{duplicate:true});
  assert.equal(f.state().rate.bytes,16400);
  const invalid=[{v3,bytes:8201},{v3,bytes:7},{v3,op:'contact'},
    {v3:{subop:2,receiptOnly:false},bytes:9},{v3:{subop:0,receiptOnly:false}},
    {v3:{subop:6,receiptOnly:false}},{v3:{subop:1,receiptOnly:true}},
    {v3:{subop:2,receiptOnly:true}},{v3:{subop:5,receiptOnly:true}},
    {v3:{subop:3,receiptOnly:1}},{v3:{subop:3,receiptOnly:false,extra:true}},
    {v3:null},{v3:true},{v3:[]}];
  const before=f.state();
  for(const overrides of invalid)await assert.rejects(f.guard.begin(request(overrides)),rejected('invalid_rpc',400));
  assert.deepEqual(f.state(),before);
  await f.guard.begin(request({rpc:2,v3:{subop:2,receiptOnly:false},bytes:8}));
  for(const subop of [3,4])await f.guard.begin(request({rpc:subop,v3:{subop,receiptOnly:true},bytes:10}));
});

test('rejected replay attempts consume the persistent admission budget', async () => {
  const f = fixture();
  await f.guard.begin(request({rpc: 10, bytes: 8}));
  for (let i = 0; i < 599; i++) {
    await assert.rejects(f.guard.begin(request({rpc: 9, bytes: 8})), rejected('rpc_conflict', 409));
  }
  await assert.rejects(f.restart().begin(request({rpc: 10, bytes: 8})), rejected('rate_limit', 429));
  assert.equal(f.state().boots[0].rpc, 10);
});

test('clock rollback cannot replenish an exhausted budget', async () => {
  const f = fixture();
  const input = request({bytes: 8192});
  for (let i = 0; i < 512; i++) await f.guard.begin(input);
  await assert.rejects(f.guard.begin(input), rejected('rate_limit', 429));
  f.setTime(60000);
  await assert.rejects(f.restart().begin({...input, publishedAtMs: 60000}), rejected('rate_limit', 429));
  f.setTime(180000);
  assert.deepEqual(await f.guard.begin(input), {duplicate: true});
});

test('validates canonical identities, operations, hashes, sizes and nonzero uint32 RPCs', async () => {
  const f = fixture();
  const invalid = [null, {v3:undefined}, {node: ''}, {node: 'Node1'}, {node: 'n'.repeat(65)},
    {boot: boot(1).toUpperCase().replace('8111', 'A111')},
    {boot: boot(1).replace('-4111-', '-5111-')}, {boot: boot(1).replace('-8111-', '-7111-')},
    {op: 'delete'}, {rpc: '1'}, {rpc: 0}, {rpc: -1}, {rpc: 1.5}, {rpc: 0x100000000},
    {rpc: Number.NaN}, {digest: 'a'.repeat(63)}, {digest: 'A'.repeat(64)},
    {bytes: -1}, {bytes: 8201}, {bytes: 0.1}, {bytes: '9'}, {op: 'config', bytes: 1},
    {publishedAtMs: undefined}, {publishedAtMs: 0}, {publishedAtMs: -1}, {publishedAtMs: 0.1},
    {publishedAtMs: '120000'}, {publishedAtMs: Number.NaN}, {publishedAtMs: Number.MAX_SAFE_INTEGER + 1}];
  for (const item of invalid) {
    await assert.rejects(f.guard.begin(item === null ? null : request(item)), rejected('invalid_rpc', 400));
  }
  assert.equal(f.storage.transactions, 0);
  assert.deepEqual(await f.guard.begin(request({rpc: 0xffffffff})), {duplicate: false});
  await assert.rejects(f.guard.begin(request({rpc: 1})), rejected('rpc_conflict', 409));
});

test('per-node storage identity cannot be rebound to reset replay state', async () => {
  const f = fixture();
  await f.guard.begin(request());
  await assert.rejects(f.restart().begin(request({node: 'node2'})), rejected('node_mismatch', 403));
  assert.equal(f.state().node, 'node1');
  assert.equal(f.state().boots.length, 1);
});

test('transaction serializes concurrent guard instances without losing the maximum RPC', async () => {
  const f = fixture();
  const inputs = Array.from({length: 50}, (_, i) => request({rpc: i + 1}));
  await Promise.all(inputs.map(input => f.restart().begin(input)));
  assert.equal(f.state().boots[0].rpc, 50);
  assert.equal(f.state().rate.attempts, 50);
  await assert.rejects(f.guard.begin(request({rpc: 49})), rejected('rpc_conflict', 409));
});

test('storage failures roll back, fail closed, and do not expose private causes', async () => {
  const f = fixture();
  await f.guard.begin(request());
  f.storage.failPut = true;
  await assert.rejects(f.guard.begin(request({rpc: 2})), rejected('guard_unavailable', 503));
  assert.equal(f.state().boots[0].rpc, 1);
  f.storage.failPut = false;
  assert.deepEqual(await f.restart().begin(request()), {duplicate: true});
  assert.deepEqual(await f.guard.begin(request({rpc: 2})), {duplicate: false});
});

test('malformed persisted state and invalid clocks do not reset audit history', async () => {
  const f = fixture();
  await f.guard.begin(request());
  const [key, state] = [...f.storage.data.entries()][0];
  state.boots[0].rpc = 0;
  f.storage.data.set(key, state);
  await assert.rejects(f.restart().begin(request()), rejected('guard_unavailable', 503));
  assert.equal(f.state().boots[0].rpc, 0);
  for (const now of [() => Number.NaN, () => -1, () => 1.5, () => { throw new Error('private'); }]) {
    await assert.rejects(new RpcGuard(new FakeStorage(), {now}).begin(request()), rejected('guard_unavailable', 503));
  }
});
