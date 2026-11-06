#!/usr/bin/env node
/** Full local simulator + real browser check. No credentials/captures are read. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { startV3Simulator } from './v3-simulator.mjs';

const simulator = await startV3Simulator({ port: Number(process.env.SIMULATOR_SMOKE_PORT ?? 5195) });
let browser, liveSimulator;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Official map tiles are not required to verify the local device/application path.
  await page.route('https://gis.ccnu.edu.cn/**', route => route.abort());
  await page.goto(simulator.origin + '/__simulator');
  await page.getByRole('heading', { name: '模拟设备控制台', exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('node-id').textContent === 'sim-v3-01');
  const status = () => page.request.get(simulator.origin + '/__simulator/status').then(r => r.json());
  async function until(predicate, message) {
    for (let i = 0; i < 100; i++) {
      const value = await status(); if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(message);
  }
  await until(s => s.device.accepted.window_statistics >= 1, 'First real committed statistics window');
  await page.getByRole('button', { name: /繁忙busy/ }).click();
  await until(s => s.device.scenario === 'busy', 'Busy scene');
  await page.getByRole('button', { name: /模拟丢失loss/ }).click();
  await until(s => s.device.scenario === 'loss', 'Loss scene');
  await page.getByRole('button', { name: /离线offline/ }).click();
  await until(s => s.device.pendingItems === 2, 'Offline queue holds exact batches');
  const rebootBlocked = await page.request.post(simulator.origin + '/__simulator/reboot', { headers: { Origin: simulator.origin }, data: {} });
  assert.equal(rebootBlocked.status(), 400, 'Reboot cannot discard unreceipted queue');
  await page.getByRole('button', { name: /安静quiet/ }).click();
  await until(s => s.device.pendingItems === 0 && !s.device.lastError, 'Reconnect drains retained queue');
  await page.getByRole('button', { name: /故障failed/ }).click();
  await until(s => s.device.phase === 'failed', 'Genuine terminal failed configuration ACK');
  await page.getByRole('button', { name: /安静quiet/ }).click();
  await until(s => s.device.appliedGeneration === 3 && !s.device.lastError, 'New applied generation recovers');
  const boot = (await status()).device.bootId;
  await page.getByRole('button', { name: '重新启动模拟设备', exact: true }).click();
  await until(s => s.reboot_count === 1 && s.device.bootId !== boot && s.device.registered, 'New boot registered with server history preserved');
  await page.getByRole('link', { name: /自动登录本地管理后台/ }).click();
  await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
  await page.getByRole('button', { name: '设备管理', exact: true }).click();
  await page.getByText('sim-v3-01', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '查看设备 sim-v3-01', exact: true }).click();
  await page.getByRole('heading', { name: 'V3 能力与应用状态', exact: true }).waitFor();
  await page.getByLabel('部署位置', { exact: true }).selectOption('sim-v3-library');
  await page.getByRole('button', { name: '根据当前能力准备 V3 策略', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'V3 策略 JSON', exact: true });
  const prepared = JSON.parse(await editor.inputValue());
  assert.equal(prepared.uplink.transport, 'mqtt_tls');
  prepared.collection.summary.window_ms = 1000; prepared.collection.summary.bin_ms = 1000;
  await editor.fill(JSON.stringify(prepared, null, 2));
  await page.getByRole('button', { name: '校验能力与策略', exact: true }).click();
  await page.getByRole('button', { name: '发布不可变 V3 assignment', exact: true }).click();
  await until(s => s.device.appliedGeneration === 5 && !s.device.lastError, 'Real admin prepare/validate/publish accepted over CPV3');
  assert.ok((await status()).transport.replies > 0);
  const evidence = await page.request.get(simulator.origin + '/api/v1/admin/device-v3/nodes/sim-v3-01/evidence');
  assert.equal(evidence.status(), 200);
  const records = await evidence.json();
  assert.ok(records.counts.windows > 0);
  assert.ok(records.batches.rows.every(b => b.receipt_tuple_match && b.source_rows_match));
  const field = await page.request.get(simulator.origin + '/api/v3/places/library/statistics');
  assert.equal(field.status(), 200);
  assert.equal((await field.json()).reason, 'no_field_statistics');
  const logout = await page.request.delete(simulator.origin + '/api/v1/admin/session', { headers: { Origin: simulator.origin } });
  assert.equal(logout.status(), 200);
  await page.goto(simulator.origin + '/__simulator/admin');
  await page.getByRole('heading', { name: '运行概览', exact: true }).waitFor();
  // Session logout must not revoke the independent simulated assignment principal.
  const failedAfterLogout = await page.request.post(simulator.origin + '/__simulator/scenario', {
    headers: { Origin: simulator.origin }, data: { scenario: 'failed' },
  });
  assert.equal(failedAfterLogout.status(), 200);
  await until(s => s.device.phase === 'failed', 'Assignment session survives browser logout');
  assert.equal((await page.request.post(simulator.origin + '/__simulator/scenario', {
    headers: { Origin: 'https://other.example.test' }, data: { scenario: 'busy' },
  })).status(), 403);
  await page.goto(simulator.origin + '/__simulator');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  // A separate ephemeral D1 opts into normal field policy/ingest. The public
  // application receives exactly the same API shape and URL as real devices.
  liveSimulator = await startV3Simulator({ port: Number(process.env.SIMULATOR_SMOKE_PORT ?? 5195) + 2, view: 'live' });
  const livePage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  livePage.on('pageerror', error => errors.push(error.message));
  await livePage.route('https://gis.ccnu.edu.cn/**', route => route.abort());
  const readLive = async () => (await livePage.request.get(liveSimulator.origin + '/api/v3/places/library/statistics')).json();
  async function liveUntil(predicate, message) {
    for (let i = 0; i < 100; i++) {
      const value = await readLive(); if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(message);
  }
  const quietLive = await liveUntil(s => s.state === 'observed' && s.visible_identifiers === 2, 'Local field quiet data accepted');
  await livePage.goto(liveSimulator.origin + '/?mode=field&place=library');
  const livePanel = livePage.getByRole('region', { name: '现场实时数据', exact: true });
  await livePanel.getByText('2 个 BLE 可见标识', { exact: true }).waitFor();
  assert.ok(await livePage.locator('.cp-map').count(), 'Normal map rendered');
  assert.equal(await livePage.getByRole('heading', { name: '模拟设备控制台', exact: true }).count(), 0);
  const publicRefresh = { headers: { 'Cache-Control': 'no-cache' } };
  const quietSummary = await (await livePage.request.get(liveSimulator.origin + '/api/v1/places/library/summary', publicRefresh)).json();
  assert.equal(quietSummary.sensor.visible_identifiers, 2);
  assert.equal((await livePage.request.post(liveSimulator.origin + '/__simulator/scenario', {
    headers: { Origin: liveSimulator.origin }, data: { scenario: 'busy' },
  })).status(), 200);
  const busyLive = await liveUntil(s => s.visible_identifiers === 12, 'Local field busy update accepted');
  assert.ok(Date.parse(busyLive.observed_at) > Date.parse(quietLive.observed_at));
  const busySummary = await (await livePage.request.get(liveSimulator.origin + '/api/v1/places/library/summary', publicRefresh)).json();
  assert.equal(busySummary.sensor.visible_identifiers, 12);
  await livePanel.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await livePanel.getByText('12 个 BLE 可见标识', { exact: true }).waitFor();
  const liveHistory = await (await livePage.request.get(liveSimulator.origin + '/api/v1/places/library/history?minutes=15', publicRefresh)).json();
  assert.ok(liveHistory.sensor_windows.some(w => w.visible_identifiers === 2));
  assert.ok(liveHistory.sensor_windows.some(w => w.visible_identifiers === 12));
  assert.ok(!JSON.stringify({ quietLive, busyLive, busySummary, liveHistory }).includes('synthetic'));
  await livePage.getByRole('region', { name: '现场数据连续时间轴', exact: true })
    .getByRole('button', { name: /传感器 sim-v3-01 · 12 个 BLE 可见标识/ }).first().click();
  await livePage.getByRole('region', { name: '现场历史回放', exact: true })
    .getByText('12 个 BLE 可见标识', { exact: true }).waitFor();
  await livePage.getByRole('button', { name: '返回实时', exact: true }).click();
  await livePage.getByRole('region', { name: '现场实时数据', exact: true }).waitFor();
  await livePage.goto(liveSimulator.origin + '/__simulator/admin');
  const liveInspection = await (await livePage.request.get(liveSimulator.origin + '/api/v1/admin/device-v3/nodes/sim-v3-01')).json();
  assert.equal(liveInspection.capabilities.producer_version, 'synthetic-statistics/1');
  await livePage.goto(liveSimulator.origin + '/__simulator');
  await livePage.waitForFunction(() => document.getElementById('dataset-badge').textContent.includes('field'));
  assert.ok((await livePage.locator('#dataset-notice').textContent()).includes('临时本地数据库'));
  assert.deepEqual(errors, []);
  console.log('V3 simulator browser smoke passed: CPV3 gateway, scenarios, receipts, offline recovery, reboot, admin policy preparation/publication, relogin, controlled-test isolation, normal live/history UI updates, backend provenance and mobile layout.');
} finally {
  try { await browser?.close(); } finally { try { await liveSimulator?.close(); } finally { await simulator.close(); } }
}
