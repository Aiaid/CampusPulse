import { describe, expect, it } from 'vitest';
import { freezeDeviceConfigV3, negotiateDeviceConfigV3 } from '../worker/device-v3-config';
import { supportsV3StatisticsPolicy, V3_VEHICLE_CANDIDATE_RULESET } from '../worker/device-v3-statistics-policy';
import { validateStatisticsV3Event, validateStatisticsV3Window } from '../worker/device-v3-statistics-validation';
import { statisticsCapabilities, statisticsPolicy } from './helpers/v3-statistics-policy-fixtures';
import { statisticsEventFixture, statisticsLimitsFixture, statisticsWindowFixture } from './helpers/v3-small-statistics-fixtures';

describe('compiled conservative vehicle candidate statistics rules', () => {
  it('requires an explicit new policy and actual advertised capability', async () => {
    const caps = statisticsCapabilities(), policy = await statisticsPolicy(caps);
    expect(supportsV3StatisticsPolicy(policy)).toBe(true);
    if (policy.evidence.mode !== 'statistics') throw Error('fixture');
    policy.evidence.ruleset_version = V3_VEHICLE_CANDIDATE_RULESET;
    expect(supportsV3StatisticsPolicy(policy)).toBe(true);
    const context = { node_id: caps.node_id, boot_id: caps.boot_id, now: new Date().toISOString(), last_assignment_generation: 0,
      closed_window_seq: 3, closed_segment_seq: 2, window_open: false, segment_open: false };
    const unsupported = await negotiateDeviceConfigV3(await freezeDeviceConfigV3(policy), caps, context);
    expect(unsupported.issues).toContainEqual({ code: 'unsupported_capability', path: 'evidence.ruleset_version' });
    caps.statistics!.ruleset_versions.push(V3_VEHICLE_CANDIDATE_RULESET);
    // Changing capabilities changes the signed digest and requires a new policy.
    const capablePolicy = await statisticsPolicy(caps);
    if (capablePolicy.evidence.mode !== 'statistics') throw Error('fixture');
    capablePolicy.evidence.ruleset_version = V3_VEHICLE_CANDIDATE_RULESET;
    expect((await negotiateDeviceConfigV3(await freezeDeviceConfigV3(capablePolicy), caps, context)).state).toBe('compatible');
    capablePolicy.evidence.ruleset_version = 'unreviewed/1'; expect(supportsV3StatisticsPolicy(capablePolicy)).toBe(false);
    capablePolicy.evidence.ruleset_version = V3_VEHICLE_CANDIDATE_RULESET;
    capablePolicy.evidence.extractor_version = 'other/1'; expect(supportsV3StatisticsPolicy(capablePolicy)).toBe(false);
  });
  it('accepts candidate and conflict partitions only for the new exact version pair', () => {
    const limits = { ...statisticsLimitsFixture(), ruleset_version: V3_VEHICLE_CANDIDATE_RULESET };
    const w = statisticsWindowFixture().x[0]; w.v[1] = V3_VEHICLE_CANDIDATE_RULESET;
    w.c = [0, 1, 1, 0, 0, 0];
    expect(validateStatisticsV3Window(w, limits)).toMatchObject({ visible_identifiers: 2, estimated_total: null,
      categories: { phone_candidate: 0, e_bike_candidate: 1, car_candidate: 1, other: 0, unknown: 0, conflicting: 0 } });
    w.c = [0, 0, 0, 0, 1, 1];
    expect(validateStatisticsV3Window(w, limits).categories.conflicting).toBe(1);
    for (const forbidden of [[1, 0, 0, 0, 1, 0], [0, 0, 0, 1, 1, 0]]) {
      w.c = forbidden; expect(() => validateStatisticsV3Window(w, limits)).toThrow();
    }
    w.c = [0, 1, 1, 0, 0, 0];
    expect(() => validateStatisticsV3Window(w, statisticsLimitsFixture())).toThrow();
    w.v[1] = 'unclassified-v1';
    expect(() => validateStatisticsV3Window(w, statisticsLimitsFixture())).toThrow();
    w.c = [0, 0, 0, 0, 2, 0]; expect(validateStatisticsV3Window(w, statisticsLimitsFixture()).categories.unknown).toBe(2);
    w.v[1] = 'unreviewed/1';
    expect(() => validateStatisticsV3Window(w, { ...limits, ruleset_version: 'unreviewed/1' })).toThrow();
    w.v = ['other/1', V3_VEHICLE_CANDIDATE_RULESET];
    expect(() => validateStatisticsV3Window(w, { ...limits, extractor_version: 'other/1' })).toThrow();
  });
  it('keeps visibility-event version identity explicit without changing event meaning', () => {
    const event = statisticsEventFixture().x[0], limits = { ...statisticsLimitsFixture(), ruleset_version: V3_VEHICLE_CANDIDATE_RULESET };
    event.x[1] = V3_VEHICLE_CANDIDATE_RULESET;
    expect(validateStatisticsV3Event(event, limits)).toMatchObject({ kind: 'visibility_segment', versions: { ruleset_version: V3_VEHICLE_CANDIDATE_RULESET } });
    expect(() => validateStatisticsV3Event(event, statisticsLimitsFixture())).toThrow();
  });
});
