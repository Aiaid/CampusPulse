import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

// UI/API-contract regression with an in-memory fixture. No Worker/database
// writes, credentials, or production target. Official tiles remain remote.
const origin = process.env.GIS_SMOKE_URL || 'http://127.0.0.1:5198';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const browser = await chromium.launch({ headless: true });
let places = [
  { id: 'library', name: '图书馆测试点', kind: 'activity', anchor: { x: .5, y: .5 }, gis_anchor: { x: 15656 / 24576, y: 9059 / 24576, verified: true } },
  { id: 'unlocated', name: '待定位测试点', kind: 'parking', anchor: { x: .3, y: .6 } },
];
const writes = [], errors = [];
let placesUnavailable = false;
const capture = async (page, name) => {
  if (!process.env.GIS_SMOKE_SCREENSHOT_DIR) return;
  mkdirSync(process.env.GIS_SMOKE_SCREENSHOT_DIR, { recursive: true });
  await page.waitForFunction(() => [...document.querySelectorAll('.cp-location-map .cp-map__tile')].every(image => image.complete));
  await page.screenshot({ path: join(process.env.GIS_SMOKE_SCREENSHOT_DIR, `${name}.png`) });
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/v1/places' && placesUnavailable) return route.fulfill({ status: 503, json: { error: 'fixture-unavailable' } });
    let body;
    if (path === '/api/v1/settings') body = { site_name: 'GIS regression', default_mode: 'field' };
    else if (path === '/api/v1/admin/auth/status') body = { initialized: true };
    else if (path === '/api/v1/admin/session') body = { authenticated: true, role: 'admin', account: { username: 'fixture', display_name: '本地测试' } };
    else if (path === '/api/v1/admin/overview') body = {};
    else if (path === '/api/v1/admin/devices') body = { devices: [] };
    else if (path === '/api/v1/places' || path === '/api/v1/admin/places') body = { places, truncated: false };
    else if (path.startsWith('/api/v1/admin/places/') && request.method() === 'PATCH') {
      const input = request.postDataJSON(), id = decodeURIComponent(path.split('/').at(-1));
      writes.push({ id, input });
      places = places.map(place => place.id === id ? { ...place, ...input } : place);
      body = { place: places.find(place => place.id === id) };
    } else if (path.endsWith('/summary')) body = { latest_observation: null };
    else if (path.includes('/history')) body = { observations: [] };
    else return route.fulfill({ status: 404, json: { error: { code: 'fixture_missing' } } });
    return route.fulfill({ json: body });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/admin`);
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '地点与部署', exact: true }).click();
  await page.getByRole('heading', { name: '校园 GIS 位置', exact: true }).waitFor();
  await capture(page, 'admin-desktop');
  assert.equal(await page.locator('.cp-location-map .cp-map__label').count(), 1);
  await page.getByRole('button', { name: '编辑地点 待定位测试点', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '编辑地点', exact: true });
  const picker = dialog.getByRole('region', { name: /^GIS 位置选点地图/ });
  await picker.click({ position: { x: 130, y: 160 } });
  const confirmation = dialog.getByRole('checkbox', { name: '我已核对所选 GIS 位置与此地点相符', exact: true });
  assert.equal(await confirmation.isChecked(), false, 'Picking must not declare verification');
  assert.ok(Number(await dialog.getByLabel('GIS x（0–1）', { exact: true }).inputValue()) > 10240 / 24576);
  await dialog.getByRole('button', { name: '保存地点', exact: true }).click();
  assert.equal(writes.length, 0, 'Unconfirmed GIS coordinates cannot save');
  await confirmation.check();
  await capture(page, 'picker-desktop');
  const bounds = await picker.boundingBox();
  await page.mouse.move(bounds.x + 100, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 180, bounds.y + 170, { steps: 5 });
  await page.mouse.up();
  assert.equal(await confirmation.isChecked(), true, 'Dragging pans without repicking or clearing confirmation');
  await picker.focus();
  await page.keyboard.press('Enter');
  assert.equal(await confirmation.isChecked(), false, 'Keyboard picking requires verification again');
  await confirmation.check();
  await dialog.getByRole('button', { name: '保存地点', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].input.gis_anchor.verified, true);
  assert.deepEqual(writes[0].input.anchor, { x: .3, y: .6 }, 'GIS edits preserve independent schematic anchors');
  const link = page.getByRole('link', { name: '在前台地图查看 待定位测试点', exact: true });
  assert.equal(await link.getAttribute('href'), '/?place=unlocated');
  await page.goto(`${origin}/?place=unlocated`);
  await page.getByRole('heading', { name: '待定位测试点', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '现场观察', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.overview-map .cp-map__label').count(), 2);
  assert.equal(await page.locator('.cp-map__sprite').count(), 0);
  assert.ok((await page.locator('.cp-map__regions').evaluateAll(elements => elements.map(element => element.dataset.regionCount))).every(count => count === '0'), 'Field IDs do not inherit authored building outlines');
  await page.getByRole('button', { name: '查看现场记录', exact: true }).click();
  await page.getByRole('dialog', { name: '现场观察与记录', exact: true }).waitFor();
  await expect(page.getByLabel('记录地点', { exact: true })).toHaveValue('unlocated');
  await page.getByRole('button', { name: '关闭记录表单', exact: true }).click();

  // A background settings change is picked up on refocus without reloading.
  places = places.map(place => place.id === 'unlocated' ? { ...place, name: '重命名测试点' } : place);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('heading', { name: '重命名测试点', exact: true }).waitFor();
  await page.getByRole('button', { name: '模拟演示', exact: true }).click();
  assert.equal(await page.locator('.overview-map .cp-map__label').count(), 8, 'Demo keeps authored places separate');
  await page.getByRole('button', { name: '现场观察', exact: true }).click();
  await page.getByRole('heading', { name: '重命名测试点', exact: true }).waitFor();

  // All four corners must be centerable with keyboard panning at base zoom.
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: '收起局部详情', exact: true }).click();
    const map = page.locator('.overview-map .cp-map');
    await expect.poll(() => map.evaluate(element => element.clientWidth)).toBe(viewport.width);
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      await page.getByRole('button', { name: '回到全校视野', exact: true }).click();
      await map.focus();
      for (let i = 0; i < 16; i++) await page.keyboard.press(sx > 0 ? 'ArrowLeft' : 'ArrowRight');
      for (let i = 0; i < 16; i++) await page.keyboard.press(sy > 0 ? 'ArrowUp' : 'ArrowDown');
      const result = await map.evaluate((element, { sx, sy }) => {
        const raster = element.querySelector('.cp-map__raster');
        const transform = new DOMMatrixReadOnly(getComputedStyle(raster).transform);
        return { x: transform.e + (sx > 0 ? 0 : 1024) * transform.a, y: transform.f + (sy > 0 ? 0 : 640) * transform.d, width: element.clientWidth, height: element.clientHeight };
      }, { sx, sy });
      assert.ok(Math.abs(result.x - result.width / 2) < .1 && Math.abs(result.y - result.height / 2) < .1, `Each corner reaches the viewport center: ${JSON.stringify({ viewport, sx, sy, ...result })}`);
    }
    await page.locator('.reopen-detail').click();
  }
  // Remove the registered anchor and verify public refresh has no phantom pin.
  places = places.map(place => place.id === 'unlocated' ? { ...place, gis_anchor: undefined } : place);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('heading', { name: '图书馆测试点', exact: true }).waitFor();
  assert.equal(await page.locator('.overview-map .cp-map__label').count(), 1);
  assert.ok((await page.locator('.live-mode-summary').innerText()).includes('1'));
  placesUnavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.live-mode-summary')).toContainText('现场地点服务暂不可用');
  assert.equal(await page.locator('.overview-map .cp-map__label').count(), 0, 'Failed API does not retain phantom pins');
  placesUnavailable = false;

  // Phone form: manual edits require rechecking; clearing the GIS anchor sends
  // null and preserves the independent schematic anchor.
  await page.goto(`${origin}/admin`);
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '地点与部署', exact: true }).click();
  await page.getByRole('button', { name: '编辑地点 图书馆测试点', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '编辑地点', exact: true });
  await dialog.getByLabel('GIS x（0–1）', { exact: true }).fill('0.63');
  assert.equal(await dialog.getByRole('checkbox').isChecked(), false);
  await dialog.getByRole('checkbox').check();
  await capture(page, 'picker-phone');
  assert.equal(await dialog.locator('.cp-admin-dialog-head').evaluate(header => {
    const rect = header.getBoundingClientRect();
    return !!document.elementFromPoint(rect.right - 90, rect.top + 4)?.closest('.cp-admin-dialog-head');
  }), true, 'Scrolled map controls remain below the sticky dialog header');
  await dialog.getByRole('button', { name: '移除 GIS 位置，保留为待定位地点', exact: true }).click();
  await dialog.getByRole('button', { name: '保存地点', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(writes.at(-1).input.gis_anchor, null);
  assert.deepEqual(writes.at(-1).input.anchor, { x: .5, y: .5 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Phone form has no document overflow');
  assert.deepEqual(errors, []);
  console.log('GIS location UI fixture: edit/pick/verify/save, full-grid registration, field/deep-link/records/refresh, separate demo, and desktop/phone corner navigation passed. No database writes.');
} finally {
  await browser.close();
}
