import { json } from './ingest';
import { IngestError } from './ingest-validation';
import { statisticsLimits } from './device-v3-statistics';
import { loadStatisticsAuthority, statisticsCaptureAssertion, v3StatisticsEnabled,
  type DeviceV3StatisticsEnv } from './device-v3-statistics-policy';
import { validateStatisticsV3Window, type StatisticsV3Window } from './device-v3-statistics-validation';

export const ACTIVITY_VERSION = 'ble-bin-activity-ema120s/1';
const FLAGS = ['partial_window', 'uncertain_clock', 'scan_gap', 'identifier_overflow', 'callback_loss', 'aggregation_loss'];
const activityEligible = (w: StatisticsV3Window) => !(w.quality_mask & ~2) && w.time.utc_ms !== null &&
  w.time.uncertainty_ms !== null && w.time.uncertainty_ms <= 5000 && w.losses.scan_coverage_ms === w.duration_ms;
interface Row {
  node_id: string; boot_id: string; generation: number; placement_id: string;
  window_seq: number; clock_epoch: number; seq: number; end_utc_ms: number; uncertainty_ms: number;
  duration_ms: number; received_at_ms: number; expires_at_ms: number; quality_mask: number;
  extractor_version: string; ruleset_version: string; item_json: string; policy_id: string; policy_sha256: string;
}

/** Causal, bounded smoothing of per-bin identifier activity; never a population estimate. */
export function smoothStatisticsActivity(windows: readonly StatisticsV3Window[]) {
  let ema: number | null = null;
  for (const w of windows) {
    if (!w.bins.length || !activityEligible(w)) throw new Error('Incomplete activity input');
    const activity = w.bins.reduce((n, bin) => n + bin.visible_identifiers, 0) / w.bins.length;
    const alpha = 1 - Math.exp(-w.duration_ms / 120000);
    ema = ema === null ? activity : ema + alpha * (activity - ema);
  }
  return { value: ema, windows: windows.length, version: ACTIVITY_VERSION, unit: 'mean_visible_identifiers_per_bin' };
}

const unavailable = (reason: string, now: number) => ({ schema: 'public-statistics/3', state: 'unavailable', reason,
  as_of: new Date(now).toISOString(), observed_at: null as string | null, valid_until: null as string | null,
  visible_identifiers: null, candidates: null, activity: null, estimated_total: null });

