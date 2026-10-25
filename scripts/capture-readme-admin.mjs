import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

// Actual local UI, browser-local read-only fixtures. No server login or writes.
const origin = new URL(process.env.README_URL || 'http://127.0.0.1:5186');
assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname));
const originals = process.env.README_ORIGINALS || '/tmp/campuspulse-readme-admin-originals';
mkdirSync(originals, { recursive: true });
mkdirSync('docs/images', { recursive: true });
const now = Date.parse('2026-10-25T06:00:00Z');
const iso = ms => new Date(ms).toISOString();
const boot = 'sample-boot';
const status = JSON.parse(readFileSync('docs/specs/examples/node-status-v2.request.json', 'utf8')).items[0];
status.time.utc_ms = now - 15000; status.time.uncertainty_ms = 200;
status.raw_capture_state = 'off';
const devices = [
  { id: 'sample-passport-01', name: '图书馆节点（样例）', board: 'AI Passport / ESP32-C3 · 样例', enabled: true, contact_state: 'recent', config_state: 'applied', last_seen_at: iso(now - 10000) },
  { id: 'sample-passport-02', name: '待部署节点（样例）', board: 'AI Passport / ESP32-C3 · 样例', enabled: true, contact_state: 'unknown', config_state: 'pending', last_seen_at: null },
];
const config = JSON.parse(readFileSync('docs/specs/examples/capture-config-v2.fixture.json', 'utf8'));
Object.assign(config, { capture_config_id: 'sample-config', node_id: devices[0].id, placement_id: 'sample-placement' });
config.raw_capture.mode = 'off';
const device = { ...devices[0], server_time: iso(now), stale_after_seconds: 300, firmware_version: 'sample-firmware', desired_config_id: 'sample-config', applied_config_id: 'sample-config',
  latest_control: { received_at: iso(now - 10000), boot_id: boot, capture_state: 'running', wifi_state: 'connected' },
  latest_ingestion: { received_at: iso(now - 10000), boot_id: boot, stream: 'node_status' },
  latest_status: { received_at: iso(now - 10000), boot_id: boot, capture_config_id: 'sample-config', item: status },
};
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage(), errors = [], writes = [], unmatched = [], captures = [];
page.on('pageerror', error => errors.push(error.name));
await page.clock.setFixedTime(now);
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin.origin) return route.abort();
  if (!url.pathname.startsWith('/api/')) return route.continue();
  if (request.method() !== 'GET') { writes.push(request.method()); return route.abort(); }
  const fixtures = {
    '/api/v1/admin/auth/status': { initialized: true, passkey_available: true, password_login_available: true },
    '/api/v1/admin/session': { authenticated: true, role: 'admin', account: { username: 'sample-admin', display_name: '演示管理员（样例）' } },
    '/api/v1/admin/overview': { devices_total: 2, devices_enabled: 2, devices_recent: 1, devices_stale: 1, config_pending: 1, server_time: iso(now) },
    '/api/v1/admin/devices': { devices, next_cursor: null },
    '/api/v1/admin/devices/sample-passport-01': { device, placements: [{ id: 'sample-placement', place_id: 'library', place_name: '图书馆（样例）', observation_kinds: ['activity'], valid_from_ms: now - 3600000 }], configs: [{ id: 'sample-config', config }], activation: { current: null, history: [] } },
    '/api/v1/admin/devices/sample-passport-01/batches': { batches: [], next_cursor: null },
    '/api/v1/admin/settings': { revision: 1, settings: {} },
  };
  if (!(url.pathname in fixtures)) { unmatched.push(url.pathname); return route.fulfill({ status: 404, json: { error: { code: 'screenshot_fixture_missing' } } }); }
  return route.fulfill({ json: fixtures[url.pathname] });
});

// Keep only PNG pixel/color chunks; no EXIF/XMP/text/time/profile metadata.
const safe = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM']);
function inspect(input, strip = false) {
  assert.ok(input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const parts = [input.subarray(0, 8)], chunks = [];
  let at = 8;
  while (at < input.length) {
    const end = at + input.readUInt32BE(at) + 12;
    assert.ok(end <= input.length);
    const kind = input.toString('ascii', at + 4, at + 8);
    assert.ok(safe.has(kind) || /^[a-z]/.test(kind), 'Unknown critical PNG chunk');
    if (!strip) assert.ok(safe.has(kind), 'Unexpected metadata in final PNG');
    if (safe.has(kind)) { parts.push(input.subarray(at, end)); chunks.push(kind); }
    at = end;
  }
  assert.equal(chunks[0], 'IHDR'); assert.equal(chunks.at(-1), 'IEND');
  return { bytes: Buffer.concat(parts), chunks: [...new Set(chunks)] };
}
async function save(name, target = page) {
  const original = path.join(originals, name), output = `docs/images/${name}`;
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1, 1);
  await target.screenshot({ path: original, animations: 'disabled' });
  writeFileSync(output, inspect(readFileSync(original), true).bytes);
  const final = readFileSync(output), { chunks } = inspect(final);
  captures.push({ file: output, width: final.readUInt32BE(16), height: final.readUInt32BE(20), chunks, sha256: createHash('sha256').update(final).digest('hex') });
}
try {
  await page.goto(`${origin.origin}/admin`);
  await expect(page.getByRole('heading', { name: '运行概览', exact: true })).toBeVisible();
  await expect(page.getByText('图书馆节点（样例）', { exact: true })).toBeVisible();
  await save('admin-overview.png');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '设备管理', exact: true }).click();
  await page.getByRole('button', { name: '查看设备 sample-passport-01', exact: true }).click();
  await expect(page.getByText('最近状态 · 同一控制启动', { exact: true }).first()).toBeVisible();
  // The admin shell scrolls internally. Capture the visible viewport rather
  // than an oversized element screenshot, which can include unpainted pixels.
  await page.locator('.cp-device-diagnostics').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await save('admin-device-diagnostics.png');
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(unmatched, []);
  console.log(JSON.stringify({ captures, pageErrors: errors.length, apiWrites: writes.length, unmatchedRoutes: unmatched.length }, null, 2));
} finally { await browser.close(); }
