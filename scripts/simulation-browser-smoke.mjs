import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

expect.configure({ timeout: 15000 });

// Frontend-only acceptance: no Worker/database is required or mutated.
const baseURL = process.env.SIMULATION_URL || 'http://127.0.0.1:5186';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname), 'Local target required');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], writes = [], checks = [];
const screenshotDir = process.env.SCREENSHOT_DIR;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const capture = name => screenshotDir ? page.screenshot({ path: path.join(screenshotDir, name), animations: 'disabled' }) : undefined;
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', route => {
  const request = route.request();
  if (request.method() !== 'GET') writes.push(request.url());
  if (new URL(request.url()).pathname === '/api/v1/settings') {
    return route.fulfill({ json: { site_name: 'CampusPulse', default_mode: 'field' } });
  }
  return route.fulfill({ status: 503, json: { error: 'No backend in simulation acceptance' } });
});
const maps = page.locator('.cp-activity-layer');
const select = page.getByRole('combobox', { name: '模拟场景', exact: true });
const setTime = minute => page.getByRole('slider', { name: '模拟回放时间' }).fill(String(minute));
const sync = async (scenario, minute) => {
  await expect.poll(() => maps.evaluateAll(nodes => nodes.map(node => `${node.dataset.scenario}:${node.dataset.minute}`)))
    .toEqual([`${scenario}:${minute}`, `${scenario}:${minute}`]);
};
const metrics = () => page.locator('.metric-list').innerText();
try {
  await page.goto(baseURL);
  await expect(page.getByRole('button', { name: '现场观察', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(select).toHaveCount(0);
  await expect.poll(() => maps.evaluateAll(nodes => nodes.map(node => node.dataset.actorCount))).toEqual(['0']);
  checks.push('field default contains no synthetic activity');

  await page.getByRole('button', { name: '模拟演示', exact: true }).click();
  await expect(select).toHaveValue('weekday');
  await setTime(750);
  await sync('weekday', 750);
  const weekday = await metrics();
  const weekdayRiders = await maps.first().getAttribute('data-riding-count');
  await select.selectOption('rainy');
  await sync('rainy', 750);
  assert.notEqual(await metrics(), weekday);
  assert.ok(Number(await maps.first().getAttribute('data-riding-count')) < Number(weekdayRiders));
  await expect(page.locator('.simulation-parking')).toBeVisible();
  await capture('simulation-desktop.png');
  checks.push('rainy profile updates metrics, parking and both maps with less cycling');

  await select.selectOption('weekend');
  await sync('weekend', 750);
  await setTime(735);
  await expect(page.locator('.time-presets .active')).toHaveCount(0);
  await page.getByRole('button', { name: '查看时段变化', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(9);
  await expect(page.locator('.history-row.selected')).toHaveCount(0);
  await page.locator('.history-row').filter({ hasText: '09:00' }).click();
  await expect(page.getByRole('slider', { name: '模拟回放时间' })).toHaveValue('540');
  await page.getByRole('button', { name: '返回局部视图', exact: true }).last().click();
  await sync('weekend', 540);
  checks.push('scenario history selects a shared replay time');

  await page.getByRole('button', { name: '播放时段回放', exact: true }).click();
  await expect.poll(() => page.getByRole('slider', { name: '模拟回放时间' }).inputValue()).not.toBe('540');
  await page.getByRole('button', { name: '现场观察', exact: true }).click();
  await expect(select).toHaveCount(0);
  await expect(page.locator('.metric-list')).toHaveCount(0);
  await expect(page.locator('.simulation-parking')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: '模拟回放时间' })).toHaveCount(0);
  await expect.poll(() => maps.evaluateAll(nodes => nodes.map(node => `${node.dataset.scenario}:${node.dataset.actorCount}:${node.dataset.motion}`)))
    .toEqual(['field:0:paused']);
  await page.getByRole('button', { name: '模拟演示', exact: true }).click();
  await expect(select).toHaveValue('weekend');
  await expect(page.getByRole('button', { name: '播放时段回放', exact: true })).toBeVisible();
  checks.push('switching to field clears all synthetic indicators and stops replay');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(select).toBeVisible();
  await select.selectOption('rainy');
  await setTime(720);
  await sync('rainy', 720);
  const bounds = await select.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await capture('simulation-phone.png');
  await page.getByRole('button', { name: '收起局部详情', exact: true }).click();
  await expect(select).toBeVisible();
  checks.push('390px layout keeps scenario selection usable with or without detail');
  assert.deepEqual(writes, [], 'simulation must never write API records');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, apiWrites: writes.length, pageErrors: errors.length }, null, 2));
} finally {
  await browser.close();
}
