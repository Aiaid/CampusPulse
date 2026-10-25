/** Bounded, chronological replay. Keys are ephemeral BLE address/type pairs,
 * never people. All participant sets remain private to this computation. */
export const RULE_VERSION = 'cohort-disappearance-v0';
export const DEFAULT_CONFIG = Object.freeze({
  bin_ms: 5000, stable_lookback_bins: 6, stable_min_present_bins: 3,
  recent_presence_bins: 2, simultaneous_span_bins: 2,
  missing_confirm_bins: 3, min_lost_identifiers: 5, min_lost_fraction: 0.3,
  reappearance_bins: 6,
});

export function ruleConfig(overrides = {}) {
  if (Object.keys(overrides).some(k => !Object.hasOwn(DEFAULT_CONFIG, k))) throw new Error('unknown_rule_parameter');
  const c = { ...DEFAULT_CONFIG, ...overrides };
  for (const [k, v] of Object.entries(c)) {
    if (k === 'min_lost_fraction') {
      if (!Number.isFinite(v) || v <= 0 || v > 1) throw new Error('invalid_rule_parameter');
    } else if (!Number.isSafeInteger(v) || v < 1 || v > (k === 'bin_ms' ? 300000 : 512)) {
      throw new Error('invalid_rule_parameter');
    }
  }
  if (c.stable_min_present_bins > c.stable_lookback_bins || c.recent_presence_bins > c.stable_lookback_bins) {
    throw new Error('invalid_rule_parameter');
  }
  return c;
}

function contextKey(scope) {
  const keys = ['node_id', 'boot_id', 'placement_id', 'capture_config_id', 'dataset'];
  if (!scope || keys.some(k => typeof scope[k] !== 'string' || !scope[k])) throw new Error('invalid_context');
  return JSON.stringify(keys.map(k => scope[k]));
}

/** Each bin is a *complete, health-checked* projection from the adapter.
 * An unhealthy bin resets history; it must never be skipped as if it were empty.
 * ready=false bins may omit sightings, but still need valid bounds and scope.
 * This module intentionally has no IO, database, clock or platform dependency. */
