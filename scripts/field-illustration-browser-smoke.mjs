// Local fixture UI acceptance only. No production, hardware, screenshots or
// write APIs. Build frontend first; this script serves dist in ephemeral workerd.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';

assert.ok(existsSync('dist/index.html'), 'Build current frontend first');
expect.configure({ timeout: 15000 });
const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, host: '127.0.0.1', workers: [{ name: 'field-illustration-ui', modules: true,
  script: 'export default { fetch(request, env) { return env.ASSETS.fetch(request); } };', compatibilityDate: '2026-10-23',
  assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: 'single-page-application' } },
}] }));
let browser;
try {
  const base = (await mf.ready).origin;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const now = Date.now(), iso = offset => new Date(now + offset).toISOString();
  const place = { id: 'library', name: '图书馆', kind: 'activity', observation_kinds: ['activity', 'parking', 'elevator'], gis_anchor: { x: 15656 / 24576, y: 9059 / 24576, verified: true } };
  const sensor = { source: 'sensor', dataset: 'field', node_id: 'synthetic-diagram-node', boot_id: 'synthetic-boot', seq: 1,
    observed_at: iso(-1000), valid_until: iso(89000), duration_ms: 30000, scan_enabled_ms: 30000, visible_identifiers: 72,
    reports_aggregated: 100, uncertainty_ms: 0, aggregation_drops: 0, quality_flags: [], unique_table_overflow: false };
  const parking = { id: 'synthetic-parking', place_id: 'library', source: 'manual', status: 'active', kind: 'parking', parking_min: 4, parking_max: 8, observed_at: iso(-1000), valid_until: iso(89000) };
  const elevator = { id: 'synthetic-elevator', place_id: 'library', source: 'manual', status: 'active', kind: 'elevator', wait_seconds: 27, observed_at: iso(-1000), valid_until: iso(89000) };
  const automatic = { vehicles: { status: 'candidate_estimate', source: 'ble_rule_inference', model_version: 'synthetic-rules-v1', observed_at: iso(-1000), valid_until: iso(89000), candidate_count: 3, car_related_count: 1, ecosystem_count: 5, sample_count: 10, reason: null, quality_flags: [], evidence_kind: 'compact' },
    elevator: { status: 'historical_estimate', source: 'manual_historical_baseline', model_version: 'synthetic-history-v1', wait_seconds: 55, range_seconds: { lower: 30, upper: 70 }, sample_count: 5, day_count: 2, observed_at: iso(-2000), valid_until: iso(88000), reason: null, calibrated: false } };
  let scenario = 'fresh';
  const requests = [], errors = [];
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/api/v1/')) return route.continue();
    requests.push(request.method());
    if (url.pathname.endsWith('/settings')) return route.fulfill({ json: { site_name: 'CampusPulse', default_mode: 'field' } });
    if (url.pathname === '/api/v1/places') return route.fulfill({ json: { places: [place] } });
    if (scenario === 'failed') return route.fulfill({ status: 503, json: { error: 'synthetic' } });
    if (url.pathname.endsWith('/summary')) {
      const expired = scenario === 'stale', empty = scenario === 'missing';
      const manualParking = empty ? null : { ...parking, ...(expired ? { valid_until: iso(-1) } : {}) };
      const manualElevator = empty ? null : { ...elevator, ...(expired || scenario === 'baseline' ? { valid_until: iso(-1) } : {}) };
      return route.fulfill({ json: { place, as_of: iso(0), sensor: empty ? null : { ...sensor, ...(expired ? { valid_until: iso(-1) } : {}) }, latest_observation: manualElevator,
        latest_observations: { parking: manualParking, elevator: manualElevator },
        automatic_observations: empty ? { vehicles: { ...automatic.vehicles, status: 'unavailable', candidate_count: null, car_related_count: null, ecosystem_count: null, sample_count: 0, reason: 'vehicle_features_not_reported', evidence_kind: 'none' }, elevator: { ...automatic.elevator, status: 'unavailable', wait_seconds: null, range_seconds: null, sample_count: 0, day_count: 0, observed_at: null, valid_until: null, reason: 'no_manual_samples' } }
          : { vehicles: { ...automatic.vehicles, ...(expired ? { valid_until: iso(-1) } : {}) }, elevator: { ...automatic.elevator, ...(expired ? { valid_until: iso(-1) } : {}) } } } });
    }
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { place_id: place.id, from: iso(-3600000), to: iso(0), truncated: false, sensor_truncated: false,
      sensor_windows: [{ ...sensor, seq: 2, visible_identifiers: 4, observed_at: iso(-60000), valid_until: iso(30000) }],
      observations: [{ ...parking, observed_at: iso(-65000), valid_until: iso(-55000) }, { ...elevator, wait_seconds: 19, observed_at: iso(-65000), valid_until: iso(-55000) }] } });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.name));
  await page.goto(`${base}/?mode=field&place=library`);
  const overview = page.locator('.overview-map .field-illustration'), detail = page.locator('.detail-scene .field-illustration');
  await expect(overview).toHaveAttribute('data-figure-count', '9');
  await expect(detail).toHaveAttribute('data-figure-count', '9');
  await expect(detail).toContainText('广播活动量级示意 2 档');
  await expect(detail.locator('[data-kind="people"]')).toHaveAttribute('data-figure-count', '5');
  await expect(detail.locator('[data-kind="bikes"]')).toHaveAttribute('data-source', 'manual');
  await expect(detail.locator('[data-kind="cars"]')).toHaveAttribute('data-source', 'candidate');
  await expect(detail.locator('[data-kind="elevator"]')).toHaveAttribute('data-source', 'manual');
  await expect(detail).toContainText('已完成候梯 27 秒 · 人工');
  scenario = 'baseline'; await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect(detail.locator('[data-kind="elevator"]')).toHaveAttribute('data-source', 'historical');
  await expect(detail).toContainText('候梯参考约 55 秒 · 历史样本');
  scenario = 'fresh'; await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect(detail).toContainText('已完成候梯 27 秒 · 人工');
  await expect(detail).toContainText('非实际人数或车辆数');
  await expect(detail).toContainText('位置不代表个体定位');
  await expect.poll(() => page.locator('.cp-activity-layer').evaluateAll(items => items.length > 0 && items.every(item => item.dataset.actorCount === '0'))).toBe(true);
  await page.getByRole('button', { name: '行人活动', exact: true }).click();
  await expect(detail.locator('[data-kind="people"]')).toHaveCount(0);
  await expect(detail).toHaveAttribute('data-figure-count', '4');
  await page.getByRole('button', { name: '电动车活动', exact: true }).click();
  await expect(detail).toHaveAttribute('data-figure-count', '0');
  await expect(detail.locator('[data-kind="elevator"]')).toHaveCount(1);
  await page.getByRole('button', { name: '候梯', exact: true }).click();
  await expect(detail).toHaveCount(0);
  await page.getByRole('button', { name: '行人活动', exact: true }).click();
  await page.getByRole('button', { name: '电动车活动', exact: true }).click();
  await page.getByRole('button', { name: '候梯', exact: true }).click();
  await expect(detail).toHaveAttribute('data-figure-count', '9');
  await page.getByRole('button', { name: '场景设置', exact: true }).click();
  const toggle = page.getByRole('button', { name: '活动示意', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await toggle.click();
  await expect(detail).toHaveCount(0); await toggle.click();
  await expect(detail).toHaveAttribute('data-figure-count', '9');
  await page.getByRole('button', { name: '关闭场景设置', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await detail.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const box = await detail.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
  const axis = page.getByRole('slider', { name: '现场数据时间轴', exact: true });
  await axis.fill(String(now - 60000));
  await expect(detail).toHaveAttribute('data-historical', 'true');
  await expect(detail).toHaveAttribute('data-figure-count', '5');
  await expect(detail.locator('[data-kind="cars"]')).toHaveCount(0);
  await expect(detail).toContainText('历史窗口');
  await expect(detail).toContainText('已完成候梯 19 秒 · 人工');
  await expect(detail).not.toContainText('候梯参考约 55 秒');
  await axis.fill(String(now - 120000));
  await expect(detail.locator('.field-illustration-group')).toHaveCount(0);
  await expect(detail).toContainText('所选时刻候梯待观测');
  await page.getByRole('button', { name: '返回实时', exact: true }).click();
  await expect(detail).toHaveAttribute('data-figure-count', '9');
  for (const next of ['stale', 'missing', 'failed']) {
    scenario = next;
    await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
    if (next === 'failed') await expect(page.locator('.field-illustration')).toHaveCount(0);
    else {
      await expect(detail.locator('.field-illustration-group')).toHaveCount(0);
      await expect(detail).toContainText('车辆待观测');
      await expect(detail).toContainText('候梯样本不足 / 待观测');
      await expect(detail).not.toContainText('0 秒');
    }
  }
  scenario = 'fresh'; await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect(detail).toHaveAttribute('data-figure-count', '9');
  await page.getByRole('button', { name: '模拟演示', exact: true }).click();
  await expect(page.locator('.field-illustration')).toHaveCount(0);
  assert.ok(requests.every(method => method === 'GET')); assert.deepEqual(errors, []);
  console.log('Field illustration UI acceptance passed: bounded place diagrams, people/manual/candidate categories, completed elevator/manual versus historical-reference precedence, waiting states, layers/toggle, 390px, replay/gaps, stale/missing/errors and demo isolation. Synthetic fixtures; no physical-count or device validation.');
} finally { await browser?.close(); await mf.dispose(); }
