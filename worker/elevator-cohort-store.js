import { detectCohortEvents, RULE_VERSION } from './elevator-cohort-rules.js';
import { projectAddressWindow } from './elevator-cohort-adapter.js';

const LOOKBACK_MS = 15 * 60000;
const MAX_WINDOWS = 60;
const STATUS_AGE_MS = 120000;
const LOSS_KEYS = ['aggregation_drops', 'storage_drops', 'windows_dropped',
  'address_summaries_dropped', 'address_table_overflow_reports',
  'accounting_overrun_reports', 'unpersisted_window_reports'];
const iso = ms => new Date(ms).toISOString();

/** Read-only, bounded field projection. Private address sets never leave here.
 * Recompute on request: no new D1 schema, task queue or ingestion ACK dependency.
 * One freshest partition per place avoids double-counting multiple observers. */
export async function readElevatorEvents(db, placeId, now = Date.now()) {
  const nowText = iso(now);
  const base = { place_id: placeId, as_of: nowText, data_until: null, valid_until: null,
    status: 'unavailable', reason: 'no_address_windows', rule_version: RULE_VERSION,
    events: [], truncated: false };
  const latest = await db.prepare(`SELECT w.node_id,w.boot_id,w.placement_id,w.capture_config_id,
      w.utc_ms,c.config_json
    FROM ingestion_items_v2 w
    JOIN placements p ON p.id=w.placement_id AND p.node_id=w.node_id
    JOIN capture_configs c ON c.id=w.capture_config_id AND c.node_id=w.node_id
      AND c.placement_id=w.placement_id AND c.dataset=w.dataset
    JOIN device_nodes n ON n.id=w.node_id AND n.enabled=1
    LEFT JOIN placement_closures x ON x.placement_id=p.id AND x.node_id=p.node_id
    WHERE p.place_id=? AND w.stream='ble_windows' AND w.dataset='field'
      AND w.utc_ms BETWEEN ? AND ? AND w.expires_at_ms>? AND w.received_at<=?
      AND json_extract(c.config_json,'$.protocol')='campuspulse/2'
      AND w.utc_ms-w.duration_ms-COALESCE(json_extract(w.item_json,'$.time.uncertainty_ms'),0)>=p.valid_from_ms
      AND w.utc_ms+COALESCE(json_extract(w.item_json,'$.time.uncertainty_ms'),0)<=COALESCE(x.valid_until_ms,p.valid_until_ms,9223372036854775807)
    ORDER BY w.utc_ms DESC,w.received_at DESC,w.node_id,w.seq DESC LIMIT 1`)
    .bind(placeId, now - LOOKBACK_MS, now, now, nowText).first();
  if (!latest) return base;
  const config = JSON.parse(latest.config_json);
  const binMs = config.summary?.bin_ms;
  if (!Number.isSafeInteger(binMs) || binMs < 1000 || binMs > 300000) {
    return { ...base, status: 'degraded', reason: 'unsupported_capture_config' };
  }
  const scope = { node_id: latest.node_id, boot_id: latest.boot_id,
    placement_id: latest.placement_id, capture_config_id: latest.capture_config_id, dataset: 'field' };
  const partition = [scope.node_id, scope.boot_id, scope.placement_id, scope.capture_config_id];
  // Include unhealthy windows so they break history. Filtering them out could
  // silently bridge an interval of unknown radio/collector state.
  const windowResult = await db.prepare(`SELECT w.seq,w.item_json,w.utc_ms
    FROM ingestion_items_v2 w JOIN placements p ON p.id=w.placement_id AND p.node_id=w.node_id
    LEFT JOIN placement_closures x ON x.placement_id=p.id AND x.node_id=p.node_id
    WHERE w.node_id=? AND w.boot_id=? AND w.placement_id=? AND w.capture_config_id=?
      AND w.dataset='field' AND w.stream='ble_windows' AND w.utc_ms BETWEEN ? AND ?
      AND w.expires_at_ms>? AND w.received_at<=?
      AND w.utc_ms-w.duration_ms-COALESCE(json_extract(w.item_json,'$.time.uncertainty_ms'),0)>=p.valid_from_ms
      AND w.utc_ms+COALESCE(json_extract(w.item_json,'$.time.uncertainty_ms'),0)<=COALESCE(x.valid_until_ms,p.valid_until_ms,9223372036854775807)
    ORDER BY w.seq DESC LIMIT 61`).bind(...partition, now - LOOKBACK_MS, now, now, nowText).all();
  const rows = windowResult.results.slice(0, MAX_WINDOWS).reverse();
  if (!rows.length) return base;
  const windows = rows.map(row => ({ ...row, item: JSON.parse(row.item_json) }));
  const seqs = rows.map(row => row.seq);
  const placeholders = seqs.map(() => '?').join(',');
  const summariesResult = await db.prepare(`SELECT window_seq,item_json FROM ingestion_items_v2
    WHERE node_id=? AND boot_id=? AND placement_id=? AND capture_config_id=?
      AND dataset='field' AND stream='address_summaries' AND window_seq IN (${placeholders})
      AND expires_at_ms>? AND received_at<=?
    ORDER BY seq LIMIT 3841`).bind(...partition, ...seqs, now, nowText).all();
  if (summariesResult.results.length > MAX_WINDOWS * 64) {
    return { ...base, status: 'degraded', reason: 'summary_limit_exceeded', truncated: true };
  }
  const byWindow = new Map();
  for (const row of summariesResult.results) {
    const list = byWindow.get(row.window_seq) || [];
    list.push(JSON.parse(row.item_json)); byWindow.set(row.window_seq, list);
  }
  const firstStart = windows[0].item.time.mono_ms - windows[0].item.duration_ms;
  const lastEnd = windows.at(-1).item.time.mono_ms;
  const statusResult = await db.prepare(`SELECT item_json FROM ingestion_items_v2
    WHERE node_id=? AND boot_id=? AND placement_id=? AND capture_config_id=?
      AND dataset='field' AND stream='node_status' AND expires_at_ms>? AND received_at<=?
      AND json_extract(item_json,'$.time.mono_ms') BETWEEN ? AND ?
    ORDER BY json_extract(item_json,'$.time.mono_ms') DESC LIMIT 65`)
    .bind(...partition, now, nowText, Math.max(0, firstStart - STATUS_AGE_MS), lastEnd).all();
  const statuses = statusResult.results.map(row => JSON.parse(row.item_json)).reverse();
  const projected = [];
  let previousWindow = null;
  for (const { item: window } of windows) {
    let bins;
    try { bins = projectAddressWindow({ scope, window, summaries: byWindow.get(window.seq) || [] }, binMs); }
    catch { return { ...base, status: 'degraded', reason: 'invalid_window_layout' }; }
    let reason = null;
    const uncertainty = window.time.uncertainty_ms;
    if (!Number.isSafeInteger(uncertainty) || uncertainty < 0 || uncertainty > 30000 ||
        window.time.utc_ms !== rows.find(row => row.seq === window.seq)?.utc_ms) reason = 'uncertain_clock';
    if (previousWindow && (window.time.mono_ms <= previousWindow.time.mono_ms || window.seq !== previousWindow.seq + 1 ||
        window.time.clock_epoch !== previousWindow.time.clock_epoch)) reason = 'window_sequence_or_clock_gap';
    if (previousWindow) {
      const utcDelta = window.time.utc_ms - previousWindow.time.utc_ms;
      const monoDelta = window.time.mono_ms - previousWindow.time.mono_ms;
      const clockTolerance = Math.min(binMs, (window.time.uncertainty_ms ?? 0) + (previousWindow.time.uncertainty_ms ?? 0));
      if (utcDelta <= 0 || Math.abs(utcDelta - monoDelta) > clockTolerance) reason = 'clock_mapping_discontinuity';
    }
    const end = window.time.mono_ms;
    const eligible = statuses.filter(s => s.time.mono_ms <= end && end - s.time.mono_ms <= STATUS_AGE_MS && s.time.clock_epoch === window.time.clock_epoch);
    const status = eligible.at(-1);
    if (!status) reason = reason || 'missing_node_health';
    else {
      const beforeStart = statuses.filter(s => s.time.mono_ms <= end - window.duration_ms && s.time.clock_epoch === window.time.clock_epoch).at(-1);
      const loss = status.loss_totals || {};
      const changed = LOSS_KEYS.some(k => {
        const value = loss[k] ?? 0;
        const previous = beforeStart?.loss_totals?.[k] ?? 0;
        return !Number.isSafeInteger(value) || value < 0 || value !== previous;
      });
      if (status.scan_state !== 'running' || status.buffer_health?.pause_reason || changed) reason = reason || 'node_health_or_loss';
    }
    if (reason) bins = bins.map(b => ({ ...b, ready: false, reason, sightings: [] }));
    projected.push(...bins); previousWindow = window;
  }
  let result;
  try { result = detectCohortEvents(projected, { config: { bin_ms: binMs } }); }
  catch { return { ...base, status: 'degraded', reason: 'discontinuous_window_layout' }; }
  const last = windows.at(-1).item;
  const lastUncertainty = Number.isSafeInteger(last.time.uncertainty_ms) && last.time.uncertainty_ms >= 0 ? last.time.uncertainty_ms : 30000;
  const validUntil = last.time.utc_ms - lastUncertainty + 120000;
  const toUtc = mono => {
    const parent = windows.find(({ item }) => mono >= item.time.mono_ms - item.duration_ms && mono <= item.time.mono_ms);
    return parent ? parent.item.time.utc_ms - (parent.item.time.mono_ms - mono) : null;
  };
  const events = [];
  let invalidEventClock = false;
  for (const event of result.events.slice(-20)) {
    const from = toUtc(event.event_from_mono_ms), to = toUtc(event.event_to_mono_ms), confirmed = toUtc(event.confirmed_at_mono_ms);
    if (from === null || to === null || confirmed === null || from > to || to > confirmed) {
      invalidEventClock = true; continue;
    }
    const identity = JSON.stringify([...partition, RULE_VERSION, event.event_from_mono_ms, event.event_to_mono_ms]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
    events.push({ id: [...digest].map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 32),
      event_from: iso(from), event_to: iso(to), confirmed_at: iso(confirmed),
      baseline_identifiers: event.baseline_identifiers, lost_identifiers: event.lost_identifiers,
      lost_fraction: event.lost_fraction, verification: 'unverified',
      reappearance_flag: event.reappearance_flag, reappeared_identifiers: event.reappeared_identifiers });
  }
  const stale = now >= validUntil;
  return { ...base, data_until: iso(last.time.utc_ms), valid_until: iso(validUntil),
    status: stale ? 'stale' : invalidEventClock ? 'degraded' : result.status,
    reason: stale ? 'data_expired' : invalidEventClock ? 'clock_mapping_discontinuity' : result.reason,
    events: events.reverse(), truncated: windowResult.results.length > MAX_WINDOWS || result.events.length > 20 };
}