export function detectCohortEvents(bins, options = {}) {
  const c = ruleConfig(options.config);
  if (!Array.isArray(bins) || bins.length > 4096) throw new Error('replay_limit_exceeded');
  const events = [], history = [], pending = new Map(), returns = new Map();
  let context = null, previousEnd = null, status = 'warming_up', reason = 'insufficient_history';
  let usableBins = 0, rejectedBins = 0, segment = 0;
  const reset = () => { history.length = 0; pending.clear(); returns.clear(); segment++; };
  for (const bin of bins) {
    const key = contextKey(bin.scope);
    if (!Number.isSafeInteger(bin.start_ms) || !Number.isSafeInteger(bin.end_ms) || bin.start_ms < 0 || bin.end_ms - bin.start_ms !== c.bin_ms) {
      throw new Error('invalid_bin_time');
    }
    if (key !== context) {
      // One scope per replay. Call separately for new boots, places or datasets;
      // never combine their events in an unlabeled result.
      if (context !== null) throw new Error('mixed_context');
      context = key; previousEnd = null; reset();
    }
    if (previousEnd !== null && bin.start_ms < previousEnd) throw new Error('unordered_or_overlapping_bins');
    const gap = previousEnd !== null && bin.start_ms !== previousEnd;
    previousEnd = bin.end_ms;
    if (gap) reset();
    if (bin.ready !== true) {
      reset(); rejectedBins++; status = 'degraded'; reason = bin.reason || 'incomplete_or_unhealthy_window'; continue;
    }
    if (!Array.isArray(bin.sightings) || bin.sightings.length > 64) throw new Error('invalid_sightings');
    const present = new Map();
    for (const sighting of bin.sightings) {
      if (typeof sighting.key !== 'string' || !sighting.key || present.has(sighting.key) ||
          !Number.isSafeInteger(sighting.last_seen_ms) || sighting.last_seen_ms < bin.start_ms || sighting.last_seen_ms >= bin.end_ms) {
        throw new Error('invalid_sighting');
      }
      present.set(sighting.key, sighting.last_seen_ms);
    }
    usableBins++;
    for (const [id, refs] of returns) {
      const active = refs.filter(ref => bin.end_ms <= ref.until);
      if (present.has(id)) {
        for (const ref of active) {
          const event = events[ref.index];
          event.reappeared_identifiers++;
          event.reappearance_flag = true;
        }
        returns.delete(id);
      } else if (active.length) returns.set(id, active);
      else returns.delete(id);
    }
    for (const id of present.keys()) pending.delete(id);

    if (history.length === c.stable_lookback_bins) {
      // Freeze denominator *before* the first missing bin, never at confirmation.
      const counts = new Map(), last = new Map(), recent = new Set();
      for (let i = 0; i < history.length; i++) {
        for (const [id, time] of history[i]) {
          counts.set(id, (counts.get(id) || 0) + 1); last.set(id, time);
          if (i >= history.length - c.recent_presence_bins) recent.add(id);
        }
      }
      const stable = new Set([...counts.keys()].filter(id => counts.get(id) >= c.stable_min_present_bins && recent.has(id)));
      for (const id of stable) {
        // Only the transition from present to absent starts a disappearance episode.
        if (!present.has(id) && history.at(-1).has(id) && !pending.has(id)) {
          pending.set(id, { last: last.get(id), absent_from: bin.start_ms, baseline: stable });
        }
      }
    }
    // Wait for the grouping horizon AND the absence horizon. This avoids emitting
    // half a group before later members have accumulated enough absence evidence.
    const sorted = [...pending.entries()].sort((a, b) => a[1].last - b[1].last || a[0].localeCompare(b[0]));
    for (const [anchorId, anchor] of sorted) {
      if (!pending.has(anchorId)) continue;
      const groupEnd = anchor.last + c.simultaneous_span_bins * c.bin_ms;
      const confirmationEnd = anchor.absent_from + (c.simultaneous_span_bins + c.missing_confirm_bins) * c.bin_ms;
      if (bin.end_ms < confirmationEnd) continue;
      const cohort = [...pending.entries()].filter(([id, p]) =>
        p.last >= anchor.last && p.last <= groupEnd && anchor.baseline.has(id) &&
        bin.end_ms - p.absent_from >= c.missing_confirm_bins * c.bin_ms);
      if (cohort.length >= c.min_lost_identifiers && cohort.length / anchor.baseline.size >= c.min_lost_fraction) {
        const from = Math.min(...cohort.map(([, p]) => p.last));
        const to = Math.max(...cohort.map(([, p]) => p.last));
        const event = {
          // Replay-local id; persistent integration must scope it and retain a cursor.
          id: `${RULE_VERSION}:${segment}:${from}:${to}`,
          event_from_mono_ms: from, event_to_mono_ms: to, confirmed_at_mono_ms: bin.end_ms,
          baseline_identifiers: anchor.baseline.size, lost_identifiers: cohort.length,
          lost_fraction: cohort.length / anchor.baseline.size,
          verification: 'unverified', rule_version: RULE_VERSION, rule_config: { ...c },
          reappearance_flag: false, reappeared_identifiers: 0,
        };
        events.push(event);
        for (const [id] of cohort) {
          const refs = returns.get(id) || [];
          refs.push({ index: events.length - 1, until: bin.end_ms + c.reappearance_bins * c.bin_ms });
          returns.set(id, refs); pending.delete(id);
        }
      }
      // Retire an expired anchor, including a subthreshold episode, so evidence
      // cannot accumulate across unrelated departures minutes apart.
      pending.delete(anchorId);
    }
    history.push(present);
    if (history.length > c.stable_lookback_bins) history.shift();
    status = history.length === c.stable_lookback_bins ? 'observing' : 'warming_up';
    reason = status === 'warming_up' ? 'insufficient_history' : null;
  }
  return { rule_version: RULE_VERSION, dataset: bins[0]?.scope.dataset ?? null, config: c, status, reason,
    usable_bins: usableBins, rejected_bins: rejectedBins, events };
}