/** A separate aggregate read: never substitutes candidate events for manual elevator waits. */
export async function readPlaceStatistics(env: DeviceV3StatisticsEnv, placeId: string, now = Date.now()) {
  if (!v3StatisticsEnabled(env)) return unavailable('disabled', now);
  const place = await env.DB.prepare('SELECT observation_kinds_json FROM places WHERE id=?').bind(placeId)
    .first<{ observation_kinds_json: string }>();
  if (!place) return unavailable('place_not_found', now);
  let purposes: unknown;
  try { purposes = JSON.parse(place.observation_kinds_json); } catch { return unavailable('invalid_place_scope', now); }
  if (!Array.isArray(purposes) || !purposes.some(p => ['activity', 'parking', 'elevator'].includes(p))) return unavailable('purpose_not_enabled', now);
  // Bound both receiver scope and retained time. The placement/dataset/time index
  // avoids a scan over all retained private windows.
  const scopes = await env.DB.prepare(`SELECT p.id,p.node_id FROM placements p
    LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id
    JOIN device_nodes n ON n.id=p.node_id AND n.enabled=1
    WHERE p.place_id=? AND p.valid_from_ms<=? AND COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)>?
    ORDER BY p.id LIMIT 33`).bind(placeId, now, now).all<{ id: string; node_id: string }>();
  if (scopes.results.length > 32) return unavailable('receiver_scope_limit', now);
  if (!scopes.results.length) return unavailable('no_active_receiver', now);
  // Stable selection is independent of reception time and positive categories.
  // An operator can change it by closing/rebinding placements; never add peers.
  const primary = scopes.results.slice(0, 1);
  const rows = await env.DB.prepare(`SELECT w.*,a.policy_id,a.policy_sha256 FROM json_each(?) s
    CROSS JOIN statistics_windows_v3 w INDEXED BY statistics_windows_v3_projection
      ON w.placement_id=json_extract(s.value,'$.id') AND w.node_id=json_extract(s.value,'$.node_id')
    JOIN device_assignments_v3 a ON a.node_id=w.node_id AND a.generation=w.generation AND a.boot_id=w.boot_id
    WHERE w.dataset='field' AND w.collection_mode='fixed_point' AND w.item_json IS NOT NULL
      AND w.expires_at_ms>? AND w.received_at_ms<=? AND w.end_utc_ms>=? AND w.end_utc_ms<=?
    ORDER BY w.end_utc_ms DESC,w.node_id,w.window_seq DESC LIMIT 13`)
    .bind(JSON.stringify(primary), now, now, now - 3600000, now).all<Row>();
  const latest = rows.results[0];
  if (!latest) return unavailable('no_field_statistics', now);
  let authority;
  try {
    authority = await loadStatisticsAuthority(env, { node_id: latest.node_id, boot_id: latest.boot_id,
      assignment_generation: latest.generation, policy_id: latest.policy_id, policy_sha256: latest.policy_sha256 });
  } catch (error) {
    if (error instanceof IngestError && error.status < 500) return unavailable('source_authority_unavailable', now);
    throw error;
  }
  const policy = authority.policy;
  if (policy.custody.dataset !== 'field' || policy.collection.mode !== 'fixed_point' ||
      policy.custody.placement_id !== latest.placement_id) return unavailable('inconsistent_source_scope', now);
  const limits = { ...statisticsLimits(policy), max_bins: authority.capabilities.summary?.max_bins };
  const decoded: Array<{ row: Row; value: StatisticsV3Window }> = [];
  try {
    for (const row of rows.results.filter(r => r.node_id === latest.node_id && r.boot_id === latest.boot_id &&
      r.generation === latest.generation && r.clock_epoch === latest.clock_epoch).slice(0, 12)) {
      if (row.item_json.length > 8192) throw new Error('Unbounded source');
      const w: StatisticsV3Window = JSON.parse(row.item_json);
      const checked = validateStatisticsV3Window({ q: w.seq, w: w.window_seq,
        t: [w.time.mono_ms, w.time.utc_ms, w.time.clock_epoch, w.time.uncertainty_ms], d: w.duration_ms, b: w.bin_ms,
        c: ['phone_candidate','e_bike_candidate','car_candidate','other','unknown','conflicting'].map(k => w.categories[k as keyof typeof w.categories]),
        r: [w.reports.received,w.reports.worker,w.reports.adv,w.reports.scan_response],
        x: w.bins.map(b => [b.worker_reports,b.visible_identifiers,b.rssi_samples,b.rssi_sum_dbm]),
        s: [w.rssi.samples,w.rssi.sum_dbm,w.rssi.min_dbm,w.rssi.max_dbm],
        l: [w.losses.scan_coverage_ms,w.losses.callback_drops,w.losses.aggregation_drops,w.losses.address_overflow_reports],
        f: w.quality_mask,v: [w.versions.extractor_version,w.versions.ruleset_version] }, limits);
      if (checked.seq !== row.seq || checked.window_seq !== row.window_seq || checked.time.utc_ms !== row.end_utc_ms ||
          checked.time.clock_epoch !== row.clock_epoch || checked.time.uncertainty_ms !== row.uncertainty_ms ||
          checked.duration_ms !== row.duration_ms || checked.quality_mask !== row.quality_mask ||
          checked.versions.extractor_version !== row.extractor_version || checked.versions.ruleset_version !== row.ruleset_version ||
          checked.time.uncertainty_ms === null || checked.time.uncertainty_ms > 5000) throw new Error('Inconsistent source');
      decoded.push({ row, value: checked });
    }
  } catch { return unavailable('invalid_statistics_source', now); }
  const w = decoded[0]?.value;
  if (!w || w.time.utc_ms === null || w.time.uncertainty_ms === null) return unavailable('invalid_statistics_source', now);
  const assertion = statisticsCaptureAssertion(authority, w.time.utc_ms - w.time.uncertainty_ms - w.duration_ms,
    w.time.utc_ms + w.time.uncertainty_ms);
  const valid = await env.DB.prepare(`SELECT CASE WHEN (${assertion.sql}) THEN 1 ELSE 0 END ok`).bind(...assertion.bindings).first<{ ok: number }>();
  if (valid?.ok !== 1) return unavailable('source_authority_unavailable', now);
  const validUntil = latest.end_utc_ms - latest.uncertainty_ms + Math.max(90000, 2 * latest.duration_ms);
  const observed = { observed_at: new Date(latest.end_utc_ms).toISOString(), valid_until: new Date(validUntil).toISOString() };
  if (validUntil <= now) return { ...unavailable('stale_statistics', now), ...observed };
  const complete = activityEligible(w);
  const history = [w];
  if (complete) for (const { value: previous } of decoded.slice(1)) {
    const next = history[history.length - 1];
    if (!activityEligible(previous) ||
        previous.window_seq + 1 !== next.window_seq || previous.time.mono_ms + next.duration_ms !== next.time.mono_ms ||
        previous.time.utc_ms === null || previous.time.uncertainty_ms === null || next.time.utc_ms === null || next.time.uncertainty_ms === null ||
        Math.abs(next.time.utc_ms - previous.time.utc_ms - next.duration_ms) > previous.time.uncertainty_ms + next.time.uncertainty_ms ||
        previous.versions.ruleset_version !== next.versions.ruleset_version) break;
    const earlierAssertion = statisticsCaptureAssertion(authority,
      previous.time.utc_ms - previous.time.uncertainty_ms - previous.duration_ms,
      previous.time.utc_ms + previous.time.uncertainty_ms);
    const earlierValid = await env.DB.prepare(`SELECT CASE WHEN (${earlierAssertion.sql}) THEN 1 ELSE 0 END ok`)
      .bind(...earlierAssertion.bindings).first<{ ok: number }>();
    if (earlierValid?.ok !== 1) break;
    history.push(previous);
  }
  return { schema: 'public-statistics/3', state: complete ? 'observed' : 'partial_observation', reason: null,
    as_of: new Date(now).toISOString(), ...observed, unit: 'observed_address_type_keys',
    visible_identifiers: w.visible_identifiers, candidates: w.categories, estimated_total: null,
    reports_per_second: w.reports.worker * 1000 / w.duration_ms,
    activity: complete ? smoothStatisticsActivity(history.reverse()) : null,
    quality: { flags: FLAGS.filter((_, i) => w.quality_mask & (1 << i)), ...w.losses },
    versions: w.versions, source: { receivers: 1, selection: 'stable-active-placement-order/1', window_ms: w.duration_ms, bin_ms: w.bin_ms } };
}

export async function handlePublicStatistics(request: Request, env: DeviceV3StatisticsEnv): Promise<Response | null> {
  const url = new URL(request.url), match = /^\/api\/v3\/places\/([a-z0-9_-]{1,64})\/statistics$/.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET' || url.search) return json({ error: { code: 'invalid_public_statistics_request', retryable: false } }, 405);
  return json(await readPlaceStatistics(env, match[1]));
}
