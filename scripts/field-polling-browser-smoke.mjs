import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

expect.configure({ timeout: 15_000 });
const origin = process.env.FIELD_POLLING_URL || 'http://127.0.0.1:5197';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const now = Date.now(), iso = offset => new Date(now + offset).toISOString();
const counts = { catalog: 0, summary: 0, history: 0 }, errors = [];
const reads = [];
let holdSummary = false, releaseSummary;
const places = [
  { id: 'library', name: '图书馆测试点', kind: 'activity', gis_anchor: { x: 15656 / 24576, y: 9059 / 24576, verified: true } },
  { id: 'parking', name: '未定位停车点', kind: 'parking' },
];
const sensor = { source: 'sensor', dataset: 'field', node_id: 'fixture-node', boot_id: 'fixture-boot', seq: 1, observed_at: iso(-5000), valid_until: iso(85000), visible_identifiers: 12, reports_aggregated: 80, duration_ms: 10000, scan_enabled_ms: 9000, uncertainty_ms: 200, aggregation_drops: 0, quality_flags: [], unique_table_overflow: false };
const observation = (id, age, count) => ({ source: 'manual', id, place_id: 'library', status: 'active', kind: 'parking', parking_min: count, parking_max: count, observed_at: iso(-age), valid_until: iso(60000) });
const observations = [observation('recent', 30_000, 3), observation('older', 600_000, 9)];
page.on('pageerror', error => errors.push(error.message));
await page.clock.install({ time: now });
await page.addInitScript(() => {
  window.__fieldTestVisibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => window.__fieldTestVisibility });
});
await page.route('https://gis.ccnu.edu.cn/mapdata/**', route => route.fulfill({ contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce6da"/></svg>' }));
await page.route('**/api/v1/**', async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  if (route.request().method() === 'POST' && path === '/api/v1/observations') {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { durability: 'committed', observation: { id: body.id } } });
  }
  if (path.endsWith('/settings')) return route.fulfill({ json: { site_name: 'CampusPulse', default_mode: 'field' } });
  reads.push({ path, forced: route.request().headers()['cache-control'] === 'no-cache' });
  if (path === '/api/v1/places') { counts.catalog += 1; return route.fulfill({ json: { places } }); }
  const id = path.split('/')[4];
  if (path.endsWith('/summary')) {
    counts.summary += 1;
    if (holdSummary) await new Promise(resolve => { releaseSummary = resolve; });
    return route.fulfill({ json: { place: places.find(place => place.id === id), as_of: iso(0), sensor, latest_observation: null } });
  }
  if (path.endsWith('/history')) {
    counts.history += 1;
    const minutes = Number(url.searchParams.get('minutes'));
    return route.fulfill({ json: { place_id: id, from: iso(-minutes * 60_000), to: iso(0), observations: observations.filter(record => Date.parse(record.observed_at) >= now - minutes * 60_000).map(record => ({ ...record, place_id: id })), sensor_windows: [sensor], truncated: false, sensor_truncated: false } });
  }
  return route.fulfill({ status: 404, json: {} });
});
const visible = value => page.evaluate(value => {
  window.__fieldTestVisibility = value ? 'visible' : 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  if (value) window.dispatchEvent(new Event('focus'));
}, value);
try {
  await page.goto(`${origin}/?mode=field`);
  await expect(page.getByRole('region', { name: '现场实时数据' })).toContainText('12 个 BLE 可见标识');
  await expect.poll(() => ({ ...counts })).toEqual({ catalog: 1, summary: 1, history: 1 });
  await page.clock.fastForward(30_100);
  await expect.poll(() => counts.summary).toBe(2);
  assert.equal(counts.history, 1, 'history does not run at the live-summary cadence');
  assert.equal(counts.catalog, 1, 'catalog does not run at the live-summary cadence');
  await visible(false);
  const hiddenCounts = { ...counts };
  await page.clock.fastForward(600_000);
  assert.deepEqual(counts, hiddenCounts, 'ten hidden minutes produce no reads');
  await visible(true);
  await expect.poll(() => ({ ...counts })).toEqual({ catalog: 2, summary: 3, history: 2 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.fastForward(500);
  assert.deepEqual(counts, { catalog: 2, summary: 3, history: 2 }, 'resume visibility/focus produces one refresh');
  assert.ok(reads.every(read => !read.forced), 'initial, scheduled and resume reads permit shared public caching');

  const axis = page.getByRole('slider', { name: '现场数据时间轴', exact: true });
  await axis.fill(String(now - 5000));
  const cursor = await axis.inputValue();
  const manualStart = reads.length;
  await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect.poll(() => counts.history).toBe(3);
  await expect(page.getByRole('region', { name: '现场历史回放' })).toContainText('12 个 BLE 可见标识');
  assert.equal(await axis.inputValue(), cursor, 'manual refresh preserves the replay cursor');
  assert.deepEqual(reads.slice(manualStart).map(read => read.forced), [true, true], 'manual field refresh bypasses shared cache for both reads');
  await page.getByRole('button', { name: '返回实时', exact: true }).click();
  await page.getByRole('button', { name: '查看现场记录', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '现场观察与记录' });
  await expect(dialog.locator('.observation-history')).toContainText('9–9 辆');
  const sharedCounts = { ...counts };
  await dialog.getByRole('button', { name: '近 1 分钟', exact: true }).click();
  await expect(dialog.locator('.observation-history')).toContainText('3–3 辆');
  await expect(dialog.locator('.observation-history')).not.toContainText('9–9 辆');
  assert.deepEqual(counts, sharedCounts, 'opening the record form and narrowing its range reuse map reads');
  await dialog.getByRole('button', { name: '近 15 分钟', exact: true }).click();
  await expect(dialog.locator('.observation-history')).toContainText('9–9 辆');
  await dialog.getByRole('combobox', { name: '记录地点', exact: true }).selectOption('parking');
  await expect.poll(() => counts.summary).toBe(sharedCounts.summary + 1);
  await expect.poll(() => counts.history).toBe(sharedCounts.history + 1);
  await expect(dialog.locator('.observation-history')).toContainText('9–9 辆');
  assert.equal(counts.catalog, sharedCounts.catalog, 'different-place dialog still reuses the catalog');
  const writeStart = reads.length, writeHistoryCount = counts.history;
  await dialog.getByLabel('最少（辆）', { exact: true }).fill('1');
  await dialog.getByLabel('最多（辆）', { exact: true }).fill('2');
  await dialog.getByLabel('操作员凭据', { exact: true }).fill('local-fixture');
  await dialog.getByRole('button', { name: '提交并确认', exact: true }).click();
  await expect(dialog).toContainText('记录已获服务端确认');
  await expect.poll(() => counts.history).toBe(writeHistoryCount + 1);
  assert.deepEqual(reads.slice(writeStart).map(read => read.forced), [true, true], 'confirmed writes bypass shared cache');
  await expect(dialog.getByRole('button', { name: '刷新现场观察', exact: true })).toBeEnabled();
  const catalogStart = reads.length, catalogCount = counts.catalog;
  await dialog.getByRole('button', { name: '刷新现场观察', exact: true }).click();
  await expect.poll(() => counts.catalog).toBe(catalogCount + 1);
  await expect(dialog.getByRole('button', { name: '刷新现场观察', exact: true })).toBeEnabled();
  assert.deepEqual(reads.slice(catalogStart).map(read => read.forced), [true, true, true], 'manual record refresh bypasses field and catalog caches');
  await dialog.getByRole('button', { name: '关闭记录表单', exact: true }).click();

  // A stalled live endpoint must survive further timer/focus events without
  // abort/restart request storms; history stays independent of that stall.
  holdSummary = true;
  await page.clock.fastForward(31_000);
  await expect.poll(() => !!releaseSummary).toBe(true);
  const stalledCount = counts.summary;
  await page.clock.fastForward(35_000);
  await visible(false); await visible(true);
  assert.equal(counts.summary, stalledCount, 'one stalled request stays one request');
  holdSummary = false; releaseSummary();
  await expect(page.getByRole('button', { name: '刷新现场数据', exact: true })).toBeEnabled();
  await page.clock.fastForward(30_100);
  await expect.poll(() => counts.summary).toBe(stalledCount + 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: ['independent summary/history/catalog cadence', 'hidden polling stops and resume refresh coalesces', 'manual refresh preserves replay cursor', 'record form shares catalog, summary and covered history', 'record-form history ranges retain all returned observations', 'different record locations fetch their own scope', 'slow live reads never overlap', 'ordinary polling permits shared cache; manual and confirmed-write reads bypass it'], requests: counts, pageErrors: errors.length }, null, 2));
} finally {
  holdSummary = false; releaseSummary?.();
  await browser.close();
}
