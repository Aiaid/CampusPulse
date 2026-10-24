import { describe, expect, test } from 'vitest';
import { getMetrics, places, simulationScenarios, simulationTimes } from '../../src/campus/scene-data.js';

const trends = ['up', 'down', 'flat'];
const expectedTrend = difference => difference > 1 ? 'up' : difference < -1 ? 'down' : 'flat';
const average = (id, scenario, field, from = 420, to = 1320) => {
  const samples = [];
  for (let minute = from; minute <= to; minute += 15) samples.push(getMetrics(id, minute, scenario)[field]);
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
};

describe('authored frontend simulation data', () => {
  test('exposes three explicit scenarios and ordered full-day history presets', () => {
    expect(simulationScenarios.map(item => item.id)).toEqual(['weekday', 'weekend', 'rainy']);
    for (const item of simulationScenarios) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description).toContain('合成示意');
      expect(simulationTimes).toContain(item.minute);
    }
    expect(simulationTimes[0]).toBe(420);
    expect(simulationTimes.at(-1)).toBe(1320);
    expect(simulationTimes).toEqual([...new Set(simulationTimes)].sort((a, b) => a - b));
  });

  test('keeps every place and scenario deterministic, finite, bounded and smooth all day', () => {
    for (const place of places) for (const { id } of simulationScenarios) {
      let previous;
      for (let minute = 420; minute <= 1320; minute++) {
        const sample = getMetrics(place.id, minute, id);
        expect(sample).toEqual(getMetrics(place.id, minute, id));
        for (const field of ['people', 'bikes', 'parking']) {
          expect(Number.isFinite(sample[field])).toBe(true);
          expect(sample[field]).toBeGreaterThanOrEqual(0);
          expect(sample[field]).toBeLessThanOrEqual(100);
          if (previous) expect(Math.abs(sample[field] - previous[field])).toBeLessThanOrEqual(3);
        }
        if (sample.wait !== null) {
          expect(Number.isFinite(sample.wait)).toBe(true);
          expect(sample.wait).toBeGreaterThanOrEqual(1);
          expect(sample.wait).toBeLessThanOrEqual(9);
        }
        expect(trends).toContain(sample.peopleTrend);
        expect(trends).toContain(sample.bikesTrend);
        previous = sample;
      }
    }
  });

  test('shows class, meal and evening peaks instead of one shared daily curve', () => {
    for (const id of ['teaching-8', 'literature', 'tianjiabing', 'teaching-9']) {
      expect(getMetrics(id, 600).people).toBeGreaterThan(getMetrics(id, 780).people + 25);
      expect(getMetrics(id, 900).people).toBeGreaterThan(getMetrics(id, 1260).people + 25);
    }
    expect(getMetrics('boya', 720).people).toBeGreaterThan(getMetrics('boya', 900).people + 50);
    expect(getMetrics('boya', 1080).people).toBeGreaterThan(getMetrics('boya', 900).people + 50);
    for (const id of ['library', 'gym']) {
      expect(getMetrics(id, 1200).people).toBeGreaterThan(getMetrics(id, 480).people + 35);
    }
    const signatures = places.map(place => simulationTimes.map(time => getMetrics(place.id, time).people).join(','));
    expect(new Set(signatures).size).toBe(places.length);
  });

  test('weekends reduce teaching and increase afternoon recreation', () => {
    for (const id of ['teaching-8', 'literature', 'tianjiabing', 'teaching-9']) {
      expect(average(id, 'weekend', 'people')).toBeLessThan(average(id, 'weekday', 'people') * .6);
    }
    for (const id of ['gym', 'yundaiying']) {
      expect(average(id, 'weekend', 'people', 840, 1080)).toBeGreaterThan(average(id, 'weekday', 'people', 840, 1080) + 15);
    }
  });

  test('rain consistently reduces cycling and raises modeled waits while preserving nullable waits', () => {
    const noWait = new Set(['boya', 'yundaiying', 'gym']);
    for (const place of places) for (const minute of simulationTimes) {
      const weekday = getMetrics(place.id, minute, 'weekday');
      const rainy = getMetrics(place.id, minute, 'rainy');
      expect(rainy.bikes).toBeLessThanOrEqual(weekday.bikes);
      if (!noWait.has(place.id)) expect(rainy.wait).toBeGreaterThan(weekday.wait);
      for (const { id } of simulationScenarios) {
        expect(getMetrics(place.id, minute, id).wait === null).toBe(noWait.has(place.id));
      }
    }
  });

  test('trends match the same scenario exactly fifteen minutes earlier', () => {
    for (const place of places) for (const { id } of simulationScenarios) for (const minute of simulationTimes) {
      const current = getMetrics(place.id, minute, id);
      const previous = getMetrics(place.id, minute - 15, id);
      expect(current.peopleTrend).toBe(expectedTrend(current.people - previous.people));
      expect(current.bikesTrend).toBe(expectedTrend(current.bikes - previous.bikes));
    }
  });

  test('normalizes invalid times, clamps day bounds and defaults unknown scenarios safely', () => {
    for (const place of places) {
      for (const minute of [NaN, Infinity, -Infinity, null, '600']) {
        expect(getMetrics(place.id, minute)).toEqual(getMetrics(place.id, 1200));
      }
      expect(getMetrics(place.id, -100)).toEqual(getMetrics(place.id, 420));
      expect(getMetrics(place.id, 2000)).toEqual(getMetrics(place.id, 1320));
      expect(getMetrics(place.id, 720, 'unknown')).toEqual(getMetrics(place.id, 720, 'weekday'));
      expect(getMetrics(place.id)).toEqual(getMetrics(place.id, 1200, 'weekday'));
    }
  });

  test('keeps unknown places unknown and distinguishes parking dwell from passing bike flow', () => {
    for (const place of [undefined, null, '', 'missing', 'constructor', 'toString']) {
      expect(getMetrics(place, 720, 'rainy')).toEqual({ people: null, bikes: null, parking: null,
        wait: null, peopleTrend: 'flat', bikesTrend: 'flat' });
    }
    const lunch = getMetrics('boya', 720);
    const afterLunch = getMetrics('boya', 780);
    expect(afterLunch.bikes).toBeLessThan(lunch.bikes);
    expect(afterLunch.parking).toBeGreaterThan(afterLunch.bikes);
  });
});
