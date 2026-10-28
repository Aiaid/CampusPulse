// Synthetic local acceptance against real workerd/D1. No production writes,
// hardware access, screenshots, saved credentials or inference claims.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';

const bootstrap = 'synthetic-purpose-bootstrap', operator = 'synthetic-purpose-operator';
const deviceToken = 'synthetic-purpose-device', password = 'synthetic-purpose-password';
const source = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'] });
const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, host: '127.0.0.1', workers: [{ name: 'place-purposes', modules: true,
  script: source.outputFiles[0].text, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: 'single-page-application' } },
  bindings: { ADMIN_TOKEN: bootstrap, OPERATOR_TOKEN: operator },
}] }));
let browser;
try {
  const base = (await mf.ready).origin, db = await mf.getD1Database('DB');
  for (const name of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort()) await db.exec(readFileSync(`migrations/${name}`, 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  const config = JSON.parse(readFileSync('docs/specs/examples/capture-config-v2.fixture.json', 'utf8'));
  config.accept_until = new Date(Date.now() + 86400000).toISOString();
  const node = config.node_id, original = structuredClone(config), allKinds = ['activity', 'parking', 'elevator'];
  const digest = createHash('sha256').update(deviceToken).digest('hex');
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256,name,board) VALUES(?,?,?,?)').bind(node, digest, 'Synthetic purpose Passport', 'Synthetic unverified board').run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)').bind(config.placement_id, node, 'library', 0).run();
  await db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)').bind(config.capture_config_id, node, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until)).run();
  for (const table of ['config_assignments', 'device_desired_configs']) await db.prepare(`INSERT INTO ${table}(node_id,capture_config_id,assigned_at) VALUES(?,?,?)`).bind(node, config.capture_config_id, new Date().toISOString()).run();
  const request = async (path, body, token) => {
    const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}) } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.equal(response.status < 300, true, `Synthetic API ${path}: ${response.status} ${JSON.stringify(result.error || {})}`); return result;
  };
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.name));
  page.setDefaultTimeout(15000);
  await page.goto(`${base}/admin`);
  await page.getByLabel('初始化凭证', { exact: true }).fill(bootstrap);
  await page.getByRole('button', { name: '验证并初始化账号', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill('purposes-admin');
  await page.getByLabel('显示名称', { exact: true }).fill('Synthetic administrator');
  await page.getByLabel('新密码', { exact: true }).fill(password);
  await page.getByLabel('确认新密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建管理员账号', exact: true }).click();
  const nav = label => page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: label, exact: true }).click();
  await nav('地点与部署');
  await page.getByRole('button', { name: '新建地点', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新建地点', exact: true });
  await dialog.getByLabel('地点 ID', { exact: true }).fill('multi-point');
  await dialog.getByLabel('地点名称', { exact: true }).fill('Synthetic shared point');
  for (const name of ['活动监测', '电动车监控', '电梯观测']) await dialog.getByRole('checkbox', { name, exact: true }).check();
  await dialog.getByRole('button', { name: '保存地点', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual((await request('/api/v1/places')).places.find(p => p.id === 'multi-point').observation_kinds, allKinds);
  const parking = { id: randomUUID(), place_id: 'multi-point', kind: 'parking', observed_at: new Date(Date.now() - 20 * 60000).toISOString(), parking_min: 3, parking_max: 5 };
  const elevator = { id: randomUUID(), place_id: 'multi-point', kind: 'elevator', observed_at: new Date().toISOString(), wait_seconds: 42 };
  await request('/api/v1/observations', parking, operator); await request('/api/v1/observations', elevator, operator);
  const summary = await request('/api/v1/places/multi-point/summary');
  assert.equal(summary.latest_observations.parking.id, parking.id); assert.equal(summary.latest_observations.elevator.id, elevator.id);
  assert.ok(Date.parse(summary.latest_observations.parking.valid_until) < Date.now());
  assert.ok(Date.parse(summary.latest_observations.elevator.valid_until) > Date.now());

  await nav('设备管理');
  await page.getByRole('button', { name: `查看设备 ${node}`, exact: true }).click();
  await page.getByRole('button', { name: '修改地点与工作方式', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: '修改地点与工作方式', exact: true });
  await dialog.getByLabel('目标地点', { exact: true }).selectOption('multi-point');
  for (const name of ['活动监测', '电动车监控', '电梯观测']) await dialog.getByRole('checkbox', { name, exact: true }).check();
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  let stored = await db.prepare('SELECT c.config_json,p.observation_kinds_json FROM device_desired_configs d JOIN capture_configs c ON c.id=d.capture_config_id JOIN placements p ON p.id=c.placement_id WHERE d.node_id=?').bind(node).first();
  const assigned = JSON.parse(stored.config_json), firstPlacement = assigned.placement_id;
  assert.deepEqual(JSON.parse(stored.observation_kinds_json), allKinds); assert.equal('observation_kinds' in assigned, false);
  assert.deepEqual(assigned.raw_capture, { mode: 'off' });
  await page.getByText('等待设备', { exact: true }).first().waitFor();
  const boot = randomUUID();
  await request('/api/v2/device/contact', { protocol: 'campuspulse/2', boot_id: boot, contact_seq: 1, firmware_version: 'synthetic-purpose-device', uptime_ms: 1000, wifi_state: 'connected', capture_state: 'unassigned', applied_config_id: null }, deviceToken);
  await request('/api/v2/device/config/ack', { capture_config_id: assigned.capture_config_id, boot_id: boot, apply_seq: 1, state: 'applied' }, deviceToken);
  await page.goto(`${base}/admin`); await nav('设备管理'); await page.getByRole('button', { name: `查看设备 ${node}`, exact: true }).click();
  await page.getByText('设备确认应用', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '修改地点与工作方式', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: '修改地点与工作方式', exact: true });
  await expect(dialog.getByLabel('目标地点', { exact: true })).toHaveValue('multi-point');
  await dialog.getByRole('checkbox', { name: '电梯观测', exact: true }).uncheck();
  await dialog.getByRole('button', { name: '保存并发布新版本', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  stored = await db.prepare('SELECT c.config_json,p.observation_kinds_json FROM device_desired_configs d JOIN capture_configs c ON c.id=d.capture_config_id JOIN placements p ON p.id=c.placement_id WHERE d.node_id=?').bind(node).first();
  assert.notEqual(JSON.parse(stored.config_json).placement_id, firstPlacement);
  assert.deepEqual(JSON.parse(stored.observation_kinds_json), ['activity', 'parking']);
  assert.deepEqual(JSON.parse((await db.prepare('SELECT observation_kinds_json FROM placements WHERE id=?').bind(firstPlacement).first()).observation_kinds_json), allKinds);
  assert.deepEqual(JSON.parse((await db.prepare('SELECT config_json FROM capture_configs WHERE id=?').bind(original.capture_config_id).first()).config_json), original);
  assert.equal((await db.prepare('SELECT credential_sha256 FROM device_nodes WHERE id=?').bind(node).first()).credential_sha256, digest);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '修改地点与工作方式', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: '修改地点与工作方式', exact: true });
  await expect(dialog.getByRole('checkbox', { name: '电梯观测', exact: true })).not.toBeChecked();
  assert.equal(await dialog.evaluate(el => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth), true);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();

  await page.goto(`${base}/?mode=field`);
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '现场观察与记录', exact: true });
  await dialog.getByLabel('记录地点', { exact: true }).selectOption('multi-point');
  await expect(dialog.getByRole('article', { name: '电动车监控 · 最新人工记录', exact: true })).toContainText('历史观察');
  await expect(dialog.getByRole('article', { name: '电梯观测 · 最新人工记录', exact: true })).toContainText('有效观察');
  await dialog.getByLabel('记录类型', { exact: true }).selectOption('parking');
  await dialog.getByLabel('最少（辆）', { exact: true }).fill('4'); await dialog.getByLabel('最多（辆）', { exact: true }).fill('6');
  await dialog.getByLabel('操作员凭据', { exact: true }).fill(operator);
  await dialog.getByRole('button', { name: '提交并确认', exact: true }).click();
  await expect(dialog.getByRole('article', { name: '电动车监控 · 最新人工记录', exact: true })).toContainText('4–6 辆');
  await dialog.getByLabel('记录类型', { exact: true }).selectOption('elevator');
  await dialog.getByLabel('本次实测等待（秒）', { exact: true }).fill('37');
  await dialog.getByRole('button', { name: '提交并确认', exact: true }).click();
  await expect(dialog.getByRole('article', { name: '电梯观测 · 最新人工记录', exact: true })).toContainText('37 秒');
  await expect(dialog.getByRole('article', { name: '电动车监控 · 最新人工记录', exact: true })).toContainText('4–6 辆');
  const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  for (const secret of [bootstrap, operator, deviceToken, password]) assert.ok(!persisted.includes(secret));
  assert.deepEqual(errors, []);
  console.log('Place-purpose browser acceptance passed: real ephemeral workerd/D1, multi-purpose site, independent manual expiry, direct relocation and same-place purpose changes, retained history, explicit simulated device ACK, desktop/mobile forms. No production/hardware acceptance.');
} finally { await browser?.close(); await mf.dispose(); }
