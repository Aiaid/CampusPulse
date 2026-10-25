import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { assertAdminViewVisible, installAdminCosmeticFilter } from './admin-cosmetic-filter-fixture.mjs';

// Mutates only a fresh, isolated LOCAL Worker. Real navigator.credentials
// ceremonies run through Chromium's CTAP2 virtual authenticator and the actual
// Worker/SimpleWebAuthn verifier; no authentication response is mocked.
// No screenshots, persisted browser state, credential exports or secret logs.
const target = new URL(process.env.ADMIN_SMOKE_URL || 'http://localhost:8796');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash, 'An isolated local Worker origin is required');
const envFile = process.env.ADMIN_SMOKE_ENV_FILE || '.dev.vars';
let privateEnv = '';
if (existsSync(envFile)) {
  assert.ok((statSync(envFile).mode & 0o077) === 0, 'The authentication QA environment file must be private (mode 600)');
  privateEnv = readFileSync(envFile, 'utf8');
}
const configured = name => process.env[name] || privateEnv.match(new RegExp(`^${name}\\s*=\\s*(.+)\\s*$`, 'm'))?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
const token = process.env.ADMIN_SMOKE_TOKEN || configured('ADMIN_TOKEN');
const username = configured('ADMIN_SMOKE_USERNAME'), password = configured('ADMIN_SMOKE_PASSWORD');
const newUsername = configured('ADMIN_SMOKE_NEW_USERNAME'), newPassword = configured('ADMIN_SMOKE_NEW_PASSWORD');
assert.ok(token?.length >= 16 && username && newUsername && username !== newUsername && password?.length >= 12 && newPassword?.length >= 12 && password !== newPassword, 'Provide independent synthetic bootstrap and initial/replacement account values in the private QA environment');
const secrets = [token, password, newPassword];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium'), headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await installAdminCosmeticFilter(context);
  await context.route('**/*', route => new URL(route.request().url()).origin === target.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', () => errors.push('Browser runtime error'));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  async function result(action, path, method, expected = 200) {
    const received = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/admin${path}` && r.request().method() === method);
    await action(); const response = await received;
    assert.equal(response.status(), expected, `${method} ${path} returned an unexpected status`);
    return response.json();
  }
  const nav = label => page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: label, exact: true }).click();
  async function api(path, method = 'GET', body) {
    return page.evaluate(async ({ path, method, body }) => {
      const response = await fetch(`/api/v1/admin${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }, { path, method, body });
  }
  async function privateStorage() {
    const values = await page.evaluate(async () => ({ local: { ...localStorage }, session: { ...sessionStorage }, visibleCookies: document.cookie, databases: typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [] }));
    const serialized = JSON.stringify(values);
    assert.ok(secrets.every(secret => !serialized.includes(secret)), 'Authentication material must not enter browser storage');
    assert.ok(!values.visibleCookies.includes('cp_admin_'), 'Authentication cookies must be HttpOnly');
    assert.equal(values.databases.length, 0, 'Admin authentication must not create IndexedDB storage');
  }
  async function login(user, pass, expected = 200) {
    await page.getByLabel('用户名', { exact: true }).fill(user);
    await page.getByLabel('密码', { exact: true }).fill(pass);
    await result(() => page.getByRole('button', { name: '账号密码登录', exact: true }).click(), '/session', 'POST', expected);
    if (expected === 200) await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
    else assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '', 'Failed login must clear the password');
  }
  async function logout() {
    await result(() => page.getByRole('button', { name: '退出登录', exact: true }).click(), '/session', 'DELETE');
    await page.getByLabel('密码', { exact: true }).waitFor();
  }
  async function reauth(method = 'password', pass = password, verifyWrongPassword = false) {
    await page.getByRole('button', { name: '再次验证身份', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '再次验证身份', exact: true });
    if (method === 'password') {
      if (verifyWrongPassword) {
        await dialog.getByLabel('当前密码', { exact: true }).fill('synthetic-incorrect-reauth-password');
        await result(() => dialog.getByRole('button', { name: '使用密码验证', exact: true }).click(), '/auth/reauth', 'POST', 401);
        await dialog.getByRole('alert').waitFor();
        assert.equal((await api('/session')).status, 200, 'Incorrect reauthentication preserves the valid account session');
        assert.equal(await dialog.getByLabel('当前密码', { exact: true }).inputValue(), '', 'Incorrect reauthentication clears the password field');
      }
      await dialog.getByLabel('当前密码', { exact: true }).fill(pass);
      await result(() => dialog.getByRole('button', { name: '使用密码验证', exact: true }).click(), '/auth/reauth', 'POST');
    } else await result(() => dialog.getByRole('button', { name: '使用 Passkey 验证', exact: true }).click(), '/passkeys/authentication/verify', 'POST');
    await dialog.waitFor({ state: 'detached' });
  }
  await page.goto(`${target.origin}/admin`);
  assert.equal((await api('/auth/status')).body.initialized, false, 'Authentication smoke requires fresh isolated state');
  await page.getByLabel('初始化凭证', { exact: true }).fill('synthetic-invalid-bootstrap');
  await result(() => page.getByRole('button', { name: '验证并初始化账号', exact: true }).click(), '/session', 'POST', 401);
  assert.equal(await page.getByLabel('初始化凭证', { exact: true }).inputValue(), '', 'Invalid bootstrap token clears');
  await page.getByLabel('初始化凭证', { exact: true }).fill(token);
  await result(() => page.getByRole('button', { name: '验证并初始化账号', exact: true }).click(), '/session', 'POST');
  assert.equal((await api('/devices')).status, 403, 'Bootstrap cannot read management data');
  assert.equal(await page.getByRole('navigation', { name: '管理导航' }).count(), 0, 'Bootstrap exposes only setup');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('显示名称', { exact: true }).fill('Synthetic authentication QA');
  await page.getByLabel('新密码', { exact: true }).fill(password);
  await page.getByLabel('确认新密码', { exact: true }).fill(password);
  const setup = await result(() => page.getByRole('button', { name: '创建管理员账号', exact: true }).click(), '/auth/setup', 'POST', 201);
  const accountID = setup.account.id;
  await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
  await assertAdminViewVisible(page, '运行概览', '设备联系');
  assert.equal((await api('/session', 'POST', { token })).status, 401, 'Bootstrap token loses authority after setup');
  const sessionCookie = (await context.cookies()).find(c => c.name === 'cp_admin_session');
  assert.ok(sessionCookie?.httpOnly && sessionCookie.sameSite === 'Strict' && sessionCookie.path === '/api/v1/admin', 'Scoped HttpOnly Strict session required');
  await privateStorage();
  await logout();
  await login(username, 'synthetic-wrong-password', 401);
  await login(username, password);
  await nav('账号与安全');
  await assertAdminViewVisible(page, '账号与安全', '账号资料');
  await reauth('password', password, true);
  // Exercise optional-extension omission with a real CTAP2 credential. Only
  // unsigned client extension reports change; the Worker verifies the original
  // authenticator/client data and all later signatures normally.
  let omittedRegistrationExtensions = 0;
  await context.route(`${target.origin}/api/v1/admin/passkeys/registration/verify`, async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.response.clientExtensionResults?.credProps?.rk, true, 'Virtual authenticator must create a resident credential');
    delete body.response.clientExtensionResults;
    omittedRegistrationExtensions++;
    await route.continue({ postData: JSON.stringify(body) });
  }, { times: 1 });
  await page.getByRole('button', { name: '登记 Passkey', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '登记新的 Passkey', exact: true });
  await dialog.getByLabel('Passkey 名称', { exact: true }).fill('Synthetic local CTAP2 key');
  const registered = await result(() => dialog.getByRole('button', { name: '登记 Passkey', exact: true }).click(), '/passkeys/registration/verify', 'POST', 201);
  assert.equal(omittedRegistrationExtensions, 1, 'Registration must reach the real Worker with omitted extension reports');
  const keyID = registered.passkey.id;
  await page.getByRole('button', { name: '重命名 Passkey Synthetic local CTAP2 key', exact: true }).waitFor();
  // The virtual authenticator's credential count is inspected without exporting
  // its private key through CDP getCredentials.
  assert.equal((await api('/passkeys')).body.passkeys.length, 1, 'Real browser credential persisted on server');
  await logout();
  await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBogusSignature: true });
  await result(() => page.getByRole('button', { name: '使用 Passkey 登录', exact: true }).click(), '/passkeys/authentication/verify', 'POST', 400);
  await page.getByRole('alert').waitFor();
  assert.equal((await api('/devices')).status, 401, 'A browser assertion with a corrupt signature cannot authenticate');
  await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBogusSignature: false });
  await result(() => page.getByRole('button', { name: '使用 Passkey 登录', exact: true }).click(), '/passkeys/authentication/verify', 'POST');
  await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
  await nav('账号与安全');
  await reauth('passkey');
  await page.getByLabel('用户名', { exact: true }).fill(newUsername);
  await page.getByLabel('显示名称', { exact: true }).fill('Renamed synthetic authentication QA');
  const renamed = await result(() => page.getByRole('button', { name: '保存账号资料', exact: true }).click(), '/account', 'PATCH');
  assert.equal(renamed.account.id, accountID, 'Account rename preserves stable identity');
  await page.getByRole('button', { name: '重命名 Passkey Synthetic local CTAP2 key', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '重命名 Passkey', exact: true });
  await dialog.getByLabel('Passkey 名称', { exact: true }).fill('Renamed synthetic key');
  await result(() => dialog.getByRole('button', { name: '保存 Passkey 名称', exact: true }).click(), `/passkeys/${keyID}`, 'PATCH');
  await page.getByRole('button', { name: '删除 Passkey Renamed synthetic key', exact: true }).waitFor();
  // Keep a second real server session to verify password rotation revokes all.
  const other = await browser.newContext();
  const otherLogin = await other.request.post(`${target.origin}/api/v1/admin/session`, { headers: { Origin: target.origin }, data: { username: newUsername, password } });
  assert.equal(otherLogin.status(), 200, 'Second account session opens');
  await page.getByLabel('新密码', { exact: true }).fill(newPassword);
  await page.getByLabel('确认新密码', { exact: true }).fill(newPassword);
  await page.getByLabel('我了解修改密码将退出所有管理会话', { exact: true }).check();
  await result(() => page.getByRole('button', { name: '修改密码并退出所有会话', exact: true }).click(), '/account/password', 'PUT');
  await page.getByLabel('密码', { exact: true }).waitFor();
  assert.equal((await other.request.get(`${target.origin}/api/v1/admin/session`)).status(), 401, 'Password rotation revokes another browser session');
  await other.close();
  await login(newUsername, password, 401);
  // Existing key remains bound after both username and password changes.
  await result(() => page.getByRole('button', { name: '使用 Passkey 登录', exact: true }).click(), '/passkeys/authentication/verify', 'POST');
  await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
  await nav('账号与安全');
  await reauth('password', newPassword);
  await page.setViewportSize({ width: 390, height: 844 });
  await nav('运行概览');
  await assertAdminViewVisible(page, '运行概览', '设备联系');
  await nav('账号与安全');
  await assertAdminViewVisible(page, '账号与安全', '账号资料');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Security page fits phone width');
  await page.getByRole('button', { name: '删除 Passkey Renamed synthetic key', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '删除这个 Passkey？', exact: true });
  await result(() => dialog.getByRole('button', { name: '确认删除 Passkey', exact: true }).click(), `/passkeys/${keyID}`, 'DELETE');
  await page.getByRole('heading', { name: '还没有登记 Passkey', exact: true }).waitFor();
  await logout();
  // The authenticator still has its private credential, so this is a signed
  // assertion rejected by the real server after credential removal.
  await result(() => page.getByRole('button', { name: '使用 Passkey 登录', exact: true }).click(), '/passkeys/authentication/verify', 'POST', 400);
  await page.getByRole('alert').waitFor();
  assert.equal((await api('/devices')).status, 401, 'Removed key never creates an administrator session');
  await login(newUsername, newPassword);
  await nav('操作审计');
  await page.getByRole('row').filter({ hasText: 'passkey.delete' }).waitFor();
  const auditText = await page.locator('body').innerText();
  assert.ok(secrets.every(secret => !auditText.includes(secret)), 'Audit contains no bootstrap/password material');
  await privateStorage();
  await logout();
  assert.deepEqual(errors, [], 'No browser runtime errors');
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  console.log('Admin auth browser smoke passed against isolated local Worker: restricted bootstrap, account setup, password login, real CTAP2 resident UV Passkey registration/login/reauth, account/key rename, password change, all-session revocation, retained key login, key deletion denial, password fallback, audit secrecy, scoped cookies, phone layout and desktop/phone overview/account visibility under controlled generic cosmetic filters. Virtual authenticator acceptance does not validate physical biometric hardware.');
} finally { await browser.close(); }
