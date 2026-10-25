// Public field reads only. Synthetic scene data must never enter this module.
export const FIELD_REFRESH_MS = 30_000;
const ranges = [1, 5, 15, 60, 1440];
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const integer = value => Number.isInteger(value) && value >= 0;
const invalid = () => { throw new Error('现场服务返回了无效记录'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const waitSeconds = value => Number.isFinite(value) && value >= 0 && value <= 7200;

/** Receipt evidence has no trustworthy validity interval. Keep it out of history. */
export function isLastReportedSensor(record) {
  return object(record) && record.source === 'sensor' && record.dataset === 'field'
    && ['node_id', 'boot_id', 'placement_id', 'capture_config_id'].every(key => typeof record[key] === 'string' && record[key].trim())
    && ['seq', 'visible_identifiers', 'reports_aggregated', 'duration_ms', 'scan_enabled_ms', 'aggregation_drops'].every(key => Number.isSafeInteger(record[key]) && record[key] >= 0)
    && record.duration_ms > 0 && record.scan_enabled_ms <= record.duration_ms
    && timestamp(record.received_at) && new Date(record.received_at).toISOString() === record.received_at
    && (record.observed_at === null || timestamp(record.observed_at)) && record.valid_until === null
    && (record.uncertainty_ms === null || (Number.isSafeInteger(record.uncertainty_ms) && record.uncertainty_ms >= 0))
    && record.time_status === (record.observed_at === null ? 'unknown' : 'uncertain')
    && record.freshness === 'unverified' && typeof record.unique_table_overflow === 'boolean' && strings(record.quality_flags);
}

export const displayFieldSensor = summary => summary?.sensor || summary?.last_reported_sensor || null;

/** Optional inference stays separate from sensor and manual observations. */
export function normalizeAutomaticObservations(value) {
  if (value === undefined) return undefined; // Older API deployments remain readable.
  if (!object(value) || !object(value.vehicles) || !object(value.elevator)) invalid();
  for (const record of [value.vehicles, value.elevator]) {
    if (typeof record.model_version !== 'string' || !record.model_version.trim() || !integer(record.sample_count)
      || (record.reason !== null && typeof record.reason !== 'string')
      || (record.observed_at !== null && !timestamp(record.observed_at))
      || (record.valid_until !== null && !timestamp(record.valid_until))) invalid();
    if (record.status !== 'unavailable' && (!timestamp(record.observed_at) || !timestamp(record.valid_until)
      || Date.parse(record.valid_until) <= Date.parse(record.observed_at) || !record.sample_count)) invalid();
  }
  const { vehicles, elevator } = value;
  if (vehicles.source !== 'ble_rule_inference' || !['candidate_estimate', 'unavailable'].includes(vehicles.status)
    || !['compact', 'raw', 'none'].includes(vehicles.evidence_kind) || !strings(vehicles.quality_flags)) invalid();
  for (const key of ['candidate_count', 'car_related_count', 'ecosystem_count']) {
    if (vehicles[key] !== null && !integer(vehicles[key])) invalid();
  }
  if (vehicles.status === 'candidate_estimate' && (vehicles.candidate_count === null || vehicles.evidence_kind === 'none')) invalid();
  if (vehicles.status === 'unavailable' && vehicles.candidate_count !== null) invalid();
  if (elevator.source !== 'manual_historical_baseline' || !['historical_estimate', 'unavailable'].includes(elevator.status)
    || elevator.calibrated !== false || !integer(elevator.day_count)
    || (elevator.wait_seconds !== null && !waitSeconds(elevator.wait_seconds))) invalid();
  if (elevator.range_seconds !== null && (!object(elevator.range_seconds) || !waitSeconds(elevator.range_seconds.lower)
    || !waitSeconds(elevator.range_seconds.upper) || elevator.range_seconds.lower > elevator.range_seconds.upper)) invalid();
  if (elevator.status === 'historical_estimate' && (elevator.wait_seconds === null || elevator.range_seconds === null || !elevator.day_count
    || elevator.wait_seconds < elevator.range_seconds.lower || elevator.wait_seconds > elevator.range_seconds.upper)) invalid();
  if (elevator.status === 'unavailable' && (elevator.wait_seconds !== null || elevator.range_seconds !== null)) invalid();
  return value;
}

function validateRecord(record, source, placeId) {
  if (!record || record.source !== source || !timestamp(record.observed_at) || !timestamp(record.valid_until)
    || Date.parse(record.valid_until) <= Date.parse(record.observed_at)) invalid();
  if (source === 'sensor') {
    if (record.dataset !== 'field' || typeof record.node_id !== 'string' || typeof record.boot_id !== 'string' || !integer(record.seq)
      || !integer(record.visible_identifiers) || !integer(record.reports_aggregated)
      || !integer(record.duration_ms) || !integer(record.scan_enabled_ms)
      || !integer(record.uncertainty_ms) || !integer(record.aggregation_drops) || typeof record.unique_table_overflow !== 'boolean'
      || !Array.isArray(record.quality_flags) || record.quality_flags.some(flag => typeof flag !== 'string')) invalid();
  } else {
    if (record.place_id !== placeId || record.status !== 'active' || typeof record.id !== 'string'
      || (record.dataset !== undefined && record.dataset !== 'field')) invalid();
    if (record.kind === 'parking') {
      if (!integer(record.parking_min) || !integer(record.parking_max) || record.parking_min > record.parking_max) invalid();
    } else if (record.kind !== 'elevator' || !integer(record.wait_seconds)) invalid();
  }
  return record;
}

export function recordFreshness(record, now = Date.now()) {
  if (!record) return 'no_data';
  if (isLastReportedSensor(record)) return 'unverified';
  // Expiry belongs to each source: the summary's combined freshness can be
  // fresh because of a different source. Never trust it for an individual card.
  return timestamp(record.valid_until) && timestamp(record.observed_at)
    && Date.parse(record.observed_at) <= now && Date.parse(record.valid_until) > now ? 'fresh' : 'stale';
}

/** The legacy singleton can only supply its own kind, never the other card. */
export function latestManualObservations(summary) {
  if (summary?.latest_observations) return { parking: null, elevator: null, ...summary.latest_observations };
  const latest = summary?.latest_observation;
  return { parking: latest?.kind === 'parking' ? latest : null, elevator: latest?.kind === 'elevator' ? latest : null };
}

export function normalizeFieldResponse(body, { placeId, mode }) {
  if (!body || typeof body !== 'object') invalid();
  if (mode === 'replay') {
    if (body.place_id !== placeId || !Array.isArray(body.observations) || !Array.isArray(body.sensor_windows)
      || !timestamp(body.from) || !timestamp(body.to) || Date.parse(body.from) > Date.parse(body.to)
      || typeof body.truncated !== 'boolean' || typeof body.sensor_truncated !== 'boolean') invalid();
    const records = [
      ...body.sensor_windows.map(record => validateRecord(record, 'sensor', placeId)),
      ...body.observations.map(record => validateRecord(record, 'manual', placeId)),
    ].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) || fieldRecordKey(a).localeCompare(fieldRecordKey(b)));
    if (records.some(record => Date.parse(record.observed_at) < Date.parse(body.from) || Date.parse(record.observed_at) > Date.parse(body.to))) invalid();
    return { ...body, records };
  }
  if (body.place?.id !== placeId || !timestamp(body.as_of) || !('sensor' in body) || !('latest_observation' in body)) invalid();
  if (body.sensor !== null) validateRecord(body.sensor, 'sensor', placeId);
  if ('last_reported_sensor' in body && body.last_reported_sensor !== null && !isLastReportedSensor(body.last_reported_sensor)) invalid();
  if (body.latest_observation !== null) validateRecord(body.latest_observation, 'manual', placeId);
  if ('latest_observations' in body) {
    const latest = body.latest_observations;
    if (!latest || typeof latest !== 'object' || Array.isArray(latest)
      || Object.keys(latest).some(kind => kind !== 'parking' && kind !== 'elevator')) invalid();
    for (const kind of ['parking', 'elevator']) {
      if (!(kind in latest)) invalid();
      if (latest[kind] !== null) {
        validateRecord(latest[kind], 'manual', placeId);
        if (latest[kind].kind !== kind) invalid();
      }
    }
  }
  return { ...body, latest_observations: latestManualObservations(body),
    ...(body.automatic_observations !== undefined ? { automatic_observations: normalizeAutomaticObservations(body.automatic_observations) } : {}) };
}

