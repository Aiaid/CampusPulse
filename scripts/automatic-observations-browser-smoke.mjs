// Synthetic acceptance only: ephemeral workerd/D1, no production, hardware,
// screenshots or saved secrets. Run after `npm run build` from the current source.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';

assert.ok(existsSync('dist/index.html'), 'Build current frontend before browser acceptance');
expect.configure({ timeout: 15000 });
const operator = 'synthetic-automatic-operator', deviceSecret = 'synthetic-automatic-device';
const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = name => JSON.parse(readFileSync(`docs/specs/examples/${name}.json`, 'utf8'));
const source = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'] });
const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, host: '127.0.0.1', workers: [{ name: 'automatic-observations-browser', modules: true,
  script: source.outputFiles[0].text, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  assets: { directory: './dist', binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: 'single-page-application' } },
  bindings: { OPERATOR_TOKEN: operator },
}] }));
let browser;
const checks = [], errors = [], identifiers = [], secrets = [operator, deviceSecret];
try {
  const base = (await mf.ready).origin, db = await mf.getD1Database('DB');
  assert.equal(new URL(base).hostname, '127.0.0.1');
  for (const name of readdirSync('migrations').filter(name => /^\d+.*\.sql$/.test(name)).sort()) await db.exec(readFileSync(`migrations/${name}`, 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  const purposes = JSON.stringify(['activity', 'parking', 'elevator']);
  await db.prepare('UPDATE places SET observation_kinds_json=? WHERE id=?').bind(purposes, 'library').run();
  for (const id of ['synthetic-legacy', 'synthetic-zero', 'synthetic-stale', 'synthetic-pending']) await db.prepare('INSERT INTO places(id,name,kind,anchor_x,anchor_y,observation_kinds_json) VALUES(?,?,?,?,?,?)').bind(id, id, 'activity', .5, .5, purposes).run();
  const get = async path => {
    const response = await fetch(base + path), value = await response.json();
    assert.equal(response.status, 200, `Local synthetic read failed: ${path}`); return value;
  };
  const upload = async (body, token) => {
    const bytes = JSON.stringify(body);
    const response = await fetch(base + '/api/v2/ingest', { method: 'POST', body: bytes, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Body-SHA256': hash(bytes) } });
    const value = await response.json();
    assert.equal(response.status, 200, `Local synthetic ingest rejected: ${JSON.stringify(value.error || {})}`);
    assert.equal(value.durability, 'committed'); return value;
  };
  const seedCapture = async (placeId, features, { age = 1000, pending = false } = {}) => {
    const config = fixture('capture-config-v2.fixture'), token = `${deviceSecret}-${placeId}`;
    secrets.push(token);
    Object.assign(config, { node_id: `synthetic-node-${placeId}`, placement_id: `synthetic-placement-${placeId}`, capture_config_id: `synthetic-config-${placeId}`, dataset: 'field', accept_until: new Date(Date.now() + 86_400_000).toISOString() });
    assert.deepEqual(config.allowed_streams, ['ble_windows', 'address_summaries', 'node_status']);
    assert.deepEqual(config.raw_capture, { mode: 'off' });
    await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(config.node_id, hash(token)).run();
    await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms,observation_kinds_json) VALUES(?,?,?,?,?)').bind(config.placement_id, config.node_id, placeId, 0, purposes).run();
    await db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)').bind(config.capture_config_id, config.node_id, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until)).run();
    await db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').bind(config.node_id, config.capture_config_id, new Date().toISOString()).run();
    const common = { protocol: 'campuspulse/2', node_id: config.node_id, placement_id: config.placement_id, capture_config_id: config.capture_config_id, dataset: 'field', boot_id: randomUUID(), firmware_version: 'synthetic-browser-compact-v1' };
    const time = { mono_ms: 60000, utc_ms: Date.now() - age, uncertainty_ms: 10, clock_epoch: 1 }, reports = features.length * 2;
    const window = { ...fixture('ble-windows-v2.request').items[0], time, scan_enabled_ms: 30000, reports_seen: reports, reports_aggregated: reports, adv_reports: reports, visible_identifiers: features.length, rssi: { samples: reports, min_dbm: -70, max_dbm: -50, mean_dbm: -60 } };
    const windowsBatch = { ...common, batch_id: randomUUID(), stream: 'ble_windows', items: [window] };
    const ack = await upload(windowsBatch, token);
    assert.deepEqual(await upload(windowsBatch, token), ack, 'Actual ingest exact retry preserves receipt');
    const items = features.map((nameMask, index) => {
      const address = `02:00:00:00:00:${(index + 1).toString(16).padStart(2, '0')}`;
      identifiers.push(address);
      return { ...fixture('address-summaries-v2.request').items[0], seq: index + 1, time, reports: 2, adv_reports: 2, rssi: { samples: 2, min_dbm: -70, max_dbm: -50, mean_dbm: -60 }, first_offset_ms: 100, last_offset_ms: 29900, bins: [1, 0, 0, 0, 0, 1], address,
        ...(nameMask === null ? {} : { vehicle_evidence: { schema_version: 'radar-compact-v1', parsed_reports: 2, malformed_reports: 0, name_brand_mask: nameMask, exclusion_mask: 0, ecosystem_mask: 0 } }) };
    });
    if (!pending) await upload({ ...common, batch_id: randomUUID(), stream: 'address_summaries', items }, token);
    return time.utc_ms;
  };
  // Direct synthetic historical seed is deliberate: public entry rejects >24h
  // observations. Records retain manual/source/time/receipt/status provenance.
  const seedManualBaseline = async () => {
    const now = Date.now(), day = 86_400_000;
    const weekend = ms => [0, 6].includes(new Date(ms + 480 * 60000).getUTCDay());
    let previousDay = 1;
    while (weekend(now - previousDay * day) !== weekend(now)) previousDay++;
    for (let index = 0; index < 5; index++) {
      const observed = now - (index < 3 ? 0 : previousDay * day) - 120000 - index * 1000;
      await db.prepare('INSERT INTO observations(id,place_id,kind,source,status,observed_at,valid_until,received_at,wait_seconds) VALUES(?,?,?,?,?,?,?,?,?)')
        .bind(`synthetic-history-${index}`, 'library', 'elevator', 'manual', 'active', new Date(observed).toISOString(), new Date(observed + 900000).toISOString(), new Date(observed + 100).toISOString(), 20 + index * 10).run();
    }
  };
  await seedCapture('synthetic-legacy', [null]);
  await seedCapture('synthetic-zero', [0]);
  await seedCapture('synthetic-stale', [1], { age: 120000 });
  await seedCapture('synthetic-pending', [1], { pending: true });

  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.name));
  await page.goto(base + '/?mode=field&place=library');
  const live = page.getByRole('region', { name: '现场实时数据', exact: true });
  await expect(live).toContainText('设备联网后，仍需上传符合此地点与现场数据要求的采集窗口');
  await expect(live).toContainText('地图标记地点，不单独标记设备');
  await expect(live).toContainText('缺失不表示零');
  checks.push('library without eligible windows explains device contact versus public evidence');

  const capturedAt = await seedCapture('library', [1, 1 << 5, 1 << 6]); // YADEA, BYD, Ninebot: distinct categories.
  await seedManualBaseline();
  const summary = await get('/api/v1/places/library/summary');
  assert.equal(summary.automatic_observations.vehicles.candidate_count, 1);
  assert.equal(summary.automatic_observations.vehicles.car_related_count, 1);
  assert.equal(summary.automatic_observations.vehicles.ecosystem_count, 1);
  assert.equal(summary.automatic_observations.elevator.status, 'historical_estimate');
  assert.equal(summary.automatic_observations.elevator.sample_count, 5);
  assert.equal(summary.automatic_observations.elevator.day_count, 2);
  assert.equal(summary.automatic_observations.elevator.wait_seconds, 40);
  await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect(live).toContainText('1 个电动车相关候选标识');
  await expect(live).toContainText('汽车相关候选 1');
  await expect(live).toContainText('车辆生态相关候选 1');
  await expect(live).not.toContainText('3 个电动车相关候选标识');
  await expect(live).toContainText('约 40 秒候梯参考');
  await expect(live).toContainText('5 次样本 / 2 天');
  await expect(live).toContainText('不是当前实测或实时剩余等待预测');
  await expect(page.locator('.metric-list')).toHaveCount(0);
  checks.push('actual compact ingest yields separate e-bike/car/ecosystem categories and manual historical baseline');

  await page.setViewportSize({ width: 390, height: 844 });
  const vehicleCard = live.getByRole('article', { name: '电动车相关广播 · 自动候选', exact: true });
  await vehicleCard.scrollIntoViewIfNeeded();
  const cardBounds = await vehicleCard.boundingBox();
  assert.ok(cardBounds && cardBounds.x >= 0 && cardBounds.x + cardBounds.width <= 391, 'Candidate card fits 390px screen');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow at 390px');
  await live.getByRole('article', { name: '候梯时间 · 历史样本参考', exact: true }).scrollIntoViewIfNeeded();
  checks.push('390px independently scrollable inference cards remain readable');

  const axis = page.getByRole('slider', { name: '现场数据时间轴', exact: true });
  // Use the range's live min/step alignment; a fixture timestamp may no
  // longer lie on an accepted step after the timeline advances.
  await axis.press('ArrowLeft');
  const replay = page.getByRole('region', { name: '现场历史回放', exact: true });
  await expect(replay).toContainText('自动分析尚未归档到此历史时间轴');
  await expect(replay.locator('.field-data-automatic')).toHaveCount(0);
  await expect(replay).not.toContainText('约 40 秒候梯参考');
  const pinned = await axis.inputValue();
  await page.getByRole('button', { name: '刷新现场数据', exact: true }).click();
  await expect(replay).toContainText('自动分析尚未归档到此历史时间轴');
  assert.equal(await axis.inputValue(), pinned);
  await page.getByRole('button', { name: '返回实时', exact: true }).click();
  await expect(live).toContainText('1 个电动车相关候选标识');
  checks.push('replay preserves selected time and never inserts live automatic inference');

  for (const [id, reason, label] of [
    ['synthetic-legacy', 'vehicle_features_not_reported', '设备尚未上报识别所需的广播特征'],
    ['synthetic-pending', 'summaries_pending', '仍在等待配套地址摘要'],
    ['synthetic-stale', 'stale_sensor_window', '最近的采集窗口已过期'],
  ]) {
    const result = await get(`/api/v1/places/${id}/summary`);
    assert.equal(result.automatic_observations.vehicles.reason, reason);
    assert.equal(result.automatic_observations.vehicles.candidate_count, null);
    await page.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(id);
    await expect(live).toContainText(label);
    await expect(live).not.toContainText('0 个电动车相关候选标识');
    await expect(live).not.toContainText('约 0 秒候梯参考');
  }
  const zero = await get('/api/v1/places/synthetic-zero/summary');
  assert.equal(zero.automatic_observations.vehicles.candidate_count, 0);
  assert.equal(zero.automatic_observations.vehicles.status, 'candidate_estimate');
  await page.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('synthetic-zero');
  await expect(live).toContainText('0 个电动车相关候选标识');
  await expect(live).toContainText('不等于车辆数量');
  checks.push('legacy features/pending/stale evidence stay null; valid feature input may report zero candidates');

  for (const id of ['library', 'synthetic-legacy', 'synthetic-zero', 'synthetic-stale', 'synthetic-pending']) {
    for (const suffix of ['summary', 'history?minutes=1440']) {
      const serialized = JSON.stringify(await get(`/api/v1/places/${id}/${suffix}`));
      for (const privateValue of [...identifiers, ...secrets, 'vehicle_evidence', 'name_brand_mask', 'exclusion_mask', 'ecosystem_mask', 'credential_sha256']) assert.ok(!serialized.includes(privateValue), 'Public JSON must omit identifiers, compact masks and secrets');
    }
  }
  const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  for (const secret of secrets) assert.ok(!persisted.includes(secret));
  assert.deepEqual(errors, []);
  checks.push('public summary/history expose no private addresses, masks or credentials');
  console.log(JSON.stringify({ runtime: 'workerd', storage: 'ephemeral real D1', screenshots: 0, checks, pageErrors: errors.length }, null, 2));
} finally { await browser?.close(); await mf.dispose(); }
