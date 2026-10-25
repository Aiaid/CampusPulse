// Real browser + ephemeral workerd D1/R2. Only synthetic data; no deployment,
// hardware access, production sessions, screenshots or credential logging.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium } from '@playwright/test';
const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = name => JSON.parse(readFileSync(`docs/specs/examples/${name}.json`, 'utf8'));
const source = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*'] });
const bootstrap = 'synthetic-diagnostics-admin-only', deviceToken = 'synthetic-diagnostics-device-only';
const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, host: '127.0.0.1', workers: [{ name: 'diagnostics-browser', modules: true,
  script: source.outputFiles[0].text, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['RAW_BUCKET'],
  assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: 'single-page-application' } },
  bindings: { ADMIN_TOKEN: bootstrap },
}] }));
let browser;
try {
  const base = (await mf.ready).origin;
  const db = await mf.getD1Database('DB');
  for (const name of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort()) await db.exec(readFileSync(`migrations/${name}`, 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  const config = fixture('capture-config-v2.fixture'); config.accept_until = new Date(Date.now() + 86400000).toISOString();
  const node = config.node_id;
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256,name,board) VALUES(?,?,?,?)').bind(node, hash(deviceToken), 'Synthetic diagnostic Passport', 'Synthetic board · unverified').run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)').bind(config.placement_id, node, 'library', 0).run();
  const seed = async c => db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)').bind(c.capture_config_id, node, c.placement_id, c.dataset, JSON.stringify(c), Date.parse(c.accept_until)).run();
  await seed(config);
  await db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').bind(node, config.capture_config_id, new Date().toISOString()).run();
  await db.prepare('INSERT INTO device_desired_configs(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').bind(node, config.capture_config_id, new Date().toISOString()).run();
  const legacy = fixture('capture-config.fixture'); legacy.accept_until = config.accept_until; await seed(legacy);
  const upload = async (batch, version = 2) => {
    const bytes = JSON.stringify(batch, null, 2) + '\n';
    const response = await fetch(`${base}/api/v${version}/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json', 'X-Body-SHA256': hash(bytes) }, body: bytes });
    assert.equal(response.status, 200, JSON.stringify(await response.json())); return bytes;
  };
  const status = fixture('node-status-v2.request');
  status.items[0].raw_capture_state = 'off'; status.items[0].scan_state = 'paused';
  status.items[0].buffer_health.pause_reason = 'memory_pressure'; status.items[0].loss_totals.aggregation_drops = 711;
  await upload(status); await upload(fixture('ble-windows-v2.request')); await upload(fixture('address-summaries-v2.request'));
  const raw = fixture('ble-reports.request'); const exact = await upload(raw, 1);
  // A newer control boot must not relabel the old uploaded state as live.
  const contact = { ...fixture('device-contact-v2.request'), boot_id: randomUUID() };
  const response = await fetch(`${base}/api/v2/device/contact`, { method: 'POST', headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(contact) }); assert.equal(response.status, 200);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.name));
  await page.goto(`${base}/admin`);
  await page.getByLabel('初始化凭证', { exact: true }).fill(bootstrap);
  await page.getByRole('button', { name: '验证并初始化账号', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill('diagnostics-admin');
  await page.getByLabel('显示名称', { exact: true }).fill('Synthetic administrator');
  await page.getByLabel('新密码', { exact: true }).fill('synthetic-local-diagnostics-password');
  await page.getByLabel('确认新密码', { exact: true }).fill('synthetic-local-diagnostics-password');
  await page.getByRole('button', { name: '创建管理员账号', exact: true }).click();
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '设备管理', exact: true }).click();
  await page.getByRole('button', { name: `查看设备 ${node}`, exact: true }).click();
  await page.getByRole('heading', { name: '连接与数据新鲜度', exact: true }).waitFor();
  await page.getByText('旧启动状态', { exact: true }).first().waitFor();
  await page.getByText('内存不足，扫描自动暂停', { exact: true }).waitFor();
  await page.getByText('711', { exact: true }).waitFor();
  const loss = page.locator('.cp-diagnostic-losses');
  assert.match(await loss.innerText(), /未持久化窗口报告[\s\S]*未上报/);
  await page.getByRole('heading', { name: '服务器已接收的上传批次', exact: true }).waitFor();
  await page.getByLabel('筛选上传流').selectOption('address_summaries');
  const summaryId = fixture('address-summaries-v2.request').batch_id;
  await page.getByRole('button', { name: `查看批次 ${summaryId}` }).click();
  let dialog = page.getByRole('dialog', { name: '上传批次内容' });
  await dialog.getByLabel('数据库投影内容').waitFor();
  assert.match(await dialog.getByLabel('数据库投影内容').innerText(), /02:00:00:00:00:01/);
  await dialog.getByText('未保存请求原文', { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('已校验的原始请求').count(), 0);
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  await page.getByLabel('筛选上传流').selectOption('ble_reports');
  await page.getByRole('button', { name: `查看批次 ${raw.batch_id}` }).click();
  dialog = page.getByRole('dialog', { name: '上传批次内容' });
  await dialog.getByLabel('已校验的原始请求').waitFor();
  assert.equal(await dialog.getByLabel('已校验的原始请求').textContent(), exact);
  await dialog.getByRole('button', { name: '关闭对话框' }).click();
  // Actual mobile layout must remain usable without page-wide horizontal scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: `查看批次 ${raw.batch_id}` }).click();
  dialog = page.getByRole('dialog', { name: '上传批次内容' });
  await dialog.getByLabel('已校验的原始请求').waitFor();
  assert.equal(await dialog.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth && el.getBoundingClientRect().left >= 0), true);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  for (const secret of [bootstrap, deviceToken, 'synthetic-local-diagnostics-password']) assert.ok(!stored.includes(secret));
  assert.deepEqual(errors, []);
  console.log('Device diagnostics browser acceptance passed: real ephemeral workerd D1/R2, admin login, old boot, memory reason, unknown counters, summary projection, exact raw bytes, mobile layout, no persistent credentials.');
} finally { await browser?.close(); await mf.dispose(); }
