import { chromium } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID, X509Certificate, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// This acceptance test creates one synthetic record ONLY in a local Worker.
// Cancellation preserves the audit row. Never point this at a deployed API.
const target = new URL(process.env.SMOKE_URL || 'http://127.0.0.1:8787');
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'Local target required');
assert.equal(target.protocol, 'http:', 'Use the local HTTP Worker');
assert.ok(!target.username && !target.password && !target.search && !target.hash && target.pathname === '/', 'Use a plain local origin');
const origin = target.origin;
const vars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
const token = vars.match(/^\s*OPERATOR_TOKEN\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^(["'])(.*)\1$/, '$2');
assert.ok(token, 'Set an ignored local .dev.vars OPERATOR_TOKEN first');
const args = ['--no-sandbox'];
if (process.env.NODE_EXTRA_CA_CERTS) {
  const ca = new X509Certificate(readFileSync(process.env.NODE_EXTRA_CA_CERTS));
  const spki = createHash('sha256').update(ca.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  args.push(`--ignore-certificate-errors-spki-list=${spki}`);
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium'),
  headless: true, args,
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
});
const id = randomUUID();
let attemptedWrite = false;
let cancelled = false;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const external = [];
  const credentialLeaks = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      external.push(`${url.origin}${url.pathname}`);
      return route.abort();
    }
    const authorization = request.headers().authorization;
    if (authorization) {
      const expectedMutation = (request.method() === 'POST' && url.pathname === '/api/v1/observations') ||
        (request.method() === 'DELETE' && url.pathname === `/api/v1/observations/${id}`);
      if (!expectedMutation || authorization !== `Bearer ${token}`) credentialLeaks.push(`${request.method()} ${url.pathname}`);
    }
    return route.continue();
  });
  await page.goto(`${origin}/docs?url=https://example.invalid/forbidden.json`);
  await page.locator('.opblock').nth(8).waitFor();
  assert.equal(await page.locator('.opblock').count(), 45, 'All implemented public, account/Passkey/admin, operator, device and research operations');
  assert.ok(!(await page.content()).includes(token), 'Credential absent from initial HTML');
  const op = (method, path) => page.locator(`.opblock-${method}`).filter({ has: page.locator(`.opblock-summary-path[data-path="${path}"]`) });
  const open = async operation => {
    if (!(await operation.locator('.opblock-body').isVisible())) await operation.locator('.opblock-summary-control').click();
    await operation.getByRole('button', { name: 'Try it out', exact: true }).click();
  };
  const execute = async (operation, method, path, status) => {
    console.log(`Docs UI: ${method} ${path} (expect ${status})`);
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method),
      operation.getByRole('button', { name: 'Execute', exact: true }).click(),
    ]);
    assert.ok((Array.isArray(status) ? status : [status]).includes(response.status()), `${method} ${path} status: ${response.status()}`);
    await operation.locator('.live-responses-table .response-col_status').filter({ hasText: String(response.status()) }).waitFor();
    return response.json();
  };
  const health = op('get', '/api/v1/health');
  await open(health);
  const healthBody = await execute(health, 'GET', '/api/v1/health', 200);
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.ingestion, 'implemented');
  assert.ok(['configured', 'unconfigured'].includes(healthBody.raw_storage));

  // The docs expose protected GETs with independent credentials; neither the
  // operator token nor a synthetic device token is embedded in this page.
  const deviceConfig = op('get', '/api/v1/device/config');
  await open(deviceConfig);
  assert.equal((await execute(deviceConfig, 'GET', '/api/v1/device/config', 401)).error.code, 'unauthorized');
  const research = op('get', '/api/v1/research/batches/{id}');
  await open(research);
  await research.locator('input[placeholder="id"]').fill('33333333-3333-4333-8333-333333333333');
  await research.locator('input[placeholder="node_id"]').fill('cp-demo-01');
  assert.ok(['research_not_configured', 'unauthorized'].includes(
    (await execute(research, 'GET', '/api/v1/research/batches/33333333-3333-4333-8333-333333333333', [401, 503])).error.code));

  const post = op('post', '/api/v1/observations');
  await open(post);
  const data = { id, place_id: 'east-parking', kind: 'parking', observed_at: new Date().toISOString(), parking_min: 2, parking_max: 5 };
  await post.locator('textarea.body-param__text').fill(JSON.stringify(data, null, 2));
  assert.equal((await execute(post, 'POST', '/api/v1/observations', 401)).error.code, 'unauthorized');

  await page.locator('.auth-wrapper').getByRole('button', { name: 'Authorize' }).click();
  const auth = page.locator('.dialog-ux');
  const operatorAuth = auth.locator('.auth-container').filter({ hasText: 'OperatorToken' });
  assert.equal(await operatorAuth.count(), 1, 'One OperatorToken authorization control');
  await operatorAuth.locator('input').fill(token);
  await operatorAuth.getByRole('button', { name: 'Apply credentials', exact: true }).click();
  await operatorAuth.getByRole('button', { name: 'Close', exact: true }).click();
  attemptedWrite = true;
  const receipt = await execute(post, 'POST', '/api/v1/observations', 201);
  assert.equal(receipt.durability, 'committed');
  assert.equal(receipt.observation.id, id);
  assert.equal(receipt.observation.source, 'manual');

  // Even while authorized, public operations must not send the shared secret.
  await execute(health, 'GET', '/api/v1/health', 200);
  const remove = op('delete', '/api/v1/observations/{id}');
  await open(remove);
  await remove.locator('input[placeholder="id"]').fill(id);
  const cancellation = await execute(remove, 'DELETE', `/api/v1/observations/${id}`, 200);
  assert.equal(cancellation.observation.status, 'cancelled');
  cancelled = true;
  const stored = await page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
  assert.ok(!JSON.stringify(stored).includes(token), 'Credential must not enter browser storage');
  await page.reload();
  await page.locator('.opblock').nth(8).waitFor();
  await page.waitForFunction(() => Boolean(window.ui));
  const authAfterReload = await page.evaluate(() => window.ui.authSelectors.authorized().toJS());
  assert.equal(Object.keys(authAfterReload).length, 0, 'Authorization must not persist after reload');
  await open(op('post', '/api/v1/observations'));
  await op('post', '/api/v1/observations').locator('textarea.body-param__text').fill(JSON.stringify(data));
  await execute(op('post', '/api/v1/observations'), 'POST', '/api/v1/observations', 401);
  assert.deepEqual(external, [], 'Docs must not contact validators, CDNs, or query-selected specs');
  assert.deepEqual(credentialLeaks, [], 'Credential only sent on the intended same-origin mutations');
  assert.deepEqual(errors, [], 'Swagger UI runtime errors');
  console.log('Docs browser smoke passed: nine local operations, protected device/research reads, public GET, guarded write, UI authorize/create/cancel, no credential persistence or external requests.');
} catch (error) {
  // Playwright action diagnostics can include a fill() argument on failure.
  const redact = text => String(text).split(token).join('[REDACTED]');
  const safe = new Error(redact(error?.message ?? error));
  safe.stack = redact(error?.stack ?? safe.stack);
  throw safe;
} finally {
  try {
    if (attemptedWrite && !cancelled) {
      const response = await fetch(`${origin}/api/v1/observations/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      assert.ok([200, 404].includes(response.status), 'Local synthetic-record cleanup failed');
    }
  } finally { await browser.close(); }
}
