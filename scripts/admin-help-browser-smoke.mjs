import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';

// Read-only synthetic API fixtures against the actual local React UI. Never
// authenticate to a deployed API, connect hardware or submit configuration.
const server = await createServer({ server: { host: '127.0.0.1', port: randomInt(22000, 60000), strictPort: true }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const binary = process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const useWebkit = process.argv.includes('--webkit');
const fallback = process.argv.includes('--fallback');
const screenshotDir = process.env.HELP_SCREENSHOT_DIR || process.argv.find(arg => arg.startsWith('--screenshots='))?.slice('--screenshots='.length);
let browser;
const errors = [], writes = [], unmatched = [];
const now = Date.now(), iso = value => new Date(value).toISOString();
const config = JSON.parse(readFileSync(new URL('../docs/specs/examples/capture-config-v2.fixture.json', import.meta.url), 'utf8'));
config.accept_until = iso(now + 86400000);
const node = config.node_id, boot = '11111111-1111-4111-8111-111111111111';
const status = JSON.parse(readFileSync(new URL('../docs/specs/examples/node-status-v2.request.json', import.meta.url), 'utf8')).items[0];
status.time.utc_ms = now - 15000; status.time.uncertainty_ms = 200;
const place = { id: 'library', name: '样例图书馆', kind: 'activity', observation_kinds: ['activity', 'parking', 'elevator'], anchor: { x: 0.5, y: 0.5 } };
const device = { id: node, name: '样例设备', board: 'Synthetic Passport', enabled: true, contact_state: 'recent', config_state: 'applied', last_seen_at: iso(now - 10000),
  server_time: iso(now), stale_after_seconds: 300, desired_config_id: config.capture_config_id, applied_config_id: config.capture_config_id, reported_config_id: config.capture_config_id,
  latest_control: { received_at: iso(now - 10000), boot_id: boot, capture_state: 'running', wifi_state: 'connected' },
  latest_ingestion: { received_at: iso(now - 10000), boot_id: boot, stream: 'node_status' },
  latest_status: { received_at: iso(now - 10000), boot_id: boot, capture_config_id: config.capture_config_id, item: status },
};
const settings = { site_name: 'CampusPulse', default_mode: 'field', stale_after_seconds: 300, observation_ttl_minutes: 15, default_raw_retention_hours: 24, default_aggregate_retention_days: 30 };
const fixtures = {
  '/auth/status': { initialized: true, passkey_available: true },
  '/session': { authenticated: true, role: 'admin', account: { id: 'sample-admin', username: 'sample', display_name: '样例管理员' } },
  '/overview': { devices_total: 1, devices_enabled: 1, devices_recent: 1, devices_stale: 0, config_pending: 0, server_time: iso(now) },
  '/devices': { devices: [device], next_cursor: null },
  [`/devices/${node}`]: { device, placements: [{ id: config.placement_id, node_id: node, place_id: place.id, place_name: place.name, observation_kinds: ['activity'], valid_from_ms: now - 3600000 }], configs: [{ id: config.capture_config_id, config }], activation: { current: null, history: [] } },
  [`/devices/${node}/batches`]: { batches: [], next_cursor: null },
  '/configs': { drafts: [], configs: [{ id: config.capture_config_id, config, raw_retention_hours: 24, aggregate_retention_days: 30 }] },
  '/settings': { revision: 1, settings },
  '/places': { places: [place] },
  '/mqtt/pool': { broker_uri: 'mqtts://synthetic.invalid:8883', ready_count: 0, entries: [] },
  '/audit': { entries: [], next_cursor: null },
  '/account': { account: { id: 'sample-admin', username: 'sample', display_name: '样例管理员' }, passkeys: [] },
};

function stripAndCheckPng(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const safe = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM']);
  const parts = [bytes.subarray(0, 8)];
  for (let at = 8; at < bytes.length;) {
    const end = at + bytes.readUInt32BE(at) + 12;
    assert.ok(end <= bytes.length);
    if (safe.has(bytes.toString('ascii', at + 4, at + 8))) parts.push(bytes.subarray(at, end));
    at = end;
  }
  const clean = Buffer.concat(parts);
  for (let at = 8; at < clean.length;) {
    assert.ok(safe.has(clean.toString('ascii', at + 4, at + 8)));
    at += clean.readUInt32BE(at) + 12;
  }
  return clean;
}

try {
  browser = useWebkit ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, executablePath: binary });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile, reducedMotion: 'reduce' });
    if (fallback) await context.addInitScript(() => {
      Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: undefined });
      Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: undefined });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (request.method() !== 'GET') { writes.push(request.method()); return route.abort(); }
      const path = url.pathname.slice('/api/v1/admin'.length);
      if (!Object.hasOwn(fixtures, path)) { unmatched.push(path); return route.fulfill({ status: 404, json: {} }); }
      return route.fulfill({ json: fixtures[path] });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin`);
    const nav = name => page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name, exact: true }).click();
    const help = name => page.getByRole('button', { name: `查看「${name}」的说明`, exact: true });
    const panel = () => page.locator('.cp-admin-help-panel.is-open');
    const activate = locator => mobile ? locator.tap() : locator.click();
    const fit = async () => {
      await expect(panel()).toHaveCount(1);
      const box = await panel().boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= (mobile ? 390 : 1440) && box.y + box.height <= (mobile ? 844 : 1000) + 1, 'Explanation stays within viewport');
      assert.ok(await panel().innerText().then(text => text.length > 100), 'Detailed explanation, not a one-line title');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page horizontal overflow');
    };
    await expect(page.getByRole('heading', { name: '运行概览', exact: true })).toBeVisible();
    await activate(help('最近有回执')); await fit();
    await page.getByRole('heading', { name: '运行概览', exact: true }).click();
    await expect(panel()).toHaveCount(0);

    await nav('采集配置');
    await page.getByRole('button', { name: '修改配置', exact: true }).click();
    const form = page.getByRole('dialog', { name: '修改采集配置并发布新版本', exact: true });
    const interval = form.getByLabel('扫描间隔（ms）', { exact: true });
    const initialInterval = await interval.inputValue();
    const tip = help('扫描间隔（ms）');
    await tip.scrollIntoViewIfNeeded(); await tip.focus();
    await fit();
    await tip.press('Escape'); await expect(panel()).toHaveCount(0);
    await expect(form).toBeVisible();
    await expect(tip).toBeFocused();
    if (!mobile) {
      // Hover works while focus stays in the input; Escape must not close form.
      await interval.focus(); await tip.hover(); await fit();
      await page.keyboard.press('Escape'); await expect(panel()).toHaveCount(0);
      await expect(form).toBeVisible(); await expect(interval).toBeFocused();
      await page.mouse.move(1, 1);
    }
    await activate(tip); await fit();
    await expect(panel()).toContainText('扫描窗口');
    if (!mobile) {
      await page.mouse.move(1, 1); await page.waitForTimeout(250);
      await expect(panel()).toHaveCount(1); // Click pins the explanation.
    }
    const close = panel().getByRole('button', { name: /关闭/ });
    await close.click(); await expect(panel()).toHaveCount(0);
    await expect(tip).toBeFocused();
    assert.equal(await interval.inputValue(), initialInterval, 'Opening help never edits the field');
    assert.equal(writes.length, 0, 'Help buttons never submit the form');

    // Disabled v2 controls still have independent, operable explanations.
    await activate(help('标识方案')); await fit();
    await panel().getByRole('button', { name: /关闭/ }).click();
    await activate(help('配置租约（ms）')); await fit();
    const copy = panel().locator('.cp-admin-help-copy');
    await copy.focus();
    if (await panel().evaluate(element => element.scrollHeight > element.clientHeight + 1)) {
      await copy.press('End');
      await expect.poll(() => panel().evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await panel().evaluate(element => { element.scrollTop = 0; });
    }
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
      const image = await page.screenshot({ animations: 'disabled' });
      const path = `${screenshotDir}/admin-help-${useWebkit ? 'webkit-' : ''}${mobile ? 'mobile' : 'desktop'}.png`;
      writeFileSync(path, stripAndCheckPng(image));
      assert.ok(stripAndCheckPng(readFileSync(path)).equals(readFileSync(path)), 'Final image has only approved pixel/color chunks');
    }
    await page.keyboard.press('Escape'); await expect(form).toBeVisible();
    await form.getByRole('button', { name: '取消', exact: true }).click();

    await nav('设备管理');
    await page.getByRole('button', { name: `查看设备 ${node}`, exact: true }).click();
    await activate(help('堆内存可用')); await fit();
    await panel().getByRole('button', { name: /关闭/ }).click();
    await activate(help('设备时钟 epoch')); await fit();
    await expect(panel()).toContainText('Unix');
    await panel().getByRole('button', { name: /关闭/ }).click();
    await nav('站点设置');
    await activate(help('设备联系过期阈值（秒）')); await fit();
    await page.keyboard.press('Escape');
    await nav('地点与部署');
    await page.getByRole('button', { name: '新建地点', exact: true }).click();
    await activate(help('地点 ID')); await fit();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '新建地点', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    await nav('账号与安全');
    await activate(help('Passkey')); await fit();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('button button, label button, a button').count(), 0, 'No help buttons nested in interactive labels/controls');
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(unmatched, []);
  console.log(`Administrator help (${useWebkit ? 'WebKit' : 'Chromium'}${fallback ? ', fallback' : ''}): desktop/mobile, focus/click/touch/Escape, modal/top-layer geometry, read-only forms and detailed content PASS`);
} finally {
  await browser?.close();
  await server.close();
}
