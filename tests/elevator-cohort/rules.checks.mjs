import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCohortEvents, ruleConfig } from '../../worker/elevator-cohort-rules.js';
import { projectAddressWindow } from '../../worker/elevator-cohort-adapter.js';
import { syntheticDemo, replay, htmlReport } from '../../scripts/elevator-cohort-replay.mjs';

const scope = { node_id: 'test-node', boot_id: 'test-boot', placement_id: 'test-place',
  capture_config_id: 'test-config', dataset: 'demo' };
const ids = Array.from({ length: 18 }, (_, i) => `synthetic-key-${i}`);
function binsFor(choose, n = 30) {
  return Array.from({ length: n }, (_, i) => ({ scope: { ...scope },
    start_ms: i * 5000, end_ms: (i + 1) * 5000, ready: true,
    sightings: choose(i).map(key => ({ key, last_seen_ms: (i + 1) * 5000 - 1000 })),
  }));
}
const vanish = () => binsFor(i => i < 6 ? ids : ids.slice(6));

test('stable cohort disappears: frozen denominator, delayed confirmation, no repeated event', () => {
  const r = detectCohortEvents(vanish());
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.lost_identifiers, 6);
  assert.equal(e.baseline_identifiers, 18);
  assert.equal(e.lost_fraction, 6 / 18);
  assert.equal(e.event_from_mono_ms, 29000);
  assert.equal(e.confirmed_at_mono_ms, 55000);
  assert.equal(e.verification, 'unverified');
  assert.equal(r.status, 'observing');
  assert.equal(JSON.stringify(r).includes('synthetic-key'), false);
});

test('new arrivals do not cancel the disappearance even if total count stays unchanged', () => {
  const newcomers = Array.from({ length: 6 }, (_, i) => `new-${i}`);
  const r = detectCohortEvents(binsFor(i => i < 6 ? ids : [...ids.slice(6), ...newcomers]));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].lost_identifiers, 6);
});

test('one-bin missed scan followed by return does not trigger', () => {
  assert.equal(detectCohortEvents(binsFor(i => i === 6 ? ids.slice(6) : ids)).events.length, 0);
});

test('subthreshold absolute count does not trigger', () => {
  assert.equal(detectCohortEvents(binsFor(i => i < 6 ? ids : ids.slice(4))).events.length, 0);
});

test('subthreshold fraction does not trigger even with five disappearances', () => {
  const many = Array.from({ length: 60 }, (_, i) => `key-${i}`);
  assert.equal(detectCohortEvents(binsFor(i => i < 6 ? many : many.slice(5))).events.length, 0);
});

test('two-bin synchronized group waits for every member and emits one event', () => {
  const r = detectCohortEvents(binsFor(i => i < 6 ? ids : i === 6 ? ids.slice(3) : ids.slice(6)));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].lost_identifiers, 6);
  assert.equal(r.events[0].event_to_mono_ms, 34000);
  assert.ok(r.events[0].confirmed_at_mono_ms - 35000 >= 15000);
});

test('scattered departures do not accumulate into an old cohort', () => {
  const r = detectCohortEvents(binsFor(i => ids.filter((_, j) => j >= 6 || i < 6 + j * 4), 40));
  assert.equal(r.events.length, 0);
});

test('unhealthy bins break absence confirmation and require warmup', () => {
  const input = vanish();
  input[7] = { ...input[7], ready: false, reason: 'scan_paused', sightings: [] };
  const r = detectCohortEvents(input);
  assert.equal(r.events.length, 0);
  assert.equal(r.rejected_bins, 1);
});

test('a missing time bin is a gap, never absence evidence', () => {
  const input = vanish(); input.splice(7, 1);
  assert.equal(detectCohortEvents(input).events.length, 0);
});

test('no warmup means no event, and rejected final bin leaves degraded state', () => {
  const input = vanish().slice(0, 3);
  assert.equal(detectCohortEvents(input).status, 'warming_up');
  input.push({ ...vanish()[3], ready: false, reason: 'incomplete_summaries' });
  const r = detectCohortEvents(input);
  assert.equal(r.status, 'degraded'); assert.equal(r.reason, 'incomplete_summaries');
});

test('confirmed event is retained and flagged if identifiers return soon', () => {
  const input = binsFor(i => i < 6 || i >= 12 ? ids : ids.slice(6));
  const r = detectCohortEvents(input);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].reappearance_flag, true);
  assert.equal(r.events[0].reappeared_identifiers, 6);
});

test('a returned and restabilized cohort can leave again', () => {
  const input = binsFor(i => i < 6 || i >= 12 && i < 18 ? ids : ids.slice(6), 35);
  const r = detectCohortEvents(input);
  assert.equal(r.events.length, 2);
  assert.notEqual(r.events[0].id, r.events[1].id);
});

