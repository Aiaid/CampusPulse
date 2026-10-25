import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

expect.configure({ timeout: 15000 });

// Local, read-only UI-contract acceptance. All observations and tiles below
// are fixtures; these checks establish no radio or physical-device acceptance.
const origin = process.env.FIELD_DATA_URL || 'http://127.0.0.1:5186';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], writes = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const now = Date.now(), iso = offset => new Date(now + offset).toISOString();
const places = [
  { id: 'library', name: '图书馆测试点', kind: 'activity', gis_anchor: { x: 15656 / 24576, y: 9059 / 24576, verified: true } },
  { id: 'parking', name: '待定位停车点', kind: 'parking' },
];
const sensor = { source: 'sensor', dataset: 'field', node_id: 'fixture-node', boot_id: 'fixture-boot', seq: 1, observed_at: iso(-5000), valid_until: iso(85000), visible_identifiers: 12, reports_aggregated: 80, duration_ms: 10000, scan_enabled_ms: 9000, uncertainty_ms: 200, aggregation_drops: 2, quality_flags: ['aggregation_drops'], unique_table_overflow: false, freshness: 'fresh' };
const manual = id => ({ source: 'manual', id: 'fixture-manual', place_id: id, status: 'active', kind: 'parking', parking_min: 3, parking_max: 5, observed_at: iso(-600000), valid_until: iso(-1000) });
let unavailable = false, empty = false;
await page.route('https://gis.ccnu.edu.cn/mapdata/**', route => route.fulfill({ contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce6da"/></svg>' }));
await page.route('**/api/v1/**', route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  if (request.method() !== 'GET') writes.push(request.method());
  if (path.endsWith('/settings')) return route.fulfill({ json: { site_name: 'CampusPulse', default_mode: 'demo' } });
  if (path === '/api/v1/places') return route.fulfill({ json: { places } });
  if (unavailable) return route.fulfill({ status: 503, json: { error: 'fixture' } });
  const id = path.split('/')[4];
  if (path.endsWith('/summary')) return route.fulfill({ json: { place: places.find(place => place.id === id), as_of: iso(0), freshness: 'fresh', sensor: empty ? null : sensor, latest_observation: empty ? null : manual(id) } });
  if (path.endsWith('/history')) return route.fulfill({ json: { place_id: id, from: iso(-Number(url.searchParams.get('minutes') || 60) * 60000), to: iso(0), observations: empty ? [] : [manual(id)], sensor_windows: empty ? [] : [sensor, { ...sensor, seq: 2, observed_at: iso(-120000), visible_identifiers: 7 }], truncated: false, sensor_truncated: !empty } });
  return route.fulfill({ status: 404, json: {} });
});
try {
  await page.goto(`${origin}/?mode=field`);
  await expect(page.getByRole('button', { name: '现场观察', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('region', { name: '现场实时数据' });
  await expect(panel).toContainText('12 个 BLE 可见标识');
  await expect(panel).toContainText('有效观察');
  await expect(panel).toContainText('已过期');
  await expect(panel).toContainText('聚合丢失');
  const dataBounds = await panel.boundingBox(), footerBounds = await page.locator('.detail-footer').boundingBox();
  assert.ok(dataBounds.y + dataBounds.height <= footerBounds.y + 1, 'record cards do not overlap the detail action');
  await expect(page.locator('.metric-list')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: '模拟回放时间' })).toHaveCount(0);
  if (process.env.FIELD_DATA_SCREENSHOTS) await page.screenshot({ path: '/tmp/campuspulse-field-desktop.png' });
  checks.push('explicit field URL wins demo default; sensor/manual expiry stays independent');
  await page.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('parking');
  await expect(panel).toContainText('待定位停车点');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('待定位停车点');
  checks.push('unlocated real places remain readable without invented map anchors');
  const axis = page.getByRole('slider', { name: '现场数据时间轴', exact: true });
  await expect(axis).toBeVisible();
  await axis.fill(String(now - 120000));
  const replay = page.getByRole('region', { name: '现场历史回放' });
  await expect(page.locator('.bottom-dock')).toContainText('截断');
  await expect(replay).toContainText('历史记录');
  await expect(replay).toContainText('7 个 BLE 可见标识');
  const pinned = await axis.inputValue();
  await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect(replay).toContainText('7 个 BLE 可见标识');
  assert.equal(await axis.inputValue(), pinned, 'network refresh preserves historical cursor');
  await axis.fill(String(now - 900000));
  await expect(replay).toContainText('该时刻没有已载入的观测记录');
  await expect(replay.locator('.field-data-record')).toHaveCount(0);
  await page.getByRole('button', { name: '返回实时', exact: true }).click();
  await expect(panel).toContainText('12 个 BLE 可见标识');
  await axis.fill(String(now - 120000));
  await expect(replay).toContainText('7 个 BLE 可见标识');
  checks.push('one axis scrubs actual windows, preserves pinned time through refresh, shows gaps and returns live');
  await page.setViewportSize({ width: 390, height: 844 });
  const detailBounds = await page.locator('.detail-panel').boundingBox();
  const sceneBounds = await page.locator('.scene-controls-bar').boundingBox();
  assert.ok(detailBounds.y >= sceneBounds.y + sceneBounds.height, 'phone detail title clears scene controls');
  const warningBounds = await page.locator('.field-timeline-warning').boundingBox();
  const layersBounds = await page.locator('.dock-bottom').boundingBox();
  assert.ok(warningBounds.y + warningBounds.height <= layersBounds.y + 1, 'truncation warning stays above phone layer controls');
  if (process.env.FIELD_DATA_SCREENSHOTS) await page.screenshot({ path: '/tmp/campuspulse-replay-phone.png' });
  await page.getByRole('combobox', { name: '现场时间范围', exact: true }).selectOption('15');
  await expect(page.getByRole('button', { name: '返回实时', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => axis.getAttribute('min')).toBe(String(now - 900000));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await axis.fill(String(now - 120000));
  await expect(replay).toContainText('7 个 BLE 可见标识');
  checks.push('phone truncation stays legible; zoom reloads its range and resumes live');
  unavailable = true;
  await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect(replay).toContainText('现场数据不可用');
  await expect(replay.locator('.field-data-record')).toHaveCount(0);
  unavailable = false; empty = true;
  await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect(replay).toContainText('所选时段没有保留的现场记录');
  checks.push('service errors and empty history never show synthetic fallback');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['现场观察', '模拟演示']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${name} fits phone width`);
  }
  await expect(axis).toBeVisible();
  const axisBounds = await axis.boundingBox();
  assert.ok(axisBounds.x >= 0 && axisBounds.x + axisBounds.width <= 390, 'timeline fits phone width');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.FIELD_DATA_SCREENSHOTS) await page.screenshot({ path: '/tmp/campuspulse-replay-empty-phone.png' });
  await page.getByRole('button', { name: '模拟演示', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '模拟场景', exact: true })).toBeVisible();
  await expect(page.locator('.metric-list')).toBeVisible();
  await expect(page.getByRole('region', { name: '现场历史回放' })).toHaveCount(0);
  checks.push('390px source controls fit; simulation stays separate and available');
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, writes: writes.length, pageErrors: errors.length }, null, 2));
} finally { await browser.close(); }
