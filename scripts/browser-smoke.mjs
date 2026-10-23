import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';

// Run against a local Worker only. Uses the ignored local operator credential.
const baseURL = process.env.SMOKE_URL || 'http://127.0.0.1:8787';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname), 'Local target required');
const token = readFileSync('.dev.vars', 'utf8').match(/^OPERATOR_TOKEN=(.+)$/m)?.[1];
assert.ok(token, 'Set a local .dev.vars OPERATOR_TOKEN first');
const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
// Chromium does not inherit Node's environment-proxy CA. Pin that configured CA
// for this disposable browser; do not globally ignore HTTPS certificate errors.
if (process.env.NODE_EXTRA_CA_CERTS) {
  const ca = new X509Certificate(readFileSync(process.env.NODE_EXTRA_CA_CERTS));
  const spki = createHash('sha256').update(ca.publicKey.export({type:'spki',format:'der'})).digest('base64');
  args.push(`--ignore-certificate-errors-spki-list=${spki}`);
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args,
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(baseURL);
  await page.getByRole('heading', { name: '图书馆', exact: true }).waitFor();
  await page.locator('.gis-map').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.gis-map img')].some(i => i instanceof HTMLImageElement && i.complete && i.naturalWidth > 0), {timeout: 20000});
  await page.getByRole('button', { name: '模拟演示', exact: true }).click();
  await page.getByText('以下为合成模拟数值，与现场数据隔离').waitFor();
  await page.getByRole('button', { name: '退出模拟', exact: true }).click();
  await page.getByRole('button', { name: /三维光效示意/ }).click();
  await page.locator('.scene canvas').waitFor();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /华师 GIS 底图/ }).click();
  await page.getByRole('button', { name: /添加现场记录/ }).click();
  await page.getByLabel('记录地点').selectOption('east-parking');
  await page.getByLabel('最少（辆）').fill('2');
  await page.getByLabel('最多（辆）').fill('5');
  await page.getByLabel('操作员凭据').fill(token);
  const committed = page.waitForResponse(r => r.url().endsWith('/api/v1/observations') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '提交并确认' }).click();
  const uiResponse = await committed;
  assert.equal(uiResponse.status(), 201);
  const uiId = (await uiResponse.json()).observation.id;
  await page.getByRole('heading', {name:'东区停车观察点', exact:true}).waitFor();
  await page.getByText('2–5 辆', {exact:true}).waitFor();
  await page.getByRole('button', { name: /添加现场记录/ }).click();
  const cancelled = page.waitForResponse(r => r.url().endsWith(`/api/v1/observations/${uiId}`) && r.request().method() === 'DELETE');
  await page.getByRole('button', {name:'撤销最近一条记录'}).click();
  assert.equal((await cancelled).status(), 200);
  await page.getByRole('button', {name:'关闭记录表单'}).click();
  await page.getByRole('navigation', {name:'校园地点'}).getByRole('button', {name:'图书馆',exact:true}).click();

  const headers = { Authorization: `Bearer ${token}` };
  const id = crypto.randomUUID();
  const response = await page.request.post(`${baseURL}/api/v1/observations`, { headers, data: { id, place_id: 'east-parking', kind: 'parking', observed_at: new Date().toISOString(), parking_min: 4, parking_max: 7 } });
  assert.equal(response.status(), 201);
  assert.equal((await response.json()).durability, 'committed');
  const summary = await page.request.get(`${baseURL}/api/v1/places/east-parking/summary`);
  assert.equal((await summary.json()).latest_observation.id, id);
  assert.equal((await page.request.delete(`${baseURL}/api/v1/observations/${id}`, { headers })).status(), 200);
  assert.equal((await page.request.get(`${baseURL}/api/v1/places/east-parking/summary`).then(r => r.json())).latest_observation, null);

  mkdirSync('/tmp/campuspulse-qa', { recursive: true });
  await page.screenshot({ path: '/tmp/campuspulse-qa/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page overflow');
  await page.getByRole('button', { name: /添加现场记录/ }).click();
  await page.locator('.record-form').waitFor();
  assert.ok(await page.locator('.record-form').isVisible());
  await page.getByRole('button', { name: '关闭记录表单' }).click();
  await page.screenshot({ path: '/tmp/campuspulse-qa/mobile.png' });
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log('Browser smoke passed: actual GIS tile rendering, simulation, WebGL, local D1 writes/cancellation, mobile layout.');
} finally { await browser.close(); }