test('disjoint groups close together are not suppressed by a global cooldown', () => {
  const input = binsFor(i => i < 6 ? ids : i < 7 ? ids.slice(6) : ids.slice(12));
  // Both groups fall inside one clustering horizon: report the observable merged group.
  const r = detectCohortEvents(input);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].lost_identifiers, 12);
});

test('out-of-order, overlapping and duplicate bins are rejected, not silently sorted', () => {
  const input = vanish();
  assert.throws(() => detectCohortEvents([input[1], input[0]]), /unordered/);
  assert.throws(() => detectCohortEvents([input[0], input[0]]), /unordered/);
});

test('node, boot, placement, config and dataset are isolated', () => {
  for (const field of Object.keys(scope)) {
    const input = vanish(); input[7].scope[field] = `different-${field}`;
    assert.throws(() => detectCohortEvents(input), /mixed_context/);
  }
});

test('configuration and replay bounds fail closed', () => {
  assert.throws(() => ruleConfig({ min_lost_fraction: 0 }), /invalid/);
  assert.throws(() => ruleConfig({ min_lost_fraction: NaN }), /invalid/);
  assert.throws(() => ruleConfig({ stable_min_present_bins: 7 }), /invalid/);
  assert.throws(() => ruleConfig({ probability: 0.8 }), /unknown/);
  assert.throws(() => detectCohortEvents(new Array(4097)), /limit/);
});

test('v2 adapter feeds a real-shaped synthetic replay end to end', () => {
  const r = replay(syntheticDemo());
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].lost_identifiers, 6);
  assert.equal(r.mode, 'offline_replay'); assert.equal(r.realtime, false);
  assert.equal(r.source, 'synthetic'); assert.equal(r.dataset, 'demo');
  assert.equal(JSON.stringify(r).includes('02:00:'), false);
});

test('incomplete summaries are not interpreted as empty observations', () => {
  const input = syntheticDemo(); input.windows[1].summaries.pop();
  const projected = projectAddressWindow(input.windows[1]);
  assert.ok(projected.every(b => !b.ready && b.reason === 'incomplete_summaries'));
  assert.equal(replay(input).events.length, 0);
});

test('duplicate address summaries fail completeness, address types stay distinct', () => {
  const bundle = syntheticDemo().windows[0];
  bundle.summaries[1] = structuredClone(bundle.summaries[0]);
  assert.equal(projectAddressWindow(bundle)[0].reason, 'duplicate_summary');
  bundle.summaries[1].address_type = 'public';
  assert.ok(projectAddressWindow(bundle).every(b => b.ready));
});

test('summary mismatch, overflow, scan pauses and loss reject all affected bins', () => {
  for (const mutate of [
    b => { b.summaries[0].window_seq++; },
    b => { b.summaries[0].time = { ...b.summaries[0].time, mono_ms: 40000 }; },
    b => { b.summaries[0].bins[0] = 0; },
    b => { b.summaries[0].last_offset_ms = 1000; },
    b => { b.window.unique_table_overflow = true; },
    b => { b.window.scan_enabled_ms = 0; },
    b => { b.window.aggregation_drops = 1; },
    b => { b.window.quality_flags = ['partial_window']; },
  ]) {
    const bundle = syntheticDemo().windows[0]; mutate(bundle);
    assert.ok(projectAddressWindow(bundle).every(b => !b.ready));
  }
});

test('complete zero window can confirm absence; incomplete zero cannot', () => {
  const input = syntheticDemo();
  for (const b of input.windows.slice(1)) {
    b.summaries = []; b.window.visible_identifiers = 0; b.window.reports_aggregated = 0;
  }
  assert.equal(replay(input).events[0].lost_identifiers, 18);
  input.windows[1].window.visible_identifiers = 1;
  assert.equal(replay(input).events.length, 0);
});

test('invalid bounds reject before array allocation; malformed summary data rejects safely', () => {
  const bundle = syntheticDemo().windows[0];
  assert.throws(() => projectAddressWindow(bundle, 0), /bounds/);
  bundle.summaries[0].address = 'bad';
  assert.equal(projectAddressWindow(bundle)[0].reason, 'invalid_summary');
});

test('demo cannot be labeled as field data and HTML contains background and no MACs', () => {
  const input = syntheticDemo(); input.windows[0].scope.dataset = 'field';
  assert.throws(() => replay(input), /synthetic_dataset/);
  const result = replay(syntheticDemo());
  const html = htmlReport(result);
  assert.ok(html.includes('合成数据演示')); assert.ok(html.includes('走出大厅'));
  assert.ok(html.includes('6 / 18')); assert.ok(!html.includes('02:00:'));
  result.status = '<script>alert(1)</script>';
  assert.ok(htmlReport(result).includes('&lt;script&gt;'));
});
