import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

// Renderer-only regression. Browser-local GET fixtures, no records or API writes.
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5199/';
const out = path.resolve(process.env.PERF_DIR || 'captures/performance/runtime');
const browser = await chromium.launch({ headless: process.env.HEADLESS === '1' });
const results = [];
await fs.mkdir(out, { recursive: true });
const ready = page => page.waitForFunction(() => {
  const campus = [...document.querySelectorAll('.cp-campus-light-host')];
  const library = [...document.querySelectorAll('.cp-library-light-host')];
  return campus.length > 0 && library.length > 0
    && campus.every(el => el.dataset.materialStatus === 'ready')
    && library.every(el => el.dataset.viewport === 'offscreen' || el.dataset.atlasStatus === 'ready');
}, undefined, { timeout: 90_000 });
const settings = async page => {
  if (!await page.getByRole('button', { name: '关闭场景设置', exact: true }).count())
    await page.getByRole('button', { name: '场景设置', exact: true }).click();
};
try {
  for (const fallback of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await context.route('**/api/v1/**', route => {
      expect(route.request().method()).toBe('GET');
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ json: pathname === '/api/v1/settings' ? { site_name: 'CampusPulse', default_mode: 'demo' }
        : pathname === '/api/v1/places' ? { places: [], truncated: false }
        : pathname.endsWith('/history') ? { observations: [] } : { latest_observation: null } });
    });
    if (fallback) await context.addInitScript(() => { globalThis.Worker = undefined; });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.locator('.detail-scene .cp-map').focus();
    for (let i = 0; i < 12; i++) { await page.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight'); await page.waitForTimeout(50); }
    await ready(page);
    const initial = await page.locator('.cp-campus-light-host').evaluateAll(els => els.map(el => ({ ...el.dataset })));
    expect(initial.every(el => el.computeBackend === (fallback ? 'cooperative-main' : 'worker-pool'))).toBe(true);
    expect(initial.every(el => el.quality === 'efficient' && el.chunkResolution === '1')).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const actorWidths = await page.locator('.cp-activity-layer').evaluateAll(els => els.map(el => el.width));
    const qualityMode = async name => {
      await settings(page);
      await page.getByRole('button', { name, exact: true }).click();
      await page.getByRole('button', { name: '关闭场景设置', exact: true }).click();
      await ready(page);
    };
    await qualityMode('精细');
    expect(await page.locator('.cp-library-light-host').evaluateAll(els => els.every(el => el.dataset.quality === 'full'))).toBe(true);
    await qualityMode('轻量');
    expect(await page.locator('.cp-campus-light-host').evaluateAll(els => els.every(el => el.dataset.quality === 'efficient' && el.dataset.chunkResolution === '1'))).toBe(true);
    expect(await page.locator('.cp-activity-layer').evaluateAll(els => els.map(el => el.width))).toEqual(actorWidths);
    expect(await page.evaluate(() => localStorage.getItem('campuspulse.lighting-quality'))).toBe('efficient');
    await settings(page);
    await page.getByRole('button', { name: /建筑透视/ }).click();
    await page.getByRole('button', { name: '关闭场景设置', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.cp-library-light[data-library-channel="buildingMaterial"]')]
      .filter(canvas => canvas.width).every(canvas => Math.abs(canvas.getContext('2d').globalAlpha - .22) < .01));
    await page.getByRole('button', { name: '浅色', exact: true }).click();
    await expect(page.locator('.cp-library-light-host')).toHaveCount(0);
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await ready(page);
    await settings(page);
    await page.getByRole('button', { name: '原始效果', exact: true }).click();
    await page.getByRole('button', { name: '关闭场景设置', exact: true }).click();
    await expect(page.locator('.cp-library-light-host')).toHaveCount(0);
    await expect(page.locator('.cp-campus-light-host')).toHaveCount(0);
    await settings(page);
    await page.getByRole('button', { name: '校园光照', exact: true }).click();
    await page.getByRole('button', { name: '关闭场景设置', exact: true }).click();
    await ready(page);
    const frames = await page.locator('.cp-library-light-host').evaluateAll(els => els.map(el => el.dataset.renderFrame));
    await page.waitForTimeout(300);
    expect(await page.locator('.cp-library-light-host').evaluateAll(els => els.map(el => el.dataset.renderFrame))).toEqual(frames);
    await page.getByRole('button', { name: '现场观察', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.cp-activity-layer')].every(el => el.dataset.actorCount === '0'));
    expect(errors).toEqual([]);
    results.push({ fallback, initial, errors, checks: ['rapid pan during preparation', 'mobile overflow', 'quality switch and actor resolution', 'quality preference', 'xray', 'day/night', 'original/campus', 'idle stopped', 'field actors hidden'] });
    console.log(JSON.stringify({ fallback, checks: results.at(-1).checks, errors }));
    await context.close();
  }
  await fs.writeFile(path.join(out, 'runtime-smoke.json'), JSON.stringify(results, null, 2));
} finally { await browser.close(); }
