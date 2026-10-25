import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

// Browser screenshots of the local app. All API observations are synthetic
// fixtures. Official GIS tiles remain remote; no raw tiles are saved in Git.
const views = new Set((process.env.README_VIEWS || 'simulation,live,mobile').split(','));
assert.ok([...views].every(view => ['simulation', 'live', 'mobile'].includes(view)));
const origin = process.env.README_URL || 'http://127.0.0.1:5186';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Local app required');
const originals = path.resolve(process.env.README_ORIGINALS || '/tmp/campuspulse-readme-originals');
const destination = path.resolve('docs/images');
mkdirSync(originals, { recursive: true });
mkdirSync(destination, { recursive: true });
expect.configure({ timeout: 30000 });
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
if (process.env.NODE_EXTRA_CA_CERTS) {
  const certificate = new X509Certificate(readFileSync(process.env.NODE_EXTRA_CA_CERTS));
  args.push(`--ignore-certificate-errors-spki-list=${createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}`);
}
const browser = await chromium.launch({ headless: true, args,
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'Asia/Shanghai', locale: 'zh-CN', reducedMotion: 'reduce' });
const page = await context.newPage();
const pageErrors = [], writes = [], captures = [];
page.on('pageerror', error => pageErrors.push(error.message));
const now = Date.parse('2026-10-25T06:00:00Z');
const iso = ms => new Date(ms).toISOString();
await page.clock.setFixedTime(now);
const place = { id: 'library', name: '图书馆（样例）', kind: 'activity', gis_anchor: { x: 15656 / 24576, y: 9059 / 24576, verified: true } };
const windows = Array.from({ length: 108 }, (_, index) => {
  const offset = index * 30000 + 10000;
  return { source: 'sensor', dataset: 'field', node_id: 'sample-node', boot_id: 'sample-session', placement_id: 'sample-placement', capture_config_id: 'sample-config', seq: 108 - index,
    observed_at: iso(now - offset), valid_until: iso(now - offset + 90000),
    visible_identifiers: Math.round(10 + 5 * Math.sin(index / 7) + 3 * Math.cos(index / 13)),
    reports_aggregated: 80 + index % 17, duration_ms: 30000, scan_enabled_ms: 28000,
    uncertainty_ms: 200, aggregation_drops: 0, unique_table_overflow: false, quality_flags: [], freshness: index < 3 ? 'fresh' : 'stale',
  };
}).filter((_, index) => index < 35 || index > 50); // Deliberate recording gap.
await page.route('**/api/v1/**', route => {
  const request = route.request(), url = new URL(request.url());
  if (request.method() !== 'GET') { writes.push(request.method()); return route.abort(); }
  const pathname = url.pathname;
  if (pathname.endsWith('/settings')) return route.fulfill({ json: { site_name: 'CampusPulse', default_mode: 'field' } });
  if (pathname === '/api/v1/places') return route.fulfill({ json: { places: [place] } });
  if (pathname.endsWith('/summary')) return route.fulfill({ json: { place, as_of: iso(now), freshness: 'fresh', sensor: windows[0], latest_observation: null } });
  if (pathname.endsWith('/history')) {
    const from = now - Number(url.searchParams.get('minutes') || 60) * 60000;
    return route.fulfill({ json: { place_id: place.id, from: iso(from), to: iso(now), observations: [], sensor_windows: windows.filter(item => Date.parse(item.observed_at) >= from), truncated: false, sensor_truncated: false } });
  }
  return route.fulfill({ status: 404, json: { error: 'not_used_in_readme_capture' } });
});

