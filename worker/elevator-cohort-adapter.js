/** Adapter for validated, committed v2 window/address-summary items.
 * It never fetches MACs through the public API. Use only private server-side data.
 * Incomplete windows produce explicit rejected bins, not an empty observation. */
export function projectAddressWindow({ scope, window: w, summaries }, binMs = 5000) {
  if (!w || !w.time || !Number.isSafeInteger(w.time.mono_ms) ||
      !Number.isSafeInteger(w.duration_ms) || w.duration_ms < binMs ||
      !Number.isSafeInteger(binMs) || binMs < 1000 ||
      w.duration_ms % binMs || w.duration_ms / binMs > 60 || w.time.mono_ms < w.duration_ms) {
    throw new Error('invalid_window_bounds');
  }
  const start = w.time.mono_ms - w.duration_ms;
  const bins = Array.from({ length: w.duration_ms / binMs }, (_, i) => ({
    scope, start_ms: start + i * binMs, end_ms: start + (i + 1) * binMs,
    ready: false, reason: 'incomplete_summaries', sightings: [],
  }));
  const reject = reason => bins.map(b => ({ ...b, reason }));
  if (!Array.isArray(summaries) || summaries.length > 64) return reject('invalid_summary_set');
  if (!Number.isSafeInteger(w.seq) || w.seq < 1 ||
      !Number.isSafeInteger(w.visible_identifiers) || w.visible_identifiers < 0 || w.visible_identifiers > 64 ||
      !Number.isSafeInteger(w.reports_aggregated) || w.reports_aggregated < 0 ||
      !Number.isSafeInteger(w.scan_enabled_ms) || w.scan_enabled_ms > w.duration_ms ||
      w.scan_enabled_ms / w.duration_ms < 0.9 || w.aggregation_drops !== 0 ||
      w.unique_table_overflow !== false || !Array.isArray(w.quality_flags) || w.quality_flags.length) {
    return reject('unhealthy_window');
  }
  const keys = new Set();
  let total = 0;
  for (const s of summaries) {
    if (!s || !s.time || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(s.address) ||
        !['public', 'random', 'public_identity', 'random_identity', 'unknown'].includes(s.address_type)) {
      return reject('invalid_summary');
    }
    const key = `${s.address_type}:${s.address}`;
    if (keys.has(key)) return reject('duplicate_summary');
    keys.add(key);
    if (s.window_seq !== w.seq || s.duration_ms !== w.duration_ms || s.bin_ms !== binMs ||
        s.time.mono_ms !== w.time.mono_ms || s.time.clock_epoch !== w.time.clock_epoch ||
        s.time.utc_ms !== w.time.utc_ms || s.time.uncertainty_ms !== w.time.uncertainty_ms ||
        !Array.isArray(s.bins) || s.bins.length !== bins.length ||
        s.bins.some(n => !Number.isSafeInteger(n) || n < 0) ||
        !Number.isSafeInteger(s.reports) || s.reports < 1 ||
        s.bins.reduce((a, b) => a + b, 0) !== s.reports ||
        !Number.isSafeInteger(s.adv_reports) || s.adv_reports < 0 ||
        !Number.isSafeInteger(s.scan_response_reports) || s.scan_response_reports < 0 ||
        s.adv_reports + s.scan_response_reports !== s.reports ||
        !Number.isSafeInteger(s.first_offset_ms) || !Number.isSafeInteger(s.last_offset_ms) ||
        s.first_offset_ms < 0 || s.last_offset_ms < s.first_offset_ms || s.last_offset_ms >= w.duration_ms) {
      return reject('summary_window_mismatch');
    }
    const first = Math.floor(s.first_offset_ms / binMs), last = Math.floor(s.last_offset_ms / binMs);
    if (!s.bins[first] || !s.bins[last] || s.bins.some((n, i) => n > 0 && (i < first || i > last))) {
      return reject('summary_offset_mismatch');
    }
    total += s.reports;
    for (let i = 0; i < bins.length; i++) if (s.bins[i]) {
      // Non-final count bins do not carry exact last-report times. Use their
      // upper bound and retain bin resolution; never invent per-bin RSSI.
      bins[i].sightings.push({ key,
        last_seen_ms: i === last ? start + s.last_offset_ms : bins[i].end_ms - 1 });
    }
  }
  if (keys.size !== w.visible_identifiers || total !== w.reports_aggregated) return reject('incomplete_summaries');
  return bins.map(b => ({ ...b, ready: true, reason: null }));
}
