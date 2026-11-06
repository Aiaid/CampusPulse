// Isolated synthetic fixture acceptance. No production, screenshots or write APIs.
// Build the current frontend first; ephemeral workerd serves that exact dist.
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
  const now = Date.now(), iso = offset => new Date(now + offset).toISOString();
  const place = { id: 'library', name: '图书馆', kind: 'activity', observation_kinds: ['activity', 'parking'], gis_anchor: { x: 15656 / 24576, y: 9059 / 24576, verified: true } };
  const sensor = { source: 'sensor', dataset: 'field', node_id: 'synthetic-node', boot_id: 'synthetic-boot', placement_id: 'synthetic-placement', protocol: 'campuspulse/3', assignment_generation: 1, policy_id: 'synthetic-config', seq: 1,
    observed_at: iso(-1000), valid_until: iso(89000), duration_ms: 30000, scan_enabled_ms: 30000, visible_identifiers: 16,
    reports_aggregated: 100, uncertainty_ms: 0, aggregation_drops: 0, quality_flags: [], unique_table_overflow: false };
  let scenario = 'known';
  const currentPlace = () => scenario === 'unmapped' ? { ...place, id: 'unmapped-near-library', name: '未注册路线观察点' } : place;
  const currentSensor = () => ['reported', 'empty', 'retained'].includes(scenario) ? null : {
    ...sensor,
    ...(scenario === 'busy' ? { visible_identifiers: 120 } : {}),
    ...(scenario === 'zero' ? { visible_identifiers: 0 } : {}),
    ...(scenario === 'expired' ? { valid_until: iso(-1) } : {}),
    ...(scenario === 'loss' ? { scan_enabled_ms: 29000, quality_flags: ['scan_gap'] } : {}),
  };
  const manualParking = { id: 'manual-parking', place_id: place.id, source: 'manual', status: 'active', kind: 'parking',
    parking_min: 4, parking_max: 8, observed_at: iso(-1000), valid_until: iso(89000) };
  const candidateObservations = {
    vehicles: { status: 'candidate_estimate', source: 'ble_rule_inference', model_version: 'fixture-candidates/1',
      observed_at: iso(-1000), valid_until: iso(89000), candidate_count: 2, car_related_count: 0, ecosystem_count: 0,
      sample_count: 8, reason: null, quality_flags: [], evidence_kind: 'compact' },
    elevator: { status: 'unavailable', source: 'manual_historical_baseline', model_version: 'fixture-elevator/1',
      observed_at: null, valid_until: null, wait_seconds: null, range_seconds: null, sample_count: 0, day_count: 0,
      reason: 'no_manual_samples', calibrated: false },
  };
  const requests = [], errors = [];
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/api/v1/')) return route.continue();
    requests.push(request.method());
    if (url.pathname.endsWith('/settings')) return route.fulfill({ json: { site_name: 'CampusPulse', default_mode: 'field' } });
    if (url.pathname === '/api/v1/places') return route.fulfill({ json: { places: [currentPlace()] } });
    if (url.pathname.endsWith('/summary') && scenario === 'failed') return route.fulfill({ status: 503, json: {} });
    if (url.pathname.endsWith('/summary')) return route.fulfill({ json: { place: currentPlace(), as_of: iso(0), sensor: currentSensor(),
      last_reported_sensor: scenario === 'reported' ? { ...sensor, visible_identifiers: 9, received_at: iso(-1000), observed_at: null, valid_until: null, uncertainty_ms: null, time_status: 'unknown', freshness: 'unverified' } : null,
      ...(['candidate', 'candidate-with-manual'].includes(scenario) ? { automatic_observations: candidateObservations } : {}),
      latest_observation: null, latest_observations: { parking: scenario === 'candidate-with-manual' ? manualParking : null, elevator: null } } });
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { place_id: currentPlace().id, from: iso(-3600000), to: iso(0), truncated: false, sensor_truncated: false, sensor_windows: [], observations: [] } });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.name));
  const detail = page.locator('.detail-scene .cp-activity-layer');
  const allLayers = page.locator('.cp-activity-layer');
  const nontransparent = () => detail.evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++;
    return count;
  });
  const populated = async () => {
    await expect.poll(() => detail.getAttribute('data-actor-count')).toMatch(/^[1-9]\d*$/);
    await expect.poll(nontransparent).toBeGreaterThan(0);
    await expect(detail).toHaveAttribute('data-motion', 'running');
    const pose = await detail.getAttribute('data-pose-signature');
    assert.ok(pose, 'Moving original-route actors expose their current pose');
    await expect.poll(() => detail.getAttribute('data-pose-signature')).not.toBe(pose);
    await expect(page.locator('.field-illustration')).toHaveCount(0);
  };
  const empty = async () => {
    await expect.poll(() => allLayers.evaluateAll(layers => layers.map(layer => layer.dataset.actorCount)),
      { message: `No actors for ${scenario}`, timeout: 15000 }).toEqual(['0', '0']);
    await expect.poll(nontransparent).toBe(0);
  };
  const scopedPeopleOnly = async () => {
    await expect.poll(() => allLayers.evaluateAll(layers => layers.length > 0 && layers.every(layer =>
      layer.dataset.actorPlaceIds === 'library' && layer.dataset.ridingCount === '0' && layer.dataset.parkedCount === '0')))
      .toBe(true);
  };
  await page.goto(`${base}/?mode=field&place=library`);
  await populated();
  await scopedPeopleOnly();
  const initialCount = Number(await detail.getAttribute('data-actor-count'));
  await expect(detail).toHaveAttribute('data-scenario', 'field');
  await expect(page.locator('.field-data-panel')).toContainText('16 个 BLE 可见标识');
  await expect(page.getByRole('button', { name: '现场观察', exact: true })).toHaveAttribute('aria-pressed', 'true');
  scenario = 'reported'; await page.reload();
  await empty();
  await expect(page.locator('[data-source="last-reported-sensor"]')).toContainText('9 个 BLE 可见标识');
  await expect(page.locator('[data-source="last-reported-sensor"]')).toContainText('时间未知 · 上传');
  await expect(page.locator('[data-source="last-reported-sensor"]')).not.toContainText('有效观察');
  for (const missing of ['zero', 'expired', 'loss', 'unmapped']) {
    scenario = missing; await page.reload();
    await empty();
  }
  // Retention is created by a real client read transition, not a backend flag.
  scenario = 'known'; await page.reload(); await populated();
  scenario = 'retained'; await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await empty();
  await expect(page.locator('.field-data-panel')).toContainText('16 个 BLE 可见标识');
  await expect(page.locator('.field-data-panel')).toContainText('最后观测');
  scenario = 'failed'; await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await empty();
  await expect(page.getByRole('alert')).toContainText('更新失败');
  for (const supported of ['candidate', 'candidate-with-manual']) {
    scenario = supported; await page.reload();
    await populated();
    await expect.poll(() => allLayers.evaluateAll(layers => layers.length > 0 && layers.every(layer =>
      layer.dataset.actorPlaceIds === 'library' && layer.dataset.ridingCount === '2' && layer.dataset.parkedCount === '0')))
      .toBe(true);
  }
  scenario = 'known'; await page.reload();
  await populated(); await scopedPeopleOnly();
  scenario = 'busy'; await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect(page.locator('.field-data-panel')).toContainText('120 个 BLE 可见标识');
  await expect.poll(async () => Number(await detail.getAttribute('data-actor-count'))).toBeGreaterThan(initialCount);
  await scopedPeopleOnly();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Overflow is clipped before ResizeObserver/React and the next draw update
  // the canvas. Wait for its actual CSS and backing sizes, not old opaque pixels.
  await expect.poll(() => detail.evaluate(canvas => {
    const box = canvas.getBoundingClientRect(), map = canvas.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return {
      fitsViewport: box.x >= 0 && box.right <= innerWidth + 1,
      matchesMap: box.width === map.clientWidth && box.height === map.clientHeight,
      bitmapMatchesMap: canvas.width === Math.max(1, Math.round(map.clientWidth * dpr))
        && canvas.height === Math.max(1, Math.round(map.clientHeight * dpr)),
      canvas: { x: box.x, width: box.width, height: box.height, bitmapWidth: canvas.width, bitmapHeight: canvas.height },
      map: { width: map.clientWidth, height: map.clientHeight },
    };
  }), { message: 'Original actor canvas resizes and redraws within the 390px layout' })
    .toMatchObject({ fitsViewport: true, matchesMap: true, bitmapMatchesMap: true });
  await expect.poll(nontransparent).toBeGreaterThan(0);
  const box = await detail.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 391, 'Original actor canvas fits the 390px layout');
  const axis = page.getByRole('slider', { name: '现场数据时间轴', exact: true });
  await axis.fill(String(now - 120000));
  await empty();
  await expect(page.locator('.field-data-panel')).not.toContainText('120 个 BLE 可见标识');
  await page.getByRole('button', { name: '返回实时', exact: true }).click();
  await populated();
  scenario = 'empty'; await page.reload();
  await empty();
  await expect(page.locator('.field-data-panel')).toContainText('暂无可展示的传感器窗口');
  await page.getByRole('button', { name: '模拟演示', exact: true }).click();
  await expect.poll(() => detail.getAttribute('data-actor-count')).toMatch(/^[1-9]\d*$/);
  await expect(detail).not.toHaveAttribute('data-scenario', 'field');
  await expect(page.locator('.field-data-panel')).toHaveCount(0);
  await expect(page.locator('.field-illustration')).toHaveCount(0);
  assert.ok(requests.every(method => method === 'GET'));
  assert.deepEqual(errors, []);
  console.log('Field scene fixture acceptance passed: exact uploaded-place scope, people-only BLE input, no demo vehicles, zero/missing/expired/unverified/loss/retained/unmapped suppression, live density refresh, replay gaps, unchanged demo animation and 390px layout. Synthetic fixtures only.');
} finally { await browser?.close(); await mf.dispose(); }
