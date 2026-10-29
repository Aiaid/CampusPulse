// Compare offline synthetic fixture bodies. These files must never be uploaded.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function rawItems(line) {
  const body = line.slice(line.indexOf('"body":') + 7, -1);
  const start = body.indexOf('"items":[');
  assert.ok(start >= 0);
  const records = [];
  let depth = 0, quoted = false, escaped = false, from = -1;
  for (let i = start + 9; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (depth === 0) from = i;
      depth++;
    } else if (char === '}' || char === ']') {
      if (depth === 0) {
        assert.equal(char, ']');
        return records;
      }
      if (--depth === 0) records.push(body.slice(from, i + 1));
    }
  }
  throw new Error('Unterminated items');
}

function load(path) {
  const cases = new Map();
  let batches = 0, items = 0;
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    const row = JSON.parse(line);
    const {body} = row;
    const key = [row.addresses, row.window_seconds, row.hz, row.raw, body.stream].join('/');
    const {batch_id: batchId, items: bodyItems, ...envelope} = body;
    assert.match(batchId, /^[0-9a-f-]{36}$/);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 8192);
    let group = cases.get(key);
    if (!group) {
      group = {envelope, items: [], rawItems: []};
      cases.set(key, group);
    }
    assert.deepEqual(envelope, group.envelope, `Envelope changed within ${key}`);
    group.items.push(...bodyItems);
    const serializedItems = rawItems(line);
    assert.equal(serializedItems.length, bodyItems.length);
    group.rawItems.push(...serializedItems);
    batches++;
    items += bodyItems.length;
  }
  return {cases, batches, items};
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: node compare-bodies.mjs BEFORE.jsonl AFTER.jsonl');
const before = load(beforePath), after = load(afterPath);
assert.deepEqual([...after.cases.keys()].sort(), [...before.cases.keys()].sort());
for (const [key, expected] of before.cases) {
  assert.deepEqual(after.cases.get(key), expected, `Item or non-batch envelope changed: ${key}`);
}
console.log(JSON.stringify({status: 'pass', workload_stream_groups: before.cases.size,
  exact_items_compared: before.items, before_batches: before.batches, after_batches: after.batches}));
