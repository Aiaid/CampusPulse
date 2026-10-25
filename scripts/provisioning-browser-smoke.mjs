import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { createPeer, TEST_NODE, TEST_PROOF, TEST_TOKEN, TEST_NONCE } from '../tests/provisioning/device-peer.mjs';
import { provisionConfig } from '../src/admin/provisioning/enrollment.js';
// Real Chromium/WebKit UI and WebCrypto/Web Streams, synthetic cloud/GATT/USB.
// No production requests, hardware operation, screenshots or credential output.
const server = await createServer({ server: { host: '127.0.0.1', port: 18879, strictPort: true }, logLevel: 'error' });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const binary = process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const browser = await chromium.launch({ headless: true, executablePath: binary });
function fixture(existing = false) {
  const placement = { id: 'existing-placement', place_id: 'synthetic-place', valid_from_ms: Date.now() - 60000, effective_valid_until_ms: null };
  const config = existing ? provisionConfig(TEST_NODE, placement.id, 'existing-config') : null;
  return { registered: existing, placement: existing ? placement : null, config, published: config ? [config] : [], drafts: [], placementHistory: existing ? [placement] : [],
    contact: false, ack: false, registrations: 0, rotations: 0, placements: 0, configs: 0, publishes: 0, bodies: [], dropRegistration: false, conflictRegistration: false, dropRotation: false, dropInfoAfterRotation: false,
    candidate: null, usbState: 'waiting', nonce: TEST_NONCE, savedCredential: existing, wifiModes: 7, operations: [], dropConfigure: false, configureCalls: 0 };
}
async function setup(context, state) {
  context.setDefaultTimeout(15000);
  await context.route('**/api/v1/admin/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/v1/admin'.length), body = request.postDataJSON(); if (body) state.bodies.push(body);
    let result = {}, status = 200;
    if (path === '/auth/status') result = { initialized: true, passkeys_enabled: false };
    else if (path === '/session') result = { authenticated: true, role: 'admin', account: { username: 'synthetic', display_name: 'Synthetic test' } };
    else if (path === '/overview') result = { devices_total: 0, devices_enabled: 0, devices_recent: 0, devices_stale: 0, config_pending: 0, server_time: new Date().toISOString() };
    else if (path === '/places') result = { places: [{ id: 'synthetic-place', name: 'Synthetic location' }, { id: 'synthetic-alternate', name: 'Synthetic alternate location' }] };
    else if (path === '/devices' && request.method() === 'POST') {
      state.registrations++; state.registered = true;
      if (state.dropRegistration) { state.dropRegistration = false; return route.abort('failed'); }
      if (state.conflictRegistration) { state.conflictRegistration = false; status = 409; result = { error: { code: 'revision_conflict' } }; }
      else result = { device: { id: TEST_NODE }, credential: TEST_TOKEN };
    } else if (path === '/devices') result = { devices: [], next_cursor: null };
    else if (path.endsWith('/rotate-credential')) {
      state.rotations++;
      if (state.dropRotation) { state.dropRotation = false; return route.abort('failed'); }
      if (state.dropInfoAfterRotation) { state.dropInfoAfterRotation = false; state.dropInfo = true; }
      result = { credential: TEST_TOKEN };
    }
    else if (path.endsWith('/placements')) {
      state.placements++; state.placement = structuredClone(body); state.placementHistory.push(state.placement); result = { placement: state.placement };
    }
    else if (path === `/devices/${TEST_NODE}`) {
      if (!state.registered) { status = 404; result = { error: { code: 'device_not_found' } }; }
      else result = { device: { id: TEST_NODE, name: 'Synthetic existing node', enabled: true, desired_config_id: state.config?.capture_config_id || null,
        applied_config_id: state.config?.capture_config_id || null, config_state: state.config ? 'applied' : 'unassigned', latest_control: state.contact ? { received_at: new Date().toISOString(), boot_id: 'test-boot', capture_state: 'scanning' } : null },
        placements: state.placementHistory, configs: state.published.map(config => ({ id: config.capture_config_id, config, raw_retention_hours: 24, aggregate_retention_days: 30 })),
        activation: { current: state.config ? { capture_config_id: state.config.capture_config_id, state: 'applied', boot_id: 'test-boot', received_at: new Date(state.ack ? Date.now() : Date.now() - 86400000).toISOString() } : null } };
    } else if (path === '/configs' && request.method() === 'POST') {
      state.configs++; const draft = { ...structuredClone(body), id: body.config.capture_config_id, revision: 1 }; state.drafts.push(draft); result = { draft };
    }
    else if (path === '/configs') result = { drafts: state.drafts, configs: state.published.map(config => ({ id: config.capture_config_id, config, raw_retention_hours: 24, aggregate_retention_days: 30 })) };
    else if (path.endsWith('/validate')) result = { valid: true };
    else if (path.endsWith('/publish')) {
      const id = path.split('/')[2], draft = state.drafts.find(draft => draft.id === id); assert(draft, 'Published an unknown draft');
      state.publishes++; state.config = structuredClone(draft.config); state.published.push(state.config); state.drafts = state.drafts.filter(draft => draft.id !== id);
      result = { desired_config_id: id };
    }
    else throw Error(`Unexpected synthetic API path ${path}`);
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
}
async function openWizard(context) {
  const page = await context.newPage(); await page.goto(`${base}/admin`);
  await page.getByRole('button', { name: '设备管理', exact: true }).click();
  await page.getByRole('button', { name: '连接并部署设备', exact: true }).click(); return page;
}
async function installBle(context, state) {
  const peer = createPeer(request => { state.candidate = request; state.contact = true; state.ack = true; });
  await context.exposeBinding('syntheticGatt', (_, kind, bytes) => peer(kind, bytes));
  await context.addInitScript(() => {
    let connected = false; const replies = new Map(), device = new EventTarget(); window.syntheticGesture = false; window.syntheticBleRequests = 0; device.id = 'opaque-browser-id';
    device.gatt = { get connected() { return connected; }, disconnect() { connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); }, async connect() { connected = true; return { getPrimaryService: async () => ({ getCharacteristic: async uuid => ({ writeValueWithResponse: async bytes => { replies.set(uuid, await window.syntheticGatt(uuid, Array.from(bytes))); }, readValue: async () => new DataView(Uint8Array.from(replies.get(uuid)).buffer) }) }) }; } };
    Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice() { window.syntheticBleRequests++; window.syntheticGesture = navigator.userActivation.isActive; return Promise.resolve(device); } } });
  });
}
async function installUsb(context, state, disableBle = true) {
  await context.exposeBinding('syntheticUsb', (_, bytes) => {
    const text = new TextDecoder().decode(Uint8Array.from(bytes)); assert(text.startsWith('\x1eCPSETUP/1 '));
    const id = text.slice(11, 47), request = JSON.parse(text.slice(48)); state.operations.push(request.op); let result;
    if (request.op === 'begin') { state.usbState = 'waiting'; result = { v: 1, ok: true, state: 'starting' }; }
    else if (request.op === 'info') {
      if (state.dropInfo) { state.dropInfo = false; return []; }
      result = { v: 1, ok: true, node_id: state.infoNode || TEST_NODE, board: 'Synthetic headless board', transport: 'usb', security: 'physical-usb', nonce: state.nonce, state: state.usbState,
        ...(state.savedCredential === undefined ? {} : { has_saved_credential: state.savedCredential }), ...(state.wifiModes === undefined ? {} : { wifi_modes: state.wifiModes }) };
    }
    else if (request.op === 'configure') {
      assert.equal(request.nonce, state.nonce); state.configureCalls++; state.candidate = request; state.usbState = 'testing';
      if (state.dropConfigure) { state.dropConfigure = false; return []; }
      result = { v: 1, ok: true, state: 'testing', attempt_id: request.attempt_id };
    } else if (request.op === 'status') result = { v: 1, ok: true, node_id: TEST_NODE, state: state.usbState, attempt_id: state.omitStatusAttempt ? undefined : state.statusAttempt || state.candidate?.attempt_id,
      has_saved_credential: state.savedCredential, ...(state.previousAttempt ? { previous_attempt: state.previousAttempt } : {}), diagnostic: { stage: state.usbState === 'failed' ? 'wifi_connect' : state.usbState === 'saved' ? 'saved' : state.usbState === 'idle' ? 'idle' : 'clock', code: state.usbState === 'failed' ? 'wifi_auth_failed' : state.usbState === 'saved' ? 'saved' : state.usbState === 'idle' ? 'idle' : 'clock_wait', esp_err: state.usbState === 'failed' ? 263 : 0, http_status: 0, wifi_reason: state.usbState === 'failed' ? 202 : 0, elapsed_ms: 12000, retryable: true, ssid: 'MUST-NOT-EXPOSE', password: 'MUST-NOT-EXPOSE', eap_username: 'MUST-NOT-EXPOSE', eap_identity: 'MUST-NOT-EXPOSE', eap_password: 'MUST-NOT-EXPOSE' } };
    else throw Error('Unexpected synthetic USB operation');
    return Array.from(new TextEncoder().encode('unrelated boot log\n' + `\x1eCPSETUP/1 ${id} ${JSON.stringify(result)}\n`));
  });
  await context.addInitScript(({ disableBle }) => {
    if (disableBle) Object.defineProperty(navigator, 'bluetooth', { value: undefined });
    window.syntheticUsbGesture = false;
    const makePort = () => ({ async open() { let controller; this.readable = new ReadableStream({ start(c) { controller = c; } }); this.writable = new WritableStream({ async write(data) { const reply = Uint8Array.from(await window.syntheticUsb(Array.from(data))); if (reply.length) { controller.enqueue(reply.subarray(0, 8)); controller.enqueue(reply.subarray(8)); } } }); }, async close() {} });
    Object.defineProperty(navigator, 'serial', { value: { requestPort() { window.syntheticUsbGesture = navigator.userActivation.isActive; return Promise.resolve(makePort()); } } });
  }, { disableBle });
}
async function unsupported(context) { await context.addInitScript(() => { Object.defineProperty(navigator, 'bluetooth', { value: undefined }); Object.defineProperty(navigator, 'serial', { value: undefined }); }); }
async function firstRegistration(page) {
  await page.getByLabel('设备名称', { exact: true }).fill('Synthetic new node');
  await page.getByRole('button', { name: '首次登记并取得设备凭证' }).click();
  await page.getByText('设备凭证已准备，仅保留于当前向导。').waitFor();
}
async function saveSettings(page) {
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '保存配置' && !button.matches(':disabled')));
  assert.equal(await page.getByRole('alert').count(), 0, 'Saving settings failed');
}
async function existingUsbNetwork(state = fixture(true)) {
  const context = await browser.newContext(); await setup(context, state); await installUsb(context, state);
  const page = await openWizard(context); await page.getByRole('button', { name: '选择 USB 设备并开始配网' }).click();
  try { await page.getByText('已登记设备 · Synthetic existing node').waitFor(); }
  catch (error) { error.message += ` (scenario=${state.scenario || 'existing'}, USB operations=${state.operations.join(',')})`; throw error; }
  await saveSettings(page);
  return { context, page, state };
}
async function assertNetworkSecretsLocal(page, state, secrets) {
  const cloud = JSON.stringify(state.bodies), storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const secret of [TEST_TOKEN, ...secrets]) { assert(!cloud.includes(secret), 'Network secret entered a cloud request'); assert(!storage.includes(secret), 'Network secret entered browser storage'); }
  assert.equal(state.registrations, 0); assert.equal(state.rotations, 0); assert.equal(state.placements, 0); assert.equal(state.configs, 0);
}
try {
  // New BLE node: actual WebCrypto, wrong PIN cleared, automatic cloud lookup.
  const newState = fixture(), bleContext = await browser.newContext(); await setup(bleContext, newState); await installBle(bleContext, newState);
  const ble = await openWizard(bleContext); await ble.getByLabel('设备屏幕上的配网码', { exact: true }).fill('99999999'); await ble.getByRole('button', { name: '选择蓝牙设备并验证' }).click(); await ble.getByRole('alert').waitFor(); assert.equal(await ble.getByLabel('设备屏幕上的配网码', { exact: true }).inputValue(), '');
  await ble.getByLabel('设备屏幕上的配网码', { exact: true }).fill(TEST_PROOF); await ble.getByRole('button', { name: '选择蓝牙设备并验证' }).click(); await ble.getByText('（已验证身份）', { exact: false }).waitFor(); assert.equal(await ble.evaluate(() => window.syntheticGesture), true);
  await firstRegistration(ble); await ble.getByLabel('部署地点').selectOption('synthetic-place'); await ble.getByRole('button', { name: '保存配置' }).click();
  await ble.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-ssid'); await ble.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-password'); await ble.getByRole('button', { name: '加密发送给设备' }).click(); await ble.getByRole('button', { name: '完成并返回设备目录' }).waitFor({ timeout: 15000 });
  assert.equal(newState.candidate.device_token, TEST_TOKEN); assert.equal(newState.registrations, 1); assert.equal(newState.rotations, 0); assert(!JSON.stringify(newState.bodies).includes('synthetic-password')); assert(!JSON.stringify(newState.bodies).includes(TEST_TOKEN));
  const bleRequests = await ble.evaluate(() => window.syntheticBleRequests); await ble.getByRole('button', { name: '重新配置网络', exact: true }).click();
  await ble.getByText('请在设备上开始新配网，输入新显示的配网码后连接同一台设备。', { exact: true }).waitFor();
  assert.equal(await ble.getByLabel('设备屏幕上的配网码', { exact: true }).inputValue(), ''); assert.equal(await ble.evaluate(() => window.syntheticBleRequests), bleRequests);
  assert.equal(await ble.getByLabel('Wi-Fi SSID', { exact: true }).isEnabled(), true); assert.equal(await ble.getByRole('button', { name: '加密发送给设备', exact: true }).isDisabled(), true);
  await bleContext.close();
  // Prepared settings remain ordinary editable fields. Each changed save moves
  // desired configuration forward while retaining every immutable old config;
  // saving unchanged values performs no placement/draft/publish writes.
  const editableNetwork = await existingUsbNetwork(), editable = editableNetwork.page, editableState = editableNetwork.state;
  const originalConfig = structuredClone(editableState.config), originalPlacement = structuredClone(editableState.placement);
  assert.equal(await editable.getByLabel('部署地点', { exact: true }).inputValue(), 'synthetic-place');
  assert.equal(await editable.getByLabel('数据用途', { exact: true }).inputValue(), 'controlled_test');
  assert.equal(await editable.locator('input[name="config-choice"]').count(), 0);
  assert.equal(await editable.getByRole('button', { name: '登记位置并发布配置', exact: true }).count(), 0);
  assert.equal(editableState.configs, 0); assert.equal(editableState.publishes, 0); assert.equal(editableState.placements, 0);
  await editable.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-edit-ssid'); await editable.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-edit-secret');
  await editable.getByLabel('部署地点', { exact: true }).selectOption('synthetic-alternate'); await editable.getByLabel('数据用途', { exact: true }).selectOption('field');
  assert.equal(await editable.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).isDisabled(), true);
  await saveSettings(editable); const firstEditedId = editableState.config.capture_config_id;
  assert.notEqual(firstEditedId, originalConfig.capture_config_id); assert.equal(editableState.config.dataset, 'field');
  assert.equal(editableState.placement.place_id, 'synthetic-alternate'); assert.equal(editableState.config.placement_id, editableState.placement.id);
  assert.deepEqual(editableState.published[0], originalConfig); assert.deepEqual(editableState.placementHistory[0], originalPlacement);
  assert.equal(editableState.configs, 1); assert.equal(editableState.publishes, 1);
  await saveSettings(editable); assert.equal(editableState.configs, 1); assert.equal(editableState.publishes, 1); assert.equal(editableState.placements, 1);
  const firstEditedConfig = structuredClone(editableState.config);
  await editable.getByLabel('数据用途', { exact: true }).selectOption('controlled_test');
  assert.equal(await editable.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).isDisabled(), true);
  await saveSettings(editable); assert.notEqual(editableState.config.capture_config_id, firstEditedId); assert.equal(editableState.config.dataset, 'controlled_test');
  assert.deepEqual(editableState.published[1], firstEditedConfig); assert.equal(editableState.published.length, 3); assert.equal(editableState.publishes, 2);
  const afterEdits = { configs: editableState.configs, placements: editableState.placements, publishes: editableState.publishes };
  await saveSettings(editable); for (const key of Object.keys(afterEdits)) assert.equal(editableState[key], afterEdits[key]);
  assert.equal(await editable.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).isEnabled(), true);
  const externalConfig = { ...structuredClone(editableState.config), capture_config_id: 'external-current-config', dataset: 'field' };
  editableState.config = externalConfig; editableState.published.push(externalConfig);
  await editable.getByRole('button', { name: '重新检查登记状态', exact: true }).click(); await editable.locator('.cp-provision[aria-busy="false"]').waitFor();
  assert.equal(await editable.getByLabel('数据用途', { exact: true }).inputValue(), 'field');
  await saveSettings(editable); assert.equal(editableState.config.capture_config_id, 'external-current-config'); assert.equal(editableState.publishes, afterEdits.publishes);
  await editable.getByLabel('数据用途', { exact: true }).selectOption('controlled_test');
  await editable.getByRole('button', { name: '重新检查登记状态', exact: true }).click(); await editable.locator('.cp-provision[aria-busy="false"]').waitFor();
  assert.equal(await editable.getByLabel('数据用途', { exact: true }).inputValue(), 'controlled_test'); assert.equal(await editable.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).isDisabled(), true);
  assert.equal(editableState.registrations, 0); assert.equal(editableState.rotations, 0); await editableNetwork.context.close();
  // Explicit absence on the physical node makes the network action prepare a
  // replacement credential. Editing and saving settings alone never rotates it.
  const missingState = fixture(true); missingState.savedCredential = false;
  const missingContext = await browser.newContext(); await setup(missingContext, missingState); await installUsb(missingContext, missingState);
  const missing = await openWizard(missingContext); await missing.getByRole('button', { name: '选择 USB 设备并开始配网' }).click(); await missing.getByText('已登记设备 · Synthetic existing node').waitFor();
  await missing.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-missing-ssid'); await missing.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-missing-secret');
  await missing.getByLabel('部署地点', { exact: true }).selectOption('synthetic-alternate'); await missing.getByLabel('数据用途', { exact: true }).selectOption('field');
  assert.equal(await missing.getByRole('button', { name: '重新授权并连接 Wi-Fi', exact: true }).isDisabled(), true); await saveSettings(missing);
  assert.equal(missingState.config.dataset, 'field'); assert.equal(missingState.placement.place_id, 'synthetic-alternate');
  await missing.getByRole('button', { name: '重新授权并连接 Wi-Fi', exact: true }).waitFor();
  assert.equal(await missing.getByRole('button', { name: '重新授权并连接 Wi-Fi', exact: true }).isEnabled(), true);
  assert.match(await missing.locator('fieldset').last().textContent(), /旧凭证.*失效/);
  assert.equal(missingState.configureCalls, 0); assert.equal(missingState.registrations, 0); assert.equal(missingState.rotations, 0);
  for (const secret of ['synthetic-missing-ssid', 'synthetic-missing-secret']) assert(!JSON.stringify(missingState.bodies).includes(secret));
  await missing.getByRole('button', { name: '重新授权并连接 Wi-Fi', exact: true }).click(); await missing.getByText('设备正在验证', { exact: true }).waitFor();
  assert.equal(missingState.rotations, 1); assert.equal(missingState.registrations, 0); assert.equal(missingState.configureCalls, 1);
  assert.equal(missingState.candidate.device_token, TEST_TOKEN); assert.equal(missingState.candidate.reuse_saved_credential, undefined);
  const replacementAttempt = missingState.candidate.attempt_id;
  missingState.usbState = 'failed'; missingState.nonce = 'ef'.repeat(16);
  await missing.getByText('本次验证失败', { exact: true }).waitFor();
  await missing.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-corrected-secret');
  await missing.getByRole('button', { name: '使用修正后的 Wi-Fi 重试', exact: true }).click(); await missing.getByText('设备正在验证', { exact: true }).waitFor();
  assert.equal(missingState.rotations, 1); assert.equal(missingState.configureCalls, 2); assert.equal(missingState.candidate.device_token, TEST_TOKEN); assert.notEqual(missingState.candidate.attempt_id, replacementAttempt);
  assert.equal(missingState.candidate.nonce, missingState.nonce);
  const missingStorage = await missing.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const secret of [TEST_TOKEN, 'synthetic-missing-ssid', 'synthetic-missing-secret', 'synthetic-corrected-secret']) { assert(!JSON.stringify(missingState.bodies).includes(secret)); assert(!missingStorage.includes(secret)); }
  await missingContext.close();
  // Re-read the same physical factory identity before issuing a replacement.
  // A newly available saved credential uses the internal path with no rotation;
  // a different node or invalid local Wi-Fi never reaches the cloud mutation.
  for (const scenario of ['saved', 'different-node', 'unknown', 'unready', 'invalid-wifi', 'oversized-enterprise']) {
    const state = fixture(true); state.savedCredential = false; state.scenario = scenario;
    const network = await existingUsbNetwork(state), page = network.page;
    await page.getByLabel('Wi-Fi SSID', { exact: true }).fill(scenario === 'invalid-wifi' ? 's'.repeat(33) : 'synthetic-recovery-ssid');
    await page.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-recovery-secret');
    if (scenario === 'oversized-enterprise') {
      await page.getByLabel('Wi-Fi 认证方式', { exact: true }).selectOption('enterprise');
      await page.getByLabel('Wi-Fi SSID', { exact: true }).fill('"'.repeat(32));
      await page.getByLabel('企业认证用户名', { exact: true }).fill('"'.repeat(128));
      await page.getByLabel('企业认证密码', { exact: true }).fill('"'.repeat(128));
      await page.getByLabel('外层身份（可选）', { exact: true }).fill('"'.repeat(128));
    }
    if (scenario === 'saved') state.savedCredential = true;
    if (scenario === 'different-node') state.infoNode = 'cp_ffeeddccbbaa';
    if (scenario === 'unknown') state.savedCredential = undefined;
    if (scenario === 'unready') state.usbState = 'testing';
    await page.getByRole('button', { name: '重新授权并连接 Wi-Fi', exact: true }).click();
    if (scenario === 'saved') {
      await page.getByText('设备正在验证', { exact: true }).waitFor();
      assert.equal(state.configureCalls, 1); assert.equal(state.candidate.reuse_saved_credential, true); assert.equal(state.candidate.device_token, undefined);
    } else { await page.getByRole('alert').waitFor(); assert.equal(state.configureCalls, 0); }
    await assertNetworkSecretsLocal(page, state, ['synthetic-recovery-ssid', 'synthetic-recovery-secret']);
    await network.context.close();
  }
  // Capability omission is unknown, so it cannot offer automatic issuance.
  const unknownCredentialState = fixture(true); unknownCredentialState.savedCredential = undefined;
  const unknownCredential = await existingUsbNetwork(unknownCredentialState);
  assert.equal(await unknownCredential.page.getByRole('button', { name: '重新授权并连接 Wi-Fi', exact: true }).count(), 0);
  assert.equal(await unknownCredential.page.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).isDisabled(), true);
  assert.equal(unknownCredentialState.rotations, 0); await unknownCredential.context.close();
  // A returned replacement survives a local preflight that did not send a
  // candidate. Retrying uses that in-memory token rather than issuing again.
  const notSentState = fixture(true); notSentState.savedCredential = false; notSentState.dropInfoAfterRotation = true;
  const notSent = await existingUsbNetwork(notSentState);
  await notSent.page.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-preflight-ssid'); await notSent.page.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-preflight-secret');
  await notSent.page.getByRole('button', { name: '重新授权并连接 Wi-Fi', exact: true }).click(); await notSent.page.getByRole('alert').waitFor({ timeout: 15000 });
  assert.equal(notSentState.rotations, 1); assert.equal(notSentState.configureCalls, 0);
  await notSent.page.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).click(); await notSent.page.getByText('设备正在验证', { exact: true }).waitFor();
  assert.equal(notSentState.rotations, 1); assert.equal(notSentState.configureCalls, 1); assert.equal(notSentState.candidate.device_token, TEST_TOKEN); await notSent.context.close();
  // Once a rotation request may have reached the server, a lost response must
  // block another issuance, including after a harmless registration refresh.
  const uncertainState = fixture(true); uncertainState.savedCredential = false; uncertainState.dropRotation = true;
  const uncertain = await existingUsbNetwork(uncertainState);
  await uncertain.page.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-uncertain-ssid'); await uncertain.page.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-uncertain-secret');
  await uncertain.page.getByRole('button', { name: '重新授权并连接 Wi-Fi', exact: true }).click(); await uncertain.page.getByRole('alert').waitFor();
  assert.equal(uncertainState.rotations, 1); assert.equal(uncertainState.configureCalls, 0);
  await uncertain.page.getByRole('button', { name: '重新检查登记状态', exact: true }).click(); await uncertain.page.locator('.cp-provision[aria-busy="false"]').waitFor();
  assert.equal(await uncertain.page.getByRole('button', { name: '重新授权并连接 Wi-Fi', exact: true }).count(), 0);
  assert.equal(await uncertain.page.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).isDisabled(), true);
  assert.equal(uncertainState.rotations, 1); assert.equal(uncertainState.configureCalls, 0); await uncertain.context.close();
  // An expired desired policy still supplies the editable form. Saving renews
  // it while preserving its selected use and placement rather than defaults.
  const expiredState = fixture(true); expiredState.config.dataset = 'field'; expiredState.config.accept_until = new Date(Date.now() - 60000).toISOString(); expiredState.placement.place_id = 'synthetic-alternate';
  const expiredContext = await browser.newContext(); await setup(expiredContext, expiredState); await installUsb(expiredContext, expiredState);
  const expired = await openWizard(expiredContext); await expired.getByRole('button', { name: '选择 USB 设备并开始配网' }).click(); await expired.getByText('已登记设备 · Synthetic existing node').waitFor();
  assert.equal(await expired.getByLabel('部署地点', { exact: true }).inputValue(), 'synthetic-alternate'); assert.equal(await expired.getByLabel('数据用途', { exact: true }).inputValue(), 'field');
  assert.equal(await expired.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).isDisabled(), true);
  await saveSettings(expired); assert.equal(expiredState.config.dataset, 'field'); assert.equal(expiredState.config.placement_id, 'existing-placement'); assert(Date.parse(expiredState.config.accept_until) > Date.now());
  assert.equal(expiredState.publishes, 1); await expiredContext.close();
  // Existing USB node: preserve identity, saved credential, placement and config.
  const saved = fixture(true), usbContext = await browser.newContext(); saved.dropConfigure = true; await setup(usbContext, saved); await installUsb(usbContext, saved);
  const usb = await openWizard(usbContext); await usb.getByRole('button', { name: '选择 USB 设备并开始配网' }).click(); await usb.getByText('已登记设备 · Synthetic existing node').waitFor(); assert.equal(await usb.evaluate(() => window.syntheticUsbGesture), true);
  assert.equal(await usb.getByRole('button', { name: '首次登记并取得设备凭证' }).count(), 0); assert.equal(await usb.getByRole('radio', { name: /保留设备内现有凭证/ }).isChecked(), true);
  await saveSettings(usb); await usb.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-usb-ssid'); await usb.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-usb-password'); await usb.getByRole('button', { name: '通过 USB 发送给设备' }).click();
  // The write has left the browser but its reply is intentionally lost. Until
  // status resolves it, settings and network secrets cannot be changed.
  assert.equal(await usb.getByLabel('Wi-Fi SSID', { exact: true }).isDisabled(), true);
  assert.equal(await usb.getByLabel('部署地点', { exact: true }).isDisabled(), true);
  await usb.getByRole('alert').waitFor({ timeout: 15000 }); await usb.getByText('设备正在验证', { exact: true }).waitFor(); assert.equal(saved.configureCalls, 1); assert.equal(saved.candidate.device_token, undefined); assert.equal(saved.candidate.reuse_saved_credential, true);
  assert.equal(await usb.getByLabel('Wi-Fi SSID', { exact: true }).isDisabled(), true); assert.equal(await usb.getByLabel('数据用途', { exact: true }).isDisabled(), true);
  // An old attempt's terminal status cannot authorize editing or a new write
  // while the current lost-response attempt remains uncertain.
  saved.statusAttempt = '00000000-0000-4000-8000-000000000001'; saved.usbState = 'failed';
  await usb.getByRole('button', { name: '读取设备阶段与诊断', exact: true }).click(); await usb.locator('.cp-provision[aria-busy="false"]').waitFor();
  assert.equal(await usb.getByLabel('Wi-Fi SSID', { exact: true }).isDisabled(), true); assert.equal(await usb.getByLabel('部署地点', { exact: true }).isDisabled(), true);
  assert.equal(await usb.getByRole('button', { name: '使用修正后的 Wi-Fi 重试', exact: true }).count(), 0);
  saved.statusAttempt = null; saved.usbState = 'testing';
  const previousAttempt = saved.candidate.attempt_id; saved.usbState = 'failed'; saved.nonce = 'cd'.repeat(16);
  await usb.getByText('本次验证失败', { exact: true }).waitFor(); await usb.getByText('Wi-Fi 认证失败', { exact: true }).waitFor(); assert.equal(await usb.getByLabel('Wi-Fi SSID', { exact: true }).inputValue(), 'synthetic-usb-ssid');
  await usb.getByText('安全诊断详情', { exact: true }).click(); assert(!(await usb.locator('.cp-provision-diagnostic').textContent()).includes('MUST-NOT-EXPOSE'));
  await usb.getByLabel('Wi-Fi 密码', { exact: true }).fill('corrected-password'); await usb.getByRole('button', { name: '使用修正后的 Wi-Fi 重试' }).click(); await usb.getByText('设备正在验证', { exact: true }).waitFor(); assert.notEqual(saved.candidate.attempt_id, previousAttempt); assert.equal(saved.candidate.nonce, saved.nonce); assert.equal(saved.candidate.reuse_saved_credential, true);
  assert.equal(saved.registrations, 0); assert.equal(saved.rotations, 0); assert.equal(saved.placements, 0); assert.equal(saved.configs, 0);
  saved.contact = true; await usb.getByRole('button', { name: '检查云端状态', exact: true }).click(); assert.equal(await usb.getByRole('button', { name: '完成并返回设备目录' }).count(), 0);
  saved.usbState = 'saved'; saved.savedCredential = true; saved.ack = true; await usb.getByRole('button', { name: '检查云端状态', exact: true }).click(); await usb.getByRole('button', { name: '完成并返回设备目录' }).waitFor();
  assert.equal(await usb.getByLabel('部署地点', { exact: true }).isEnabled(), true); assert.equal(await usb.getByLabel('Wi-Fi SSID', { exact: true }).isEnabled(), true);
  await usb.getByLabel('部署地点', { exact: true }).selectOption('synthetic-alternate'); await usb.getByLabel('数据用途', { exact: true }).selectOption('field');
  assert.equal(await usb.getByLabel('Wi-Fi SSID', { exact: true }).isEnabled(), true); await saveSettings(usb);
  assert.equal(await usb.getByLabel('部署地点', { exact: true }).isEnabled(), true); assert.equal(await usb.getByLabel('Wi-Fi SSID', { exact: true }).isEnabled(), true);
  assert.equal(saved.config.dataset, 'field'); assert.equal(saved.placement.place_id, 'synthetic-alternate');
  const savedConfigAfterApplied = saved.config.capture_config_id;
  const completedAttempt = saved.candidate.attempt_id, beginCalls = saved.operations.filter(op => op === 'begin').length;
  saved.ack = false; saved.contact = false; saved.nonce = 'ef'.repeat(16);
  await usb.getByRole('button', { name: '重新配置网络', exact: true }).click();
  await usb.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-reconfigured-ssid'); await usb.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-reconfigured-secret');
  await usb.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).click(); await usb.getByText('设备正在验证', { exact: true }).waitFor();
  assert.equal(saved.operations.filter(op => op === 'begin').length, beginCalls + 1); assert.notEqual(saved.candidate.attempt_id, completedAttempt);
  assert.equal(saved.candidate.nonce, saved.nonce); assert.equal(saved.configureCalls, 3); assert.equal(saved.candidate.reuse_saved_credential, true);
  assert.equal(saved.registrations, 0); assert.equal(saved.rotations, 0); assert.equal(saved.configs, 1); assert.equal(saved.publishes, 1); assert.equal(saved.config.capture_config_id, savedConfigAfterApplied);
  const storage = await usb.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); assert(!storage.includes(TEST_TOKEN)); assert(!storage.includes('corrected-password')); await usbContext.close();
  // The device can reboot immediately after saving and retain this attempt in
  // history. Its exact save proof unlocks editing without inventing a cloud ACK.
  const rebootNetwork = await existingUsbNetwork(), reboot = rebootNetwork.page, rebootState = rebootNetwork.state;
  await reboot.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-before-reboot'); await reboot.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-reboot-secret');
  await reboot.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).click(); await reboot.getByText('设备正在验证', { exact: true }).waitFor();
  const rebootAttempt = rebootState.candidate.attempt_id;
  rebootState.usbState = 'idle'; rebootState.omitStatusAttempt = true;
  rebootState.previousAttempt = { state: 'saved', attempt_id: rebootAttempt, diagnostic: { stage: 'saved', code: 'saved', http_status: 200, elapsed_ms: 14771 } };
  await reboot.getByRole('button', { name: '读取设备阶段与诊断', exact: true }).click();
  await reboot.getByText('设备已退出配网，已有保存设置', { exact: true }).waitFor();
  await reboot.getByText('本次网络设置：设备已确认保存本次网络设置', { exact: true }).waitFor();
  await reboot.getByRole('button', { name: '完成并返回设备目录', exact: true }).waitFor();
  assert.equal(await reboot.getByLabel('部署地点', { exact: true }).isEnabled(), true); assert.equal(await reboot.getByLabel('Wi-Fi SSID', { exact: true }).isEnabled(), true);
  assert.equal(rebootState.ack, false); assert.equal(rebootState.contact, false);
  await reboot.getByText('本次配置应用确认：尚未收到新的 applied ACK，历史确认不计入本次', { exact: true }).waitFor();
  const statusReads = rebootState.operations.filter(op => op === 'status').length;
  await expect.poll(() => rebootState.operations.filter(op => op === 'status').length).toBeGreaterThan(statusReads);
  // Starting a fresh candidate must remain locked when only the previous
  // attempt has save evidence, even though the device still has a credential.
  await reboot.getByRole('button', { name: '重新配置网络', exact: true }).click();
  await reboot.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-after-reboot'); await reboot.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-new-secret');
  await reboot.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).click(); await reboot.getByText('设备正在验证', { exact: true }).waitFor();
  assert.notEqual(rebootState.candidate.attempt_id, rebootAttempt); assert.equal(rebootState.configureCalls, 2);
  rebootState.usbState = 'idle'; await reboot.getByRole('button', { name: '读取设备阶段与诊断', exact: true }).click();
  await reboot.getByText('设备已退出配网，已有保存设置', { exact: true }).waitFor();
  assert.equal(await reboot.getByLabel('部署地点', { exact: true }).isDisabled(), true); assert.equal(await reboot.getByLabel('Wi-Fi SSID', { exact: true }).isDisabled(), true);
  assert.equal(await reboot.getByRole('button', { name: '完成并返回设备目录', exact: true }).count(), 0);
  await reboot.getByText('本次网络设置：尚未取得本次保存确认', { exact: true }).waitFor();
  assert.equal(rebootState.rotations, 0); assert.equal(rebootState.registrations, 0); await rebootNetwork.context.close();
  // Explicit open choice clears the old personal password and sends no EAP
  // fields. An empty personal password cannot silently become an open network.
  const openNetwork = await existingUsbNetwork(); const open = openNetwork.page;
  await open.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-open-ssid'); await open.getByRole('button', { name: '通过 USB 发送给设备' }).click(); assert.equal(openNetwork.state.configureCalls, 0);
  await open.getByLabel('Wi-Fi 密码', { exact: true }).fill('discarded-personal-secret'); await open.getByLabel('Wi-Fi 认证方式', { exact: true }).selectOption('open');
  assert.equal(await open.getByLabel('Wi-Fi 密码', { exact: true }).count(), 0); assert.equal(await open.getByLabel('企业认证密码', { exact: true }).count(), 0);
  await open.getByRole('button', { name: '通过 USB 发送给设备' }).click(); await open.getByText('设备正在验证', { exact: true }).waitFor();
  assert.equal(openNetwork.state.configureCalls, 1); assert.equal(openNetwork.state.candidate.wifi_security, 'open'); assert.equal(openNetwork.state.candidate.password, '');
  for (const field of ['eap_username', 'eap_identity', 'eap_password']) assert.equal(openNetwork.state.candidate[field], undefined);
  await assertNetworkSecretsLocal(open, openNetwork.state, ['synthetic-open-ssid', 'discarded-personal-secret']); await openNetwork.context.close();
  // Enterprise username/password are mandatory; outer identity is optional.
  // Both branches stay local and safe diagnostics discard credential fields.
  for (const outerIdentity of ['', 'synthetic-outer-identity']) {
    const enterpriseNetwork = await existingUsbNetwork(); const enterprise = enterpriseNetwork.page;
    await enterprise.getByLabel('Wi-Fi 认证方式', { exact: true }).selectOption('enterprise'); await enterprise.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-enterprise-ssid');
    await enterprise.getByRole('button', { name: '通过 USB 发送给设备' }).click(); assert.equal(enterpriseNetwork.state.configureCalls, 0);
    await enterprise.getByLabel('企业认证用户名', { exact: true }).fill('synthetic-enterprise-user'); await enterprise.getByRole('button', { name: '通过 USB 发送给设备' }).click(); assert.equal(enterpriseNetwork.state.configureCalls, 0);
    await enterprise.getByLabel('企业认证密码', { exact: true }).fill('synthetic-enterprise-secret');
    if (outerIdentity) await enterprise.getByLabel('外层身份（可选）', { exact: true }).fill(outerIdentity);
    await enterprise.getByRole('button', { name: '通过 USB 发送给设备' }).click(); await enterprise.getByText('设备正在验证', { exact: true }).waitFor();
    assert.equal(enterpriseNetwork.state.configureCalls, 1); assert.equal(enterpriseNetwork.state.candidate.wifi_security, 'enterprise'); assert.equal(enterpriseNetwork.state.candidate.password, '');
    assert.equal(enterpriseNetwork.state.candidate.eap_username, 'synthetic-enterprise-user'); assert.equal(enterpriseNetwork.state.candidate.eap_password, 'synthetic-enterprise-secret'); assert.equal(enterpriseNetwork.state.candidate.eap_identity, outerIdentity || undefined);
    assert.equal(await enterprise.getByLabel('企业认证密码', { exact: true }).inputValue(), '');
    enterpriseNetwork.state.usbState = 'failed'; await enterprise.getByRole('button', { name: '读取设备阶段与诊断', exact: true }).click(); await enterprise.getByText('安全诊断详情', { exact: true }).click();
    const diagnostic = await enterprise.locator('.cp-provision-diagnostic').textContent(); assert(!diagnostic.includes('MUST-NOT-EXPOSE')); assert(!diagnostic.includes('eap_'));
    await assertNetworkSecretsLocal(enterprise, enterpriseNetwork.state, ['synthetic-enterprise-ssid', 'synthetic-enterprise-user', 'synthetic-enterprise-secret', ...(outerIdentity ? [outerIdentity] : [])]); await enterpriseNetwork.context.close();
  }
  // A legacy info reply without wifi_modes permits only WPA2 transmission.
  // Unsupported modes can still be edited, with a visible submission reason.
  const legacyState = fixture(true); legacyState.wifiModes = undefined; const legacyNetwork = await existingUsbNetwork(legacyState); const legacy = legacyNetwork.page;
  assert.equal(await legacy.getByLabel('Wi-Fi 认证方式', { exact: true }).inputValue(), 'wpa2');
  for (const mode of ['open', 'enterprise']) {
    await legacy.getByLabel('Wi-Fi 认证方式', { exact: true }).selectOption(mode); await legacy.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-unsupported-ssid');
    assert.equal(await legacy.getByRole('button', { name: '通过 USB 发送给设备', exact: true }).isDisabled(), true);
    await legacy.getByText('当前固件未报告支持此认证方式，请升级固件或选择受支持的网络。', { exact: true }).waitFor();
  }
  await legacy.getByLabel('Wi-Fi 认证方式', { exact: true }).selectOption('wpa2');
  await legacy.getByLabel('Wi-Fi SSID', { exact: true }).fill('synthetic-legacy-ssid'); await legacy.getByLabel('Wi-Fi 密码', { exact: true }).fill('synthetic-legacy-secret'); await legacy.getByRole('button', { name: '通过 USB 发送给设备' }).click(); await legacy.getByText('设备正在验证', { exact: true }).waitFor();
  assert.equal(legacyState.candidate.wifi_security, 'wpa2'); assert.equal(legacyState.candidate.password, 'synthetic-legacy-secret'); await assertNetworkSecretsLocal(legacy, legacyState, ['synthetic-legacy-ssid', 'synthetic-legacy-secret']); await legacyNetwork.context.close();
  // Read-only USB diagnosis sends status only, preserves uncertainty across a
  // hypothetical reset, and never changes cloud credentials or begins setup.
  const diagnosisState = fixture(true), diagnosisContext = await browser.newContext(); await setup(diagnosisContext, diagnosisState); await installUsb(diagnosisContext, diagnosisState);
  const diagnosis = await openWizard(diagnosisContext); await diagnosis.getByRole('button', { name: '连接 USB 只读诊断' }).click(); await diagnosis.getByText('未发送配置命令', { exact: false }).waitFor(); assert(diagnosisState.operations.every(op => op === 'status')); assert.equal(diagnosisState.registrations, 0); await diagnosisContext.close();
  // Lost registration response remains recoverable with the saved token; no
  // duplicate identity POST and no silent rotation, even after an explicit GET.
  const lostState = fixture(), lostContext = await browser.newContext(); lostState.dropRegistration = true; await setup(lostContext, lostState); await unsupported(lostContext); const lost = await openWizard(lostContext);
  await lost.getByLabel('设备屏幕上的工厂节点 ID', { exact: true }).fill(TEST_NODE); await lost.getByLabel('设备名称', { exact: true }).fill('Synthetic lost response'); await lost.getByRole('button', { name: '首次登记并取得设备凭证' }).click(); await lost.getByRole('alert').waitFor(); assert.equal(await lost.getByRole('button', { name: '首次登记并取得设备凭证' }).isDisabled(), true);
  await lost.getByRole('button', { name: '重新检查登记状态' }).click(); await lost.getByText('已登记设备 · Synthetic existing node').waitFor(); await lost.getByText('使用已保存的设备凭证或更换凭证', { exact: true }).click(); await lost.getByLabel('已有的独立设备凭证', { exact: true }).fill(TEST_TOKEN); await lost.getByRole('button', { name: '使用已有设备凭证', exact: true }).click(); await lost.getByText('设备凭证已准备，仅保留于当前向导。').waitFor(); assert.equal(lostState.registrations, 1); assert.equal(lostState.rotations, 0); await lostContext.close();
  // Race after explicit new-node lookup produces a visible 409 explanation and
  // transitions to existing-node reconfiguration instead of hiding the conflict.
  const conflict = fixture(), conflictContext = await browser.newContext(); conflict.conflictRegistration = true; await setup(conflictContext, conflict); await unsupported(conflictContext); const race = await openWizard(conflictContext);
  await race.getByLabel('设备屏幕上的工厂节点 ID', { exact: true }).fill(TEST_NODE); await race.getByLabel('设备名称', { exact: true }).fill('Synthetic race'); await race.getByRole('button', { name: '首次登记并取得设备凭证' }).click(); await race.getByRole('alert').filter({ hasText: '409' }).waitFor(); await race.getByText('已登记设备 · Synthetic existing node').waitFor(); assert.equal(conflict.registrations, 1); assert.equal(conflict.rotations, 0); await conflictContext.close();
  // AP reuse is explicitly selected because the cloud page has no direct
  // capability channel to the device-local page. A legacy page can reject it.
  const apSavedState = fixture(true), apSavedContext = await browser.newContext(); await setup(apSavedContext, apSavedState); await unsupported(apSavedContext); const apSaved = await openWizard(apSavedContext);
  await apSaved.getByLabel('设备屏幕上的工厂节点 ID', { exact: true }).fill(TEST_NODE); await apSaved.getByText('已登记设备 · Synthetic existing node').waitFor();
  const apReuse = apSaved.getByRole('radio', { name: /保留设备内现有凭证/ }); assert.equal(await apReuse.isChecked(), false); await apReuse.check();
  await apSaved.getByRole('button', { name: '保存配置' }).click(); await apSaved.getByRole('button', { name: '显示本地配网交接内容' }).click();
  const reuseHandoff = JSON.parse(await apSaved.getByLabel('复制到设备本地页面的交接内容', { exact: true }).inputValue()); assert.equal(reuseHandoff.reuse_saved_credential, true); assert.equal(reuseHandoff.device_token, undefined); assert.equal(apSavedState.registrations, 0); assert.equal(apSavedState.rotations, 0);
  // Producing a handoff is not an observed device write. Settings remain
  // editable, and changing them removes the stale handoff until saved again.
  assert.equal(await apSaved.getByLabel('部署地点', { exact: true }).isEnabled(), true); await apSaved.getByLabel('数据用途', { exact: true }).selectOption('field');
  assert.equal(await apSaved.getByLabel('复制到设备本地页面的交接内容', { exact: true }).count(), 0); await saveSettings(apSaved);
  await apSaved.getByRole('button', { name: '显示本地配网交接内容', exact: true }).click(); assert.equal(apSavedState.config.dataset, 'field'); await apSavedContext.close();
  // Unsupported browser + exact embedded page in WebKit; local page validation
  // is distinct from transport or physical network acceptance.
  const apState = fixture(), apContext = await browser.newContext(); await setup(apContext, apState); await unsupported(apContext); const ap = await openWizard(apContext); await ap.getByText('此浏览器没有可用的 Web Bluetooth', { exact: false }).waitFor();
  await ap.getByLabel('设备屏幕上的工厂节点 ID', { exact: true }).fill(TEST_NODE); await firstRegistration(ap); await ap.getByRole('button', { name: '保存配置' }).click(); await ap.getByRole('button', { name: '显示本地配网交接内容' }).click(); const handoff = JSON.parse(await ap.getByLabel('复制到设备本地页面的交接内容', { exact: true }).inputValue()); assert.equal(handoff.device_token, TEST_TOKEN); await apContext.close();
  const header = readFileSync(new URL('../firmware/components/cp_provision/setup_page.h', import.meta.url), 'utf8'); const part = name => header.split(`static const char ${name}[] =`)[1].split(';\n')[0].match(/"(?:[^"\\]|\\.)*"/g).map(s => JSON.parse(s)).join(''); const html = part('CP_SETUP_HEAD') + TEST_NODE + part('CP_SETUP_MID') + 'b'.repeat(32) + part('CP_SETUP_END');
  let safari = 'WebKit not installed';
  if (existsSync(webkit.executablePath())) {
    const wk = await webkit.launch({ headless: true }); const ctx = await wk.newContext(); ctx.setDefaultTimeout(15000);
    const localBodies = [];
    await ctx.route('http://192.168.4.1/**', route => {
      if (route.request().method() === 'POST') { assert.equal(new URL(route.request().url()).pathname, '/configure'); localBodies.push(route.request().postDataJSON()); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ v: 1, ok: true, state: 'received' }) }); }
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    const p = await ctx.newPage(); await p.goto('http://192.168.4.1'); await p.getByLabel('8-digit setup PIN shown on device').fill(TEST_PROOF); await p.getByLabel('Cloud enrollment handoff from the administrator page').fill(JSON.stringify(handoff)); await p.getByLabel('Target Wi-Fi SSID').fill('test'); await p.getByLabel('Target Wi-Fi password').fill('test-password'); await p.getByRole('button', { name: 'Submit to this device' }).click(); await p.getByText('Received by device; network validation is still pending.', { exact: false }).waitFor(); await p.reload(); await p.getByLabel('8-digit setup PIN shown on device').fill(TEST_PROOF); await p.getByLabel('Cloud enrollment handoff from the administrator page').fill(JSON.stringify(reuseHandoff)); await p.getByLabel('Target Wi-Fi SSID').fill('test'); await p.getByLabel('Target Wi-Fi password').fill('test-password'); await p.getByRole('button', { name: 'Submit to this device' }).click(); await p.getByText('Received by device; network validation is still pending.', { exact: false }).waitFor();
    for (const { auth, outer } of [{ auth: 'open', outer: '' }, { auth: 'enterprise', outer: '' }, { auth: 'enterprise', outer: 'synthetic-local-outer' }]) {
      await p.reload(); await p.getByLabel('8-digit setup PIN shown on device').fill(TEST_PROOF); await p.getByLabel('Cloud enrollment handoff from the administrator page').fill(JSON.stringify(reuseHandoff)); await p.getByLabel('Target Wi-Fi SSID').fill('synthetic-local-ssid');
      await p.getByLabel('Wi-Fi authentication').selectOption(auth); assert.equal(await p.getByLabel('Target Wi-Fi password', { exact: true }).isVisible(), false);
      const before = localBodies.length;
      if (auth === 'enterprise') {
        await p.getByRole('button', { name: 'Submit to this device' }).click(); assert.equal(localBodies.length, before);
        await p.getByLabel('Enterprise username', { exact: true }).fill('synthetic-local-user'); await p.getByRole('button', { name: 'Submit to this device' }).click(); assert.equal(localBodies.length, before);
        await p.getByLabel('Enterprise password', { exact: true }).fill('synthetic-local-secret'); if (outer) await p.getByLabel('Outer identity (optional)', { exact: true }).fill(outer);
      }
      await p.getByRole('button', { name: 'Submit to this device' }).click(); await p.getByText('Received by device; network validation is still pending.', { exact: false }).waitFor();
      assert.equal(localBodies.length, before + 1); const candidate = localBodies.at(-1); assert.equal(candidate.wifi_security, auth); assert.equal(candidate.password, ''); assert.equal(candidate.reuse_saved_credential, true); assert.equal(candidate.device_token, undefined);
      if (auth === 'enterprise') { assert.equal(candidate.eap_username, 'synthetic-local-user'); assert.equal(candidate.eap_password, 'synthetic-local-secret'); assert.equal(candidate.eap_identity, outer || undefined); assert.equal(await p.getByLabel('Enterprise password', { exact: true }).inputValue(), ''); }
      else for (const field of ['eap_username', 'eap_identity', 'eap_password']) assert.equal(candidate[field], undefined);
      const localStorage = await p.evaluate(() => JSON.stringify({ local: { ...window.localStorage }, session: { ...sessionStorage } })); for (const secret of [TEST_TOKEN, 'synthetic-local-ssid', 'synthetic-local-user', 'synthetic-local-secret', 'synthetic-local-outer']) assert(!localStorage.includes(secret));
    }
    await wk.close(); safari = 'WebKit embedded page token/reuse, open and enterprise optional-identity branches passed';
  }
  console.log(`Provisioning browser mock passed: editable prepared/expired settings, repeated save/no-op with immutable config history, clean/dirty external refresh, missing-credential explicit network reauthorization, fresh saved-credential reuse, identity/capability/readiness gates, single issuance across unsent and failed local retries, uncertain issuance lock, uncertain/testing write lock, stale-attempt failure rejection, applied-to-fresh USB attempt, BLE fresh-PIN restart, editable AP handoff, new/existing lookup, visible 409, lost registration recovery, saved-credential reuse, preserved config, safe stage diagnostics, corrected Wi-Fi nonce retry, explicit open/enterprise modes, legacy capability gate, local-only network secrets, fresh applied ACK, read-only USB, Security2 wrong PIN; ${safari}. No physical USB/BLE/network acceptance.`);
} finally { await browser.close(); await server.close(); }