// Preserve originals; copy only structure and pixel data into public PNGs.
// Validate every chunk and reject unknown critical chunks before writing.
const safeChunks = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM']);
function cleanPng(input) {
  assert.ok(input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  const parts = [input.subarray(0, 8)], found = [];
  let offset = 8;
  while (offset < input.length) {
    const size = input.readUInt32BE(offset), end = offset + size + 12;
    assert.ok(end <= input.length, 'Complete PNG chunk required');
    const kind = input.toString('ascii', offset + 4, offset + 8);
    assert.ok(safeChunks.has(kind) || kind[0] === kind[0].toLowerCase(), 'Unknown critical PNG chunk');
    if (safeChunks.has(kind)) { parts.push(input.subarray(offset, end)); found.push(kind); }
    offset = end;
  }
  assert.equal(found[0], 'IHDR'); assert.equal(found.at(-1), 'IEND');
  return Buffer.concat(parts);
}
async function save(name) {
  const original = path.join(originals, name);
  await page.screenshot({ path: original, animations: 'disabled' });
  const output = path.join(destination, name);
  writeFileSync(output, cleanPng(readFileSync(original)));
  // Re-read and inspect the actual final copy. No private metadata values logged.
  const final = readFileSync(output), kinds = new Set();
  for (let at = 8; at < final.length;) { const n = final.readUInt32BE(at); kinds.add(final.toString('ascii', at + 4, at + 8)); at += n + 12; }
  assert.ok([...kinds].every(kind => safeChunks.has(kind)));
  captures.push({ file: path.relative(process.cwd(), output), width: final.readUInt32BE(16), height: final.readUInt32BE(20), bytes: final.length, chunks: [...kinds], sha256: createHash('sha256').update(final).digest('hex') });
}
async function ready({ night = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  console.log('Waiting for visible GIS tiles…');
  await page.waitForFunction(() => {
    const maps = [...document.querySelectorAll('.cp-map')];
    return maps.length > 0 && maps.every(map => { const images = [...map.querySelectorAll('.cp-map__tile')].filter(image => getComputedStyle(image).visibility !== 'hidden'); return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0); });
  }, undefined, { timeout: 90000 });
  console.log('Visible GIS ready.');
  if (night) console.log('Preparing night materials…');
  const diagnostic = night ? setInterval(async () => { try { console.log(JSON.stringify(await page.locator('.cp-campus-light-host, .cp-library-light-host').evaluateAll(nodes => nodes.map(node => ({ type: node.className, state: node.dataset.materialStatus || node.dataset.atlasStatus, visible: node.dataset.visibleChunks, ready: node.dataset.readyChunks, failed: node.dataset.failedChunks, jobs: node.dataset.runningJobs, viewport: node.dataset.viewport }))))); } catch { /* Page may be closing. */ } }, 15000) : null;
  try { if (night) await page.waitForFunction(() => {
    const campus = [...document.querySelectorAll('.cp-campus-light-host')];
    const library = [...document.querySelectorAll('.cp-library-light-host')];
    return campus.length > 0 && campus.every(host => host.dataset.materialStatus === 'ready')
      && library.every(host => host.dataset.viewport === 'offscreen' || host.dataset.atlasStatus === 'ready');
  }, undefined, { timeout: 240000 });
  } finally { if (diagnostic) clearInterval(diagnostic); }
  await page.mouse.move(6, 98);
}
try {
  if (views.has('simulation')) {
    console.log('Capturing synthetic simulation with official remote GIS tiles…');
    await page.goto(`${origin}/?mode=demo`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '图书馆', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByRole('slider', { name: '模拟回放时间' }).fill('1200');
    await ready({ night: true });
    await save('simulation-desktop.png');
  }

  if (views.has('live') || views.has('mobile')) {
    console.log('Capturing live timeline with visibly named synthetic UI fixtures…');
    if (!views.has('simulation')) await page.goto(`${origin}/?mode=field`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '现场观察', exact: true }).click();
    await page.getByRole('button', { name: '浅色', exact: true }).click();
    await expect(page.getByRole('region', { name: '现场实时数据' })).toContainText('13 个 BLE 可见标识');
    await expect(page.locator('.field-timeline-mark')).toHaveCount(windows.length);
    await ready();
    if (views.has('live')) await save('live-timeline-desktop.png');
  }

  if (views.has('mobile')) {
    console.log('Capturing pinned historical cursor on mobile…');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('slider', { name: '现场数据时间轴' }).fill(String(now - 5 * 60000));
    await expect(page.getByRole('region', { name: '现场历史回放' })).toContainText('历史记录');
    await expect(page.getByRole('button', { name: '返回实时', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await ready();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // Real scroll interaction keeps the historical value visible on a phone.
    await page.getByRole('region', { name: '现场历史回放' }).locator('.field-data-record').scrollIntoViewIfNeeded();
    await save('replay-mobile.png');
  }
  assert.deepEqual(writes, []); assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ captures, apiWrites: writes.length, pageErrors: pageErrors.length }, null, 2));
} finally { await browser.close(); }
