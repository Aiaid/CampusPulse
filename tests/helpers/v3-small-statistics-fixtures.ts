import {
  statisticsFixtureLimits, statisticsFixtureEnvelope, statisticsWindowFixture, statisticsEventFixture,
  statisticsStatusFixture, statisticsRawStatusFixture, statisticsFixtureBytes, STATISTICS_FIXTURE_UTC_MS,
  statisticsDenseWindowFixture, statisticsMaxWidthWindowFixture, statisticsCensoredEventFixture,
} from '../../scripts/generate-v3-statistics-fixtures.mjs';
import type { StatisticsV3Limits } from '../../worker/device-v3-statistics-validation';

export { statisticsFixtureEnvelope, statisticsWindowFixture, statisticsEventFixture, statisticsStatusFixture, statisticsRawStatusFixture,
  statisticsDenseWindowFixture, statisticsMaxWidthWindowFixture, statisticsCensoredEventFixture, statisticsFixtureBytes, STATISTICS_FIXTURE_UTC_MS };
export const statisticsLimitsFixture = (windowMs = 30000): StatisticsV3Limits => statisticsFixtureLimits(windowMs) as StatisticsV3Limits;
