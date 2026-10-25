import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
// Browser fixture only: no deployed API, hardware, credentials or screenshots.
const server = await createServer({ server: { host: '127.0.0.1', port: randomInt(22000, 60000), strictPort: true }, logLevel: 'error' });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const binary = process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const browser = await chromium.launch({ headless: true, executablePath: binary });
const original = JSON.parse(readFileSync(new URL('../docs/specs/examples/capture-config-v2.fixture.json', import.meta.url), 'utf8'));
original.accept_until = new Date(Date.now() + 86400000).toISOString();
const node = original.node_id;
const initial = { id: original.capture_config_id, config: original, raw_retention_hours: 24, aggregate_retention_days: 30 };
const configs = [structuredClone(initial)], drafts = [];
const placements = [{ id: original.placement_id, node_id: node, place_id: 'library', valid_from_ms: 0, valid_until_ms: null, effective_valid_until_ms: null }];
let desired = initial.id, rejectOnce = true, dropPlacement = true;
const writes = [], errors = [];
function device() { return { id: node, name: 'Synthetic configured device', board: 'Synthetic Passport', enabled: true, contact_state: 'recent', config_state: desired === initial.id ? 'applied' : 'pending', desired_config_id: desired, applied_config_id: initial.id, reported_config_id: initial.id }; }
async function routeCloud(route) {
  const request = route.request(), path = new URL(request.url()).pathname.slice('/api/v1/admin'.length), method = request.method(), body = request.postDataJSON();
  if (method !== 'GET') writes.push({ path, method, body });
  let result = {}, status = 200;
  if (path === '/auth/status') result = { initialized: true, passkeys_enabled: false };
  else if (path === '/session') result = { authenticated: true, role: 'admin', account: { username: 'synthetic', display_name: 'Synthetic' } };
  else if (path === '/overview') result = { devices_total: 1, devices_enabled: 1, devices_recent: 1, config_pending: 0, server_time: new Date().toISOString() };
  else if (path === '/settings') result = { settings: { default_raw_retention_hours: 24, default_aggregate_retention_days: 30 } };
  else if (path === '/places') result = { places: [{ id: 'library', name: 'Synthetic library' }, { id: 'gate', name: 'Synthetic gate' }] };
  else if (path === '/devices') result = { devices: [device()], next_cursor: null };
  else if (path === `/devices/${node}/batches`) result = { batches: [], next_cursor: null };
  else if (path === `/devices/${node}`) result = { device: device(), placements, configs, activation: { current: null, history: [] } };
  else if (path === `/devices/${node}/placements`) {
    assert.equal(method, 'POST'); assert.ok(!placements.some(p => p.id === body.id));
    for (const previous of placements) if (previous.effective_valid_until_ms === null) previous.effective_valid_until_ms = body.valid_from_ms;
    placements.unshift({ ...body, node_id: node, effective_valid_until_ms: null }); result = { placement: placements[0] };
    if (dropPlacement) { dropPlacement = false; return route.abort('failed'); }
  } else if (path === '/configs' && method === 'GET') result = { configs, drafts };
  else if (path === '/configs' && method === 'POST') { const draft = { ...structuredClone(body), id: body.config.capture_config_id, revision: 1 }; drafts.push(draft); result = { draft }; status = 201; }
  else if (/^\/configs\/[^/]+$/.test(path) && method === 'PUT') { const draft = drafts.find(d => d.id === path.split('/')[2]); assert.equal(draft.revision, body.revision); Object.assign(draft, structuredClone(body), { revision: draft.revision + 1 }); result = { draft }; }
  else if (path.endsWith('/validate')) {
    if (rejectOnce) { rejectOnce = false; status = 503; result = { error: { code: 'raw_storage_not_configured', message: 'Synthetic unavailable raw storage' } }; }
    else result = { valid: true };
  } else if (path.endsWith('/publish')) { const id = path.split('/')[2], index = drafts.findIndex(d => d.id === id); const draft = drafts[index]; assert.equal(draft.revision, body.revision); configs.unshift(structuredClone(draft)); drafts.splice(index, 1); desired = id; result = { desired_config_id: id }; }
  else throw Error(`Unexpected fixture path ${method} ${path}`);
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/api/v1/admin/**', routeCloud);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.name)); await page.goto(`${base}/admin`);
  const nav = label => page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: label, exact: true }).click();
  await nav('采集配置'); await page.getByRole('button', { name: '修改配置', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '修改采集配置并发布新版本', exact: true });
  assert.equal(await dialog.getByLabel('采集档位', { exact: true }).inputValue(), 'address_metrics');
  assert.equal(await dialog.getByLabel('汇总窗口（ms）', { exact: true }).inputValue(), String(original.summary.window_ms));
  assert.equal(await dialog.getByLabel('配置 ID', { exact: true }).isDisabled(), true);
  await dialog.getByLabel('扫描间隔（ms）', { exact: true }).fill('200');
  await dialog.getByLabel('汇总窗口（ms）', { exact: true }).fill('60000');
  await dialog.getByLabel('分箱时长（ms）', { exact: true }).fill('7000');
  await dialog.getByLabel('原始报告策略', { exact: true }).selectOption('sampled');
  assert.equal(await dialog.getByLabel('每窗口原始报告上限', { exact: true }).inputValue(), '4');
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).click();
  await dialog.getByRole('alert').waitFor(); assert.equal(writes.length, 0);
  await dialog.getByLabel('分箱时长（ms）', { exact: true }).fill('5000');
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).click();
  await dialog.getByText('错误代码：raw_storage_not_configured', { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('扫描间隔（ms）', { exact: true }).inputValue(), '200');
  await dialog.getByLabel('原始报告策略', { exact: true }).selectOption('off');
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); assert.equal(configs.length, 2); assert.equal(drafts.length, 0);
  assert.deepEqual(configs.find(c => c.id === initial.id).config, original);
  assert.deepEqual(configs[0].config.allowed_streams, ['ble_windows', 'address_summaries', 'node_status']);
  await nav('设备管理'); await page.getByRole('button', { name: `查看设备 ${node}`, exact: true }).click();
  await page.getByText('设备已应用版本', { exact: true }).waitFor(); await page.getByText('等待设备', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '修改位置', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '修改设备位置与采集配置', exact: true });
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).waitFor();
  await dialog.getByLabel('目标地点', { exact: true }).selectOption('gate');
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).click();
  await dialog.getByRole('alert').waitFor(); assert.equal(placements.length, 2); assert.equal(await dialog.getByLabel('目标地点', { exact: true }).inputValue(), 'gate');
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(configs.length, 3); assert.equal(placements.length, 2);
  assert.equal(writes.filter(w => w.path.endsWith('/placements')).length, 1);
  assert.equal(configs[0].config.placement_id, placements[0].id); assert.equal(placements[0].place_id, 'gate');
  assert.equal(configs[1].config.placement_id, original.placement_id);
  // An explicit unlocated choice must not fall back to the previous place after
  // a partial save; null is an intentional target, not an uninitialized form.
  await page.getByRole('button', { name: '修改位置', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '修改设备位置与采集配置', exact: true });
  await dialog.getByLabel('目标地点', { exact: true }).selectOption(''); dropPlacement = true;
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.getByLabel('目标地点', { exact: true }).inputValue(), '');
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); assert.equal(placements[0].place_id, null);
  assert.equal(writes.filter(w => w.path.endsWith('/placements')).length, 2);
  assert.equal(writes.some(w => w.path.includes('credential') || w.path === '/devices'), false);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '修改采集参数', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '修改采集配置并发布新版本', exact: true });
  await dialog.getByLabel('扫描间隔（ms）', { exact: true }).waitFor();
  const bounds = await dialog.boundingBox(); assert.ok(bounds.width <= 390 && bounds.x >= 0);
  assert.equal(await dialog.getByLabel('扫描间隔（ms）', { exact: true }).inputValue(), '200');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('Config editing browser fixture passed: v2 prefills/bounded raw, invalid-bin guard, correction after rejection, immutable history, desired/applied distinction, location retry after committed lost response, 390px form. No deployed API or hardware validation.');
} finally { await browser.close(); await server.close(); }
