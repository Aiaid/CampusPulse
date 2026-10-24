import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { assertAdminViewVisible, installAdminCosmeticFilter } from './admin-cosmetic-filter-fixture.mjs';

// Real-browser acceptance against an isolated, migrated LOCAL Worker only.
// The script writes synthetic registry/configuration/settings rows. It never
// targets a deployed Worker and never prints credentials or takes screenshots.
const baseURL = process.env.ADMIN_SMOKE_URL || 'http://localhost:8796';
const target = new URL(baseURL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash, 'An isolated local Worker origin is required');
const envFile = process.env.ADMIN_SMOKE_ENV_FILE || '.dev.vars';
let privateEnv = '';
if (existsSync(envFile)) {
  assert.ok((statSync(envFile).mode & 0o077) === 0, 'The administrator env file must be private (mode 600)');
  privateEnv = readFileSync(envFile, 'utf8');
}
const configured = name => process.env[name] || privateEnv.match(new RegExp(`^${name}\\s*=\\s*(.+)\\s*$`, 'm'))?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
let token = process.env.ADMIN_SMOKE_TOKEN || configured('ADMIN_TOKEN');
if (!token) {
  assert.ok(existsSync(envFile), 'Set ADMIN_SMOKE_TOKEN or a private ADMIN_SMOKE_ENV_FILE');
}
assert.ok(token && token.length >= 16, 'An independent local ADMIN_TOKEN is required');
const username = configured('ADMIN_SMOKE_NEW_USERNAME') || configured('ADMIN_SMOKE_USERNAME') || 'synthetic-management-admin';
const password = configured('ADMIN_SMOKE_NEW_PASSWORD') || configured('ADMIN_SMOKE_PASSWORD') || 'synthetic-management-password-local-only';
const suffix = Date.now().toString(36);
const node = `qa-node-${suffix}`, place = `qa-place-${suffix}`, placement = `qa-placement-${suffix}`, config = `qa-config-${suffix}`;
const clonedConfig = `qa-config-next-${suffix}`;
const nodeName = `Synthetic browser QA node ${suffix}`, renamedNode = `Synthetic QA node renamed ${suffix}`, placeName = `Synthetic QA place ${suffix}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium'),
  headless: true, args: ['--no-sandbox'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await installAdminCosmeticFilter(context);
  // All APIs remain the real Worker. Prevent incidental external map/font calls.
  await context.route('**/*', route => new URL(route.request().url()).origin === target.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', () => errors.push('Browser runtime error'));
  async function result(action, path, method, expected = 200) {
    const received = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/admin${path}` && r.request().method() === method);
    await action();
    const response = await received;
    assert.equal(response.status(), expected, `${method} ${path} returned an unexpected status`);
    return response.json();
  }
  const nav = label => page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: label, exact: true }).click();
  // Synthetic device protocol requests use only the one-time device credential,
  // through the real local API. An applied response here is endpoint acceptance;
  // it does not establish firmware or physical-device activation.
  async function deviceRequest(path, credential, body) {
    return page.evaluate(async ({ path, credential, body }) => {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    }, { path, credential, body });
  }
  async function storageHasNoSecrets(secrets) {
    const values = await page.evaluate(async () => ({
      local: { ...localStorage }, session: { ...sessionStorage },
      visibleCookies: document.cookie,
      databases: typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [],
    }));
    const serialized = JSON.stringify(values);
    assert.ok(secrets.every(secret => !serialized.includes(secret)), 'Credentials must not enter browser persistent storage or readable cookies');
    assert.ok(!values.visibleCookies.includes('cp_admin_session'), 'Administrator cookie must be HttpOnly');
    assert.equal(values.databases.length, 0, 'This isolated administrator session must not create IndexedDB storage');
  }
  await page.goto(`${target.origin}/admin`);
  const authStatus = await page.evaluate(() => fetch('/api/v1/admin/auth/status').then(r => r.json()));
  if (!authStatus.initialized) {
    await page.getByLabel('初始化凭证', { exact: true }).fill(`synthetic-invalid-admin-${suffix}`);
    await result(() => page.getByRole('button', { name: '验证并初始化账号', exact: true }).click(), '/session', 'POST', 401);
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('初始化凭证', { exact: true }).inputValue(), '', 'Rejected bootstrap credential clears from the form');
    await page.getByLabel('初始化凭证', { exact: true }).fill(token);
    await result(() => page.getByRole('button', { name: '验证并初始化账号', exact: true }).click(), '/session', 'POST');
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('显示名称', { exact: true }).fill('Synthetic management administrator');
    await page.getByLabel('新密码', { exact: true }).fill(password);
    await page.getByLabel('确认新密码', { exact: true }).fill(password);
    await result(() => page.getByRole('button', { name: '创建管理员账号', exact: true }).click(), '/auth/setup', 'POST', 201);
  } else {
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill('synthetic-incorrect-password');
    await result(() => page.getByRole('button', { name: '账号密码登录', exact: true }).click(), '/session', 'POST', 401);
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '', 'Rejected login password clears from the form');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await result(() => page.getByRole('button', { name: '账号密码登录', exact: true }).click(), '/session', 'POST');
  }
  await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
  await assertAdminViewVisible(page, '运行概览', '设备联系');
  await nav('账号与安全');
  await assertAdminViewVisible(page, '账号与安全', '账号资料');
  await nav('运行概览');
  await storageHasNoSecrets([token, password]);
  const sessionCookie = (await context.cookies()).find(c => c.name === 'cp_admin_session');
  assert.ok(sessionCookie?.httpOnly && sessionCookie.sameSite === 'Strict' && sessionCookie.path === '/api/v1/admin', 'A scoped HttpOnly Strict cookie is required');

  await nav('设备管理');
  await page.getByRole('button', { name: '登记设备', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '登记新设备', exact: true });
  await dialog.getByLabel(/^设备 ID/).fill(node);
  await dialog.getByLabel('设备名称', { exact: true }).fill(nodeName);
  await dialog.getByLabel(/^板型 \/ 硬件版本/).fill('Synthetic ESP32-S3 / hardware unverified');
  const registered = await result(() => dialog.getByRole('button', { name: '登记并生成凭证', exact: true }).click(), '/devices', 'POST', 201);
  let deviceToken = registered.credential;
  const secrets = [token, password, deviceToken];
  assert.ok(typeof deviceToken === 'string' && deviceToken.length >= 16, 'Device registration must return a one-time credential');
  dialog = page.getByRole('dialog', { name: '一次性设备凭证', exact: true });
  await dialog.waitFor();
  assert.ok(await dialog.getByLabel('一次性设备凭证', { exact: true }).getAttribute('type') === 'password', 'One-time credential must start masked');
  await storageHasNoSecrets(secrets);
  await dialog.getByRole('button', { name: '已安全保存，关闭并清除', exact: true }).click();
  assert.equal(await page.getByLabel('一次性设备凭证', { exact: true }).count(), 0, 'Closing must remove the credential input');
  await page.getByRole('button', { name: `查看设备 ${node}`, exact: true }).click();
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '编辑设备资料', exact: true });
  await dialog.getByLabel('设备名称', { exact: true }).fill(renamedNode);
  await result(() => dialog.getByRole('button', { name: '保存资料', exact: true }).click(), `/devices/${node}`, 'PATCH');
  await page.getByRole('heading', { name: renamedNode, exact: true }).waitFor();

  await page.getByRole('button', { name: '轮换凭证', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '轮换设备凭证？', exact: true });
  const rotated = await result(() => dialog.getByRole('button', { name: '确认轮换', exact: true }).click(), `/devices/${node}/rotate-credential`, 'POST');
  const previousToken = deviceToken;
  deviceToken = rotated.credential;
  assert.ok(typeof deviceToken === 'string' && deviceToken !== previousToken, 'Rotation returns a fresh one-time credential');
  secrets.push(deviceToken);
  dialog = page.getByRole('dialog', { name: '一次性设备凭证', exact: true });
  await dialog.waitFor();
  assert.equal((await deviceRequest('/api/v1/device/config', previousToken)).status, 401, 'Old device credential is invalid immediately');
  assert.equal((await deviceRequest('/api/v1/device/config', deviceToken)).status, 403, 'New device credential authenticates but has no assigned policy');
  await storageHasNoSecrets(secrets);
  await dialog.getByRole('button', { name: '已安全保存，关闭并清除', exact: true }).click();
  await page.getByRole('button', { name: '停用设备', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '停用这台设备？', exact: true });
  await result(() => dialog.getByRole('button', { name: '确认停用', exact: true }).click(), `/devices/${node}`, 'PATCH');
  await page.getByRole('button', { name: '启用设备', exact: true }).waitFor();
  assert.equal((await deviceRequest('/api/v1/device/config', deviceToken)).status, 401, 'Disabled devices cannot authenticate');
  await page.getByRole('button', { name: '启用设备', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '启用这台设备？', exact: true });
  await result(() => dialog.getByRole('button', { name: '确认启用', exact: true }).click(), `/devices/${node}`, 'PATCH');
  await page.getByRole('button', { name: '停用设备', exact: true }).waitFor();
  assert.equal((await deviceRequest('/api/v1/device/config', deviceToken)).status, 403, 'Reenabled device authenticates while policy remains unassigned');

  await nav('地点与部署');
  await page.getByRole('button', { name: '新建地点', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新建地点', exact: true });
  await dialog.getByLabel('地点 ID', { exact: true }).fill(place);
  await dialog.getByLabel('地点名称', { exact: true }).fill(placeName);
  await dialog.getByLabel('观测类型', { exact: true }).selectOption('activity');
  await dialog.getByLabel('锚点 x（0–1）', { exact: true }).fill('0.4');
  await dialog.getByLabel('锚点 y（0–1）', { exact: true }).fill('0.6');
  await result(() => dialog.getByRole('button', { name: '保存地点', exact: true }).click(), '/places', 'POST', 201);
  await page.getByRole('button', { name: `编辑地点 ${placeName}`, exact: true }).waitFor();
  await nav('设备管理');
  await page.getByRole('button', { name: `查看设备 ${node}`, exact: true }).click();
  await page.getByRole('button', { name: '登记位置变更', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '登记位置变更', exact: true });
  await dialog.getByLabel(/^新部署 ID/).fill(placement);
  await dialog.getByLabel('目标地点', { exact: true }).selectOption(place);
  await dialog.getByRole('button', { name: '检查并登记', exact: true }).click();
  const confirmPlacement = page.getByRole('dialog', { name: '确认部署变更', exact: true });
  await result(() => confirmPlacement.getByRole('button', { name: '确认登记位置', exact: true }).click(), `/devices/${node}/placements`, 'POST', 201);
  await page.getByRole('cell', { name: placement, exact: true }).waitFor();

  await nav('采集配置');
  await page.getByRole('button', { name: '新建草稿', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新建采集配置草稿', exact: true });
  await dialog.getByLabel(/^配置 ID/).fill(config);
  await dialog.getByLabel('设备', { exact: true }).selectOption(node);
  await dialog.getByLabel(/^部署 ID/).selectOption(placement);
  await dialog.getByLabel('数据集', { exact: true }).selectOption('demo');
  await dialog.getByLabel(/^适配器版本/).fill('synthetic-browser-v1');
  const createdDraft = await result(() => dialog.getByRole('button', { name: '创建草稿', exact: true }).click(), '/configs', 'POST', 201);
  assert.equal(createdDraft.draft.revision, 1, 'Initial draft revision');
  let row = page.getByRole('row').filter({ has: page.getByText(config, { exact: true }) });
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  dialog = page.getByRole('dialog', { name: `编辑草稿 ${config}`, exact: true });
  await dialog.getByLabel('扫描窗口（ms）', { exact: false }).fill('70');
  const updatedDraft = await result(() => dialog.getByRole('button', { name: '保存草稿修改', exact: true }).click(), `/configs/${config}`, 'PUT');
  assert.equal(updatedDraft.draft.revision, 2, 'Draft edit increments revision');
  row = page.getByRole('row').filter({ has: page.getByText(config, { exact: true }) });
  await result(() => row.getByRole('button', { name: '验证', exact: true }).click(), `/configs/${config}/validate`, 'POST');
  await row.getByRole('button', { name: '发布', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '发布采集配置？', exact: true });
  const published = await result(() => dialog.getByRole('button', { name: '确认发布此版本', exact: true }).click(), `/configs/${config}/publish`, 'POST');
  assert.equal(published.desired_config_id, config, 'Publishing assigns the desired version');
  await page.getByRole('row').filter({ has: page.getByText(config, { exact: true }) }).getByText('等待设备', { exact: true }).waitFor();
  const original = await deviceRequest(`/api/v1/device/config?capture_config_id=${config}`, deviceToken);
  assert.equal(original.status, 200, 'Original published policy remains fetchable by exact ID');
  assert.equal(original.body.config.scan.window_ms, 70, 'Original policy contains its published scan window');

  row = page.getByRole('row').filter({ has: page.getByText(config, { exact: true }) });
  await row.getByRole('button', { name: '复制新草稿', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '复制为新配置草稿', exact: true });
  await dialog.getByLabel(/^配置 ID/).fill(clonedConfig);
  await dialog.getByLabel('扫描窗口（ms）', { exact: false }).fill('60');
  const clone = await result(() => dialog.getByRole('button', { name: '创建草稿', exact: true }).click(), '/configs', 'POST', 201);
  assert.ok(clone.draft.id === clonedConfig && clone.draft.id !== config, 'Cloning creates a separate draft ID');
  row = page.getByRole('row').filter({ has: page.getByText(clonedConfig, { exact: true }) });
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  dialog = page.getByRole('dialog', { name: `编辑草稿 ${clonedConfig}`, exact: true });
  await dialog.getByLabel('扫描窗口（ms）', { exact: false }).fill('50');
  const editedClone = await result(() => dialog.getByRole('button', { name: '保存草稿修改', exact: true }).click(), `/configs/${clonedConfig}`, 'PUT');
  assert.equal(editedClone.draft.revision, 2, 'Cloned draft is independently editable');
  row = page.getByRole('row').filter({ has: page.getByText(clonedConfig, { exact: true }) });
  await row.getByRole('button', { name: '发布', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '发布采集配置？', exact: true });
  await result(() => dialog.getByRole('button', { name: '确认发布此版本', exact: true }).click(), `/configs/${clonedConfig}/publish`, 'POST');
  await page.getByRole('row').filter({ has: page.getByText(clonedConfig, { exact: true }) }).getByText('等待设备', { exact: true }).waitFor();
  await page.getByRole('row').filter({ has: page.getByText(config, { exact: true }) }).getByText('历史版本', { exact: true }).waitFor();
  const desired = await deviceRequest('/api/v1/device/config', deviceToken);
  assert.equal(desired.status, 200, 'Device fetches its desired policy');
  assert.equal(desired.body.config.capture_config_id, clonedConfig, 'Desired pointer changes to the new published clone');
  assert.equal(desired.body.config.scan.window_ms, 50, 'New desired policy includes independent draft edits');
  const historical = await deviceRequest(`/api/v1/device/config?capture_config_id=${config}`, deviceToken);
  assert.equal(historical.status, 200, 'Historical exact policy lookup remains compatible');
  assert.deepEqual(historical.body.config, original.body.config, 'Publishing the edited clone preserves the original policy');
  assert.deepEqual(historical.body.retention, original.body.retention, 'Publishing the clone preserves original retention policy');
  const activation = await deviceRequest('/api/v1/device/config/ack', deviceToken, { capture_config_id: clonedConfig, state: 'applied', message: 'synthetic-browser-fixture' });
  assert.equal(activation.status, 200, 'Synthetic device activation ACK is accepted');
  assert.equal(activation.body.capture_config_id, clonedConfig, 'Synthetic ACK is associated with the desired version');
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByRole('row').filter({ has: page.getByText(clonedConfig, { exact: true }) }).getByText('设备确认应用', { exact: true }).waitFor();

  await nav('站点设置');
  await page.getByLabel('站点名称', { exact: true }).fill(`Synthetic browser QA ${suffix}`);
  await page.getByLabel('新手动记录有效时长（分钟）', { exact: false }).fill('2');
  await result(() => page.getByRole('button', { name: '保存站点设置', exact: true }).click(), '/settings', 'PUT');
  await page.reload();
  await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
  await assertAdminViewVisible(page, '运行概览', '设备联系');
  await nav('站点设置');
  assert.equal(await page.getByLabel('站点名称', { exact: true }).inputValue(), `Synthetic browser QA ${suffix}`, 'Settings survive browser refresh');
  const publicSettings = await page.evaluate(() => fetch('/api/v1/settings').then(r => r.json()));
  assert.deepEqual(Object.keys(publicSettings).sort(), ['default_mode', 'site_name'], 'Public settings expose no administrator controls');
  await nav('操作审计');
  await page.getByRole('row').filter({ hasText: 'config.publish' }).filter({ hasText: config }).waitFor();
  const auditText = await page.locator('body').innerText();
  assert.ok(secrets.every(secret => !auditText.includes(secret)), 'Audit must not reveal any old or current credential');
  await storageHasNoSecrets(secrets);
  await page.setViewportSize({ width: 390, height: 844 });
  await nav('运行概览');
  await assertAdminViewVisible(page, '运行概览', '设备联系');
  await nav('账号与安全');
  await assertAdminViewVisible(page, '账号与安全', '账号资料');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Administrator phone layout must not overflow horizontally');
  await nav('设备管理');
  const deviceRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: `查看设备 ${node}`, exact: true }) });
  await deviceRow.waitFor();
  const rowBox = await deviceRow.boundingBox();
  assert.ok(rowBox && rowBox.height < 220, 'Phone device row must remain readable instead of wrapping one character per line');
  const tableLayout = await deviceRow.evaluate(row => {
    const scroll = row.closest('.cp-admin-table-scroll');
    const table = row.closest('table');
    return { innerScrolls: !!scroll && scroll.scrollWidth > scroll.clientWidth, tableWidth: table?.getBoundingClientRect().width ?? 0, viewport: innerWidth, globalWidth: document.documentElement.scrollWidth };
  });
  assert.ok(tableLayout.innerScrolls && tableLayout.tableWidth > tableLayout.viewport && tableLayout.globalWidth <= tableLayout.viewport, 'Wide phone tables must scroll inside their container');
  await page.getByRole('button', { name: `查看设备 ${node}`, exact: true }).click();
  await page.getByRole('heading', { name: renamedNode, exact: true }).waitFor();
  await page.locator('.cp-admin-three-values').getByText('设备确认应用', { exact: true }).waitFor();
  await page.getByText('synthetic-browser-fixture', { exact: true }).first().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Device details fit phone width');
  await result(() => page.getByRole('button', { name: '退出登录', exact: true }).click(), '/session', 'DELETE');
  await page.getByLabel('密码', { exact: true }).waitFor();
  const signedOut = await page.evaluate(() => fetch('/api/v1/admin/devices').then(r => r.status));
  assert.equal(signedOut, 401, 'Logout revokes administrator access');
  await storageHasNoSecrets(secrets);
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Admin browser smoke passed against isolated local Worker: failed/corrected login, credential rotation, disable/reenable, device/place/placement, draft edit/validate/publish/clone, original policy preservation, synthetic ACK UI, persisted settings, audit, logout, phone table layout and desktop/phone overview/account visibility under controlled generic cosmetic filters. Synthetic ACK acceptance does not establish physical activation.');
} finally { await browser.close(); }
