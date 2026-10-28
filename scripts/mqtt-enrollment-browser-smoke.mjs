// Real Chromium UI; synthetic admin/broker API. No production access, physical
// devices, screenshots, saved browser state, or credential logging.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { MQTT_BROKER_URI } from '../src/admin/provisioning/mqtt.js';
const server = await createServer({ server: { host: '127.0.0.1', port: 18881, strictPort: true }, logLevel: 'error' });
await server.listen();
const origin = 'http://127.0.0.1:18881';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
const mqtt = { uri: MQTT_BROKER_URI, username: 'synthetic_pool', password: 'synthetic-mqtt-private-password', namespace: 'qa_pool' };
const token = `cpd_${'a'.repeat(64)}`, requests = [], entries = []; let generated = 0, registered = 0, verified = false, failedVerify = false;
const context = await browser.newContext({ acceptDownloads: true });
try {
  await context.route('**/api/v1/admin/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.slice('/api/v1/admin'.length), method = req.method(), body = req.postDataJSON(); requests.push({ path, method, body });
    let result = {}, status = 200;
    if (path === '/auth/status') result = { initialized: true, passkeys_enabled: false };
    else if (path === '/session') result = { authenticated: true, role: 'admin', account: { username: 'qa', display_name: 'QA' } };
    else if (path === '/overview') result = {};
    else if (path === '/devices' && method === 'GET') result = { devices: [], next_cursor: null };
    else if (path === '/devices' && method === 'POST') {
      if (!verified) { status = 503; result = { error: { code: 'mqtt_pool_empty' } }; }
      else { registered++; entries[0].state = 'assigned'; result = { device: { id: body.id }, credential: token, mqtt }; }
    } else if (path === '/mqtt/pool' && method === 'GET') result = { broker_uri: MQTT_BROKER_URI, ready_count: entries.filter(e => e.state === 'ready').length, entries };
    else if (path === '/mqtt/pool' && method === 'POST') {
      assert.deepEqual(body, { count: 2 }); generated++; entries.push({ id: 'synthetic-pool-1', state: 'pending_broker', verified_at: null, node_id: null });
      result = { entries, material: { authentication_csv: `username,password\n${mqtt.username},${mqtt.password}\n`, authorization_csv: `username,topic,action,access\n${mqtt.username},cp/v1/${mqtt.namespace}/+/req/+/+,pub,allow\n` } };
    } else if (path === '/mqtt/pool/synthetic-pool-1/verify') {
      if (!failedVerify) { failedVerify = true; status = 503; result = { error: { code: 'mqtt_broker_verify_failed' } }; }
      else { verified = true; Object.assign(entries[0], { state: 'ready', verified_at: new Date().toISOString() }); result = { entry: entries[0] }; }
    } else throw new Error('Unexpected synthetic API request');
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
  const page = await context.newPage(); await page.goto(`${origin}/admin`);
  await page.getByRole('button', { name: '设备管理', exact: true }).click();
  await page.getByLabel('本批独立账号数量（1–32）').fill('2');
  await page.getByRole('button', { name: '生成私密批量导入材料', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '一次性私密 MQTT 批量导入材料' }); await exportDialog.waitFor();
  assert.equal(generated, 1); assert(!(await page.locator('body').innerText()).includes(mqtt.password));
  for (const [label, header] of [['下载认证 CSV', 'username,password'], ['下载授权 CSV', 'username,topic,action,access']]) {
    const download = page.waitForEvent('download'); await exportDialog.getByRole('button', { name: label, exact: true }).click();
    const stream = await (await download).createReadStream(); let text = ''; for await (const chunk of stream) text += chunk;
    assert(text.startsWith(header)); if (header === 'username,password') assert(text.includes(mqtt.password));
  }
  await exportDialog.getByRole('checkbox').check(); await exportDialog.getByRole('button', { name: '关闭并清除本次材料' }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: '登记设备', exact: true }).click();
  const form = page.getByRole('dialog', { name: '登记新设备' });
  await form.getByLabel('设备 ID', { exact: true }).fill('cp_001122aabbcc'); await form.getByLabel('设备名称', { exact: true }).fill('Synthetic node'); await form.getByLabel('板型 / 硬件版本', { exact: true }).fill('Synthetic board');
  await form.getByRole('button', { name: '登记并生成凭证', exact: true }).click(); await form.getByText('MQTT 授权池中没有已验证的可用账号。', { exact: false }).waitFor(); assert.equal(registered, 0);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '已导入，验证此授权', exact: true }).click(); await page.getByText('MQTT 代理验证未通过', { exact: false }).waitFor(); assert.equal(verified, false);
  await page.getByRole('button', { name: '已导入，验证此授权', exact: true }).click(); await page.getByText('已验证 · 可分配', { exact: true }).waitFor();
  await page.getByRole('button', { name: '登记设备', exact: true }).click(); const retry = page.getByRole('dialog', { name: '登记新设备' });
  await retry.getByLabel('设备 ID', { exact: true }).fill('cp_001122aabbcc'); await retry.getByLabel('设备名称', { exact: true }).fill('Synthetic node'); await retry.getByLabel('板型 / 硬件版本', { exact: true }).fill('Synthetic board'); await retry.getByRole('button', { name: '登记并生成凭证', exact: true }).click();
  const credential = page.getByRole('dialog', { name: '一次性设备凭证' }); await credential.waitFor();
  const bundle = credential.getByLabel('现场 MQTT 配网材料', { exact: true }); assert.equal(await bundle.getAttribute('type'), 'password'); const handoff = JSON.parse(await bundle.inputValue()); assert.equal(handoff.v, 1); assert.equal(handoff.node_id, 'cp_001122aabbcc'); assert.match(handoff.attempt_id, /^[a-f0-9-]{36}$/); assert.equal(handoff.device_token, token); assert.deepEqual(handoff.mqtt, mqtt);
  const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie })); for (const secret of [token, mqtt.password, mqtt.username]) assert(!persisted.includes(secret));
  assert(!JSON.stringify(requests).includes(mqtt.password)); assert.equal(registered, 1); assert.equal(generated, 1);
  await credential.getByRole('button', { name: '已安全保存，关闭并清除' }).click(); assert.equal(await bundle.count(), 0);
  console.log('MQTT browser acceptance passed: one-time two-CSV private export, pending/failed/verified states, readiness registration gate, automatic assignment, masked provisioning bundle, and no browser-persistent secrets. Synthetic broker/API; no hardware acceptance.');
} finally { await context.close(); await browser.close(); await server.close(); }
