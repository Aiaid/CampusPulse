import { isLastReportedSensor, latestManualObservations } from './field-data.js';
import { observationKinds } from '../shared/observation-kinds.js';

const observed = (record, now) => record && Number.isFinite(Date.parse(record.observed_at))
  && Date.parse(record.observed_at) <= now && Number.isFinite(Date.parse(record.valid_until))
  && Date.parse(record.valid_until) > Date.parse(record.observed_at);
const available = (record, now) => observed(record, now) && record.status !== 'unavailable';
const withdrawnPurpose = new Set(['purpose_not_enabled', 'unsupported_place_purpose']);
const withdrawnReference = new Set(['no_manual_samples', 'no_comparable_samples', 'insufficient_samples',
  'insufficient_days', 'input_limit_exceeded']);

/** Keep read-only last observations in this page session, scoped to one place.
 * Their original evidence time/expiry never changes. Successful manual nulls
 * remain authoritative so cancellation/correction cannot resurrect a report.
 */
export function retainLastFieldSummary(next, previous, now = Date.now()) {
  if (!next) return null;
  const samePlace = previous?.place?.id && previous.place.id === next.place?.id;
  const prior = samePlace ? previous : null;
  const last_known = {};
  const choose = (record, old, key, eligible = observed) => {
    if (eligible(record, now) && (!eligible(old, now)
      || Date.parse(record.observed_at) >= Date.parse(old.observed_at))) return record;
    if (eligible(old, now)) {
      last_known[key] = record && eligible(record, now) ? 'older_response' : 'source_unavailable';
      return old;
    }
    return record;
  };
  const candidateSensor = choose(next.sensor, prior?.sensor, 'sensor');
  const sensor = observed(candidateSensor, now) ? candidateSensor : null;
  const result = { ...next, sensor, latest_observations: latestManualObservations(next), last_known };
  const reported = next.last_reported_sensor, oldReported = prior?.last_reported_sensor;
  const eligibleReport = record => isLastReportedSensor(record) && Date.parse(record.received_at) <= now;
  if (eligibleReport(reported) && (!eligibleReport(oldReported)
    || Date.parse(reported.received_at) >= Date.parse(oldReported.received_at))) result.last_reported_sensor = reported;
  else if (!next.sensor && eligibleReport(oldReported)) {
    result.last_reported_sensor = oldReported;
    last_known.last_reported_sensor = eligibleReport(reported) ? 'older_response' : 'source_unavailable';
  } else if ('last_reported_sensor' in next) result.last_reported_sensor = null;
  if (next.automatic_observations) {
    const kinds = observationKinds(next.place);
    const automatic = { ...next.automatic_observations };
    for (const [kind, purpose, key] of [['vehicles', 'parking', 'vehicles'], ['elevator', 'elevator', 'elevator_reference']]) {
      const current = automatic[kind];
      if (kinds.includes(purpose) && !withdrawnPurpose.has(current.reason)
        && !(kind === 'elevator' && withdrawnReference.has(current.reason))) {
        // A successful historical baseline is an authoritative calculation.
        // Cancelling its newest contributing sample, or changing hour cohort,
        // may correctly move its evidence timestamp backwards.
        automatic[kind] = kind === 'elevator' && available(current, now) ? current
          : choose(current, prior?.automatic_observations?.[kind], key, available);
      }
    }
    result.automatic_observations = automatic;
  }
  return result;
}

export function markLastFieldReadFailed(data) {
  if (!data) return null;
  const last_known = { ...data.last_known };
  if (data.sensor) last_known.sensor = 'read_failed';
  if (data.last_reported_sensor) last_known.last_reported_sensor = 'read_failed';
  for (const [kind, record] of Object.entries(latestManualObservations(data))) if (record) last_known[kind] = 'read_failed';
  for (const [kind, key] of [['vehicles', 'vehicles'], ['elevator', 'elevator_reference']]) {
    if (data.automatic_observations?.[kind]?.status !== 'unavailable'
      && data.automatic_observations?.[kind]) last_known[key] = 'read_failed';
  }
  return { ...data, last_known };
}

/** Read transition used by the live hook. Pending retries cannot turn an
 * unconfirmed cached observation back into a successful/current response.
 */
export function advanceLiveFieldRead(next, previous, placeId, now = Date.now()) {
  let cache = previous?.placeId === placeId ? previous : null;
  let data = next.data, error = next.error;
  if (data) {
    data = retainLastFieldSummary(data, cache?.data, now);
    cache = { placeId, data, error: '' };
  } else if (cache && (next.loading || next.error)) {
    if (next.error) cache = { ...cache, data: markLastFieldReadFailed(cache.data), error: next.error };
    data = cache.data;
    if (next.loading) error = cache.error || '';
  }
  return { cache, read: { ...next, data, error } };
}
