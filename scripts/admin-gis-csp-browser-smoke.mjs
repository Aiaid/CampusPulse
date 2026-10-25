import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

// A built-app fixture with the actual deployable HTTP CSP, not a meta policy.
// No production access, credentials, database writes or real external requests.
// Run `npm run build` first, then `node scripts/admin-gis-csp-browser-smoke.mjs`.
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'dist');
assert.ok(existsSync(resolve(dist, 'index.html')), 'Build the frontend first');
const rules = new Map(readFileSync(resolve(root, 'public/_headers'), 'utf8').trim().split(/\n\s*\n/).map(block => {
  const [path, ...lines] = block.split('\n');
  return [path, Object.fromEntries(lines.map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }))];
}));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const adminRule = path === '/admin' ? '/admin' : path.startsWith('/admin/') ? '/admin/*' : null;
  const file = resolve(dist, adminRule ? 'index.html' : `.${path}`);
  if (!file.startsWith(`${dist}${sep}`) || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', ...(rules.get(adminRule) || {}) });
  response.end(readFileSync(file));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let tiles = 0;
  const unexpectedRequests = [], errors = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://gis.ccnu.edu.cn' && url.pathname.startsWith('/mapdata/')) {
      tiles++;
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e1e8da"/></svg>' });
    }
    if (url.origin !== origin) { unexpectedRequests.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    assert.equal(request.method(), 'GET', 'This smoke test must not write API data');
    let body;
    if (url.pathname === '/api/v1/settings') body = { site_name: 'CSP regression', default_mode: 'field' };
    else if (url.pathname === '/api/v1/admin/auth/status') body = { initialized: true };
    else if (url.pathname === '/api/v1/admin/session') body = { authenticated: true, role: 'admin', account: { username: 'fixture', display_name: '本地测试' } };
    else if (url.pathname === '/api/v1/admin/overview') body = {};
    else if (url.pathname === '/api/v1/admin/devices') body = { devices: [] };
    else if (url.pathname === '/api/v1/places' || url.pathname === '/api/v1/admin/places') body = { places: [], truncated: false };
    else return route.fulfill({ status: 404, json: { error: 'fixture_missing' } });
    return route.fulfill({ json: body });
  });
  await context.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.cspViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition }));
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  for (const path of ['/admin', '/admin/places']) {
    const response = await page.goto(`${origin}${path}`);
    assert.equal(response.headers()['content-security-policy'], rules.get(path === '/admin' ? '/admin' : '/admin/*')['Content-Security-Policy']);
    await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '地点与部署', exact: true }).click();
    await page.getByRole('button', { name: '新建地点', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建地点', exact: true });
    await expect.poll(() => dialog.locator('.cp-map__tile').evaluateAll(images => images.filter(image => image.complete && image.naturalWidth > 0).length)).toBeGreaterThan(0);
    await expect(dialog.locator('.cp-map__tile-notice')).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], `${path}: normal GIS UI must not violate CSP`);
    // Probe actual browser enforcement: unknown origins stay blocked, and the
    // GIS image exception does not grant fetch/connect access to that origin.
    const probe = await page.evaluate(async () => {
      const image = new Image();
      const imageLoaded = new Promise(resolve => { image.onload = () => resolve(true); image.onerror = () => resolve(false); });
      image.src = 'https://not-approved.example/csp-probe.png';
      document.body.append(image);
      const connectAllowed = await fetch('https://gis.ccnu.edu.cn/csp-probe').then(() => true, () => false);
      return { imageLoaded: await imageLoaded, connectAllowed };
    });
    assert.deepEqual(probe, { imageLoaded: false, connectAllowed: false });
    await expect.poll(() => page.evaluate(() => window.cspViolations.length)).toBe(2);
    const violations = await page.evaluate(() => window.cspViolations);
    assert.ok(violations.some(event => event.directive === 'img-src' && event.blockedURI.startsWith('https://not-approved.example') && event.disposition === 'enforce'));
    assert.ok(violations.some(event => event.directive === 'connect-src' && event.blockedURI.startsWith('https://gis.ccnu.edu.cn') && event.disposition === 'enforce'));
  }
  assert.ok(tiles > 0, 'Official GIS image requests must reach the fixture');
  assert.deepEqual(unexpectedRequests, [], 'CSP probes must be blocked before network access');
  assert.deepEqual(errors, []);
  console.log('Admin GIS HTTP CSP: /admin and nested route tiles render; other image origins and cross-origin fetch remain blocked. Synthetic read-only API/tile fixture only.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
