import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function compare(before, after) {
  const folder = mkdtempSync(join(tmpdir(), 'cp-capacity-compare-'));
  try {
    writeFileSync(join(folder, 'before.jsonl'), before.map(JSON.stringify).join('\n'));
    writeFileSync(join(folder, 'after.jsonl'), after.map(JSON.stringify).join('\n'));
    return spawnSync(process.execPath, [new URL('./compare-bodies.mjs', import.meta.url).pathname,
      join(folder, 'before.jsonl'), join(folder, 'after.jsonl')], {encoding: 'utf8'});
  } finally { rmSync(folder, {recursive: true}); }
}
function batch(id, items) {
  return {addresses: 16, window_seconds: 30, hz: 1, raw: false,
    body: {protocol: 'campuspulse/2', node_id: 'synthetic', stream: 'address_summaries',
      batch_id: `22222222-2222-4222-8222-${String(id).padStart(12, '0')}`, items}};
}
const one = {seq: 1, time: {utc_ms: null, uncertainty_ms: null}, reports: 10, bins: [5, 5]};
const two = {seq: 2, time: {utc_ms: null, uncertainty_ms: null}, reports: 20, bins: [10, 10]};
test('differential accepts only regrouping and regenerated batch identity', () => {
  const result = compare([batch(1, [one, two])], [batch(2, [one]), batch(3, [two])]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).exact_items_compared, 2);
});
test('differential rejects item/order/envelope and raw field-order changes', () => {
  const before = [batch(1, [one, two])];
  const changedEnvelope = batch(2, [one, two]); changedEnvelope.body.node_id = 'wrong';
  for (const after of [
    [batch(2, [{...one, reports: 11}, two])],
    [batch(2, [two, one])],
    [changedEnvelope],
    [batch(2, [{reports: 10, seq: 1, time: one.time, bins: one.bins}, two])],
  ]) assert.notEqual(compare(before, after).status, 0);
});