export function fieldRecordKey(record) {
  return record.source === 'sensor' ? `sensor:${record.node_id}:${record.boot_id}:${record.seq}` : `manual:${record.id}`;
}

export function fieldReadPath(placeId, mode, minutes = 1440) {
  if (!placeId || (mode !== 'live' && mode !== 'replay')) throw new Error('请选择现场地点和读取模式');
  if (mode === 'replay' && !ranges.includes(minutes)) throw new Error('无效的历史时间范围');
  const root = `/api/v1/places/${encodeURIComponent(placeId)}`;
  return mode === 'replay' ? `${root}/history?minutes=${minutes}` : `${root}/summary`;
}

// A scope owns one in-flight read. Abort alone is insufficient: a mocked or
// already completed transport may still resolve, so guard every publication.
export function createFieldReader(onState, fetcher = (...args) => fetch(...args)) {
  let active = null;
  let generation = 0;
  return {
    async read(options) {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const requestId = ++generation;
      const current = () => requestId === generation && !controller.signal.aborted;
      onState({ loading: true, data: null, error: '' });
      try {
        const response = await fetcher(fieldReadPath(options.placeId, options.mode, options.minutes), { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`现场读取失败（${response.status}）`);
        const data = normalizeFieldResponse(await response.json(), options);
        if (current()) onState({ loading: false, data, error: '' });
      } catch (problem) {
        if (current()) onState({ loading: false, data: null, error: problem instanceof Error ? problem.message : '现场读取失败' });
      }
    },
    cancel() { generation += 1; active?.abort(); active = null; },
  };
}
