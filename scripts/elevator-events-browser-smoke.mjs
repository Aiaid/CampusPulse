import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Read-only acceptance. The displayed candidate below is a browser-only fixture;
// real committed-stream coverage is in the SQLite API/store regression tests.
const base = process.env.ELEVATOR_SMOKE_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const path = '/api/v1/places/teaching-elevator/elevator-events';
  const real = await page.request.get(new URL(path, base).href);
  assert.equal(real.status(), 200);
  const actual = await real.json();
  assert.equal(actual.place_id, 'teaching-elevator');
  assert.ok(Array.isArray(actual.events));
  assert.ok(!JSON.stringify(actual).includes('item_json'));
  assert.ok(!JSON.stringify(actual).includes('address_summaries'));

  const now = Date.now();
  let mode = 'candidate';
  const fixture = {
    place_id: 'teaching-elevator', as_of: new Date(now).toISOString(),
    data_until: new Date(now - 5000).toISOString(), valid_until: new Date(now + 60000).toISOString(),
    status: 'observing', reason: null, rule_version: 'cohort-disappearance-v0', truncated: false,
    events: [{ id: 'a'.repeat(32), event_from: new Date(now - 60000).toISOString(),
      event_to: new Date(now - 55000).toISOString(), confirmed_at: new Date(now - 30000).toISOString(),
      baseline_identifiers: 18, lost_identifiers: 6, lost_fraction: 1 / 3,
      verification: 'unverified', reappearance_flag: false, reappeared_identifiers: 0 }],
  };
  await page.route('**/api/v1/places/teaching-elevator/elevator-events', async route => {
    if (mode === 'error') return route.fulfill({ status: 503, json: { error: { code: 'storage_unavailable' } } });
    if (mode === 'unavailable') return route.fulfill({ json: { ...fixture, data_until: null, valid_until: null,
      status: 'unavailable', reason: 'no_address_windows', events: [] } });
    return route.fulfill({ json: fixture });
  });
  await page.route('**/gis3d.ccnu.edu.cn/**', route => route.abort());
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '现场观察与记录', exact: true });
  await dialog.getByLabel('记录地点', { exact: true }).selectOption('teaching-elevator');
  const events = dialog.getByRole('region', { name: '候梯区群体消失事件' });
  await events.getByText('6 个标识集中消失', { exact: true }).waitFor();
  await events.getByText('尚未现场核实', { exact: true }).waitFor();
  assert.ok((await events.innerText()).includes('标识数不等于人数'));
  assert.ok(!(await events.innerText()).includes('02:'));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  mode = 'unavailable';
  await dialog.getByRole('button', { name: '刷新现场观察', exact: true }).click();
  await events.getByText('暂无可用观测', { exact: true }).waitFor();
  assert.equal(await events.getByText('6 个标识集中消失', { exact: true }).count(), 0);
  mode = 'error';
  await dialog.getByRole('button', { name: '刷新现场观察', exact: true }).click();
  await events.getByText('事件暂时读取失败', { exact: false }).waitFor();
  assert.equal(await events.getByText('6 个标识集中消失', { exact: true }).count(), 0);
  await dialog.getByLabel('记录地点', { exact: true }).selectOption('east-parking');
  assert.equal(await dialog.getByRole('region', { name: '候梯区群体消失事件' }).count(), 0);
  console.log('Elevator events: real read, synthetic UI candidate, unavailable/error isolation and mobile layout passed.');
} finally { await browser.close(); }
