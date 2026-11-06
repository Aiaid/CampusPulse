#!/usr/bin/env node
/** Local-only debug environment. Never loads .dev.vars or remote bindings. */
import { randomBytes, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createSimulatedV3Device, createSimulationPolicy } from './lib/v3-simulated-device.mjs';
import { simulatorPage } from './lib/v3-simulator-page.mjs';
import { loadV3Replay } from './lib/v3-replay-source.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NODE = 'sim-v3-01', PLACEMENT = 'sim-v3-library';
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const check = (value, message) => { if (!value) throw new Error(message); };

export function parseSimulatorArgs(args) {
  const result = { port: 5174, cadenceMs: 1000, scenario: 'quiet', view: 'test' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    check(value !== undefined, 'Each option needs a value.');
    if (key === '--port') result.port = Number(value);
    else if (key === '--window-ms') result.cadenceMs = Number(value);
    else if (key === '--scenario') result.scenario = value;
    else if (key === '--replay') result.replayFile = value;
    else if (key === '--view') result.view = value;
    else throw new Error('Unknown option. Use --port, --window-ms, --scenario, --view or --replay.');
  }
  check(Number.isInteger(result.port) && result.port >= 1024 && result.port <= 65535, 'Port must be 1024–65535.');
  check([1000, 30000, 60000].includes(result.cadenceMs), 'Window must be 1000, 30000 or 60000ms.');
  check(['quiet', 'busy', 'loss', 'offline', 'failed'].includes(result.scenario), 'Unknown scenario.');
  check(['test', 'live'].includes(result.view), 'View must be test or live.');
  check(!result.replayFile || result.view !== 'live', 'Historical replay cannot enter the local live view.');
  return result;
}

async function bundledModule(contents) {
  const output = await build({ stdin: { contents, resolveDir: ROOT, loader: 'ts' }, bundle: true, write: false,
    format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}

async function requestBody(request, limit = 32768) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function sendResponse(outgoing, response) {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) outgoing.setHeader(name, value);
  if (response.headers.getSetCookie?.().length) outgoing.setHeader('Set-Cookie', response.headers.getSetCookie());
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

/** Each launch gets an independent ephemeral D1 and random local identities. */
export async function startV3Simulator(options = {}) {
  check(!options.replayFile || options.view !== 'live', 'Historical replay cannot enter the local live view.');
  const replay = options.replayFile ? await loadV3Replay(options.replayFile) : null;
  check(!replay || !['busy', 'loss'].includes(options.scenario), 'Synthetic activity injection is unavailable during historical replay.');
  const { port, cadenceMs, scenario, view } = parseSimulatorArgs([
    '--port', String(options.port ?? 5174), '--window-ms', String(replay?.window_ms ?? options.cadenceMs ?? 1000), '--scenario', options.scenario ?? 'quiet',
    '--view', options.view ?? 'test',
  ]);
  // This permission is injected only by the local launcher, which owns an
  // independent, nonpersistent Miniflare D1. It never changes a remote policy.
  const localConfiguration = view === 'live' ? Object.freeze({ storage: 'ephemeral-local-d1', dataset: 'field', purpose: 'site_observation' }) : undefined;
  const dataset = localConfiguration?.dataset ?? 'controlled_test';
  const origin = `http://127.0.0.1:${port}`;
  const secret = token(), deviceBearer = token(), webhookKey = token();
  let mf, vite, device, interval, closing = false, lastError = null, rebootCount = 0;
  let serial = Promise.resolve();
  const exclusive = operation => {
    if (closing) return Promise.reject(new Error('Simulator is stopping.'));
    const result = serial.then(operation);
    serial = result.catch(() => {});
    return result;
  };
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(interval);
    await serial;
    device?.stop();
    try { await vite?.close(); } finally { await mf?.dispose(); }
  }
  try {
    const bundle = await build({ absWorkingDir: ROOT, entryPoints: ['worker/index.ts'], bundle: true, write: false,
      format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
    const relay = await build({ absWorkingDir: ROOT, entryPoints: ['relay/emqx-cloud/worker.mjs'], bundle: true, write: false,
      format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:crypto'], logLevel: 'silent',
      plugins: [{ name: 'local-only-reply-publisher', setup(builder) {
        builder.onResolve({ filter: /^\.\/mqtt-publish\.mjs$/ }, () => ({ path: path.join(ROOT, 'relay/emqx-cloud/test/publisher-fixture.mjs') }));
      } }] });
    const replies = new Map();
    const transportStatus = { framing: 'CPV3', path: 'local-relay/DO/service-binding', broker: 'simulated', native_tls: 'not_tested', requests: 0, replies: 0 };
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'campuspulse-v3-simulator', modules: true,
      script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'], r2Buckets: ['RAW_BUCKET'],
      bindings: { DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true',
        DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1"]',
        ADMIN_TOKEN: secret, OPERATOR_TOKEN: token(), RESEARCH_TOKEN: token() },
    }, { name: 'campuspulse-v3-simulator-relay', modules: true, script: relay.outputFiles[0].text,
      compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
      bindings: { WEBHOOK_KEY: webhookKey, BROKER_HOST: 'simulator.example.invalid', MQTT_USERNAME: 'sim-relay', MQTT_PASSWORD: token() },
      durableObjects: { RPC_GUARDS: { className: 'EmqxRpc', useSQLite: true } },
      serviceBindings: { INGEST_SERVICE: { name: 'campuspulse-v3-simulator', entrypoint: 'MqttDeviceApi' } },
      outboundService: async request => {
        const url = new URL(request.url);
        check(url.hostname === 'synthetic-reply.invalid', 'Unexpected simulator relay outbound request.');
        replies.set(url.pathname.slice(1), Buffer.from(await request.arrayBuffer())); transportStatus.replies++;
        return new Response(null, { status: 204 });
      },
    }], log: new Log(LogLevel.ERROR) }));
    const db = await mf.getD1Database('DB', 'campuspulse-v3-simulator');
    for (const filename of (await readdir(path.join(ROOT, 'migrations'))).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
      const sql = await readFile(path.join(ROOT, 'migrations', filename), 'utf8');
      await db.exec(sql.replace(/^--.*$/gm, '').replace(/\n/g, ' '));
    }
    await db.prepare('INSERT INTO device_nodes(id,credential_sha256,name,board) VALUES(?,?,?,?)')
      .bind(NODE, hash(deviceBearer), replay ? 'V3 模拟设备（历史回放）' : 'V3 模拟设备（合成测试）', 'software-simulator / no hardware').run();
    await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)').bind(PLACEMENT, NODE, 'library', 0).run();
    await db.prepare("INSERT INTO mqtt_credentials(id,username,namespace,password_ciphertext,state,node_id,created_at,verified_at) VALUES('sim-mqtt','sim-v3','sim-v3','simulated-not-a-broker-secret','assigned',?,?,?)")
      .bind(NODE, new Date().toISOString(), new Date().toISOString()).run();
    const relayWorker = await mf.getWorker('campuspulse-v3-simulator-relay');
    let rpc = 0;
    async function deviceRequest(pathname, init) {
      const url = new URL(pathname, 'https://v3-simulator.example.test');
      const operations = { '/api/v3/device/capabilities': 1, '/api/v3/device/config': 2,
        '/api/v3/device/config/ack': 3, '/api/v3/device/lease': 4, '/api/v3/statistics/ingest': 5 };
      const op = operations[url.pathname];
      check(op, 'Unsupported simulated device request.');
      const boot = device.capabilities.boot_id;
      const topic = `cp/v1/sim-v3/${boot}/req/ingest/${++rpc}`, replyTopic = topic.replace('/req/', '/rep/');
      const frame = Buffer.concat([Buffer.from([67, 80, 86, 51, 1, op, 0, 0]), Buffer.from(init.body ?? '')]);
      transportStatus.requests++;
      const response = await relayWorker.fetch('https://v3-simulator.example.test/emqx', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CP-Webhook-Key': webhookKey },
        body: JSON.stringify({ username: 'sim-v3', qos: 1, retain: false, published_at_ms: Date.now(), topic, payload_b64: frame.toString('base64') }) });
      const reply = replies.get(replyTopic); replies.delete(replyTopic);
      check(response.status === 204 && reply?.length >= 2, 'Local CPV3 gateway did not deliver a matching reply.');
      return new Response(reply.subarray(2), { status: reply.readUInt16BE(0), headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    const { createAdminSession } = await bundledModule("export {createAdminSession} from './worker/admin-auth';");
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind('sim-admin', 'sim-admin', '本地模拟环境管理员', 'local-session-only', 'sim-admin-handle', now, now).run();
    async function mintSession() {
      const session = await createAdminSession(secret);
      await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version,reauthenticated_at_ms) VALUES(?,?,?,'admin','sim-admin',1,?)")
        .bind(session.hash, new Date().toISOString(), session.expires, Date.now()).run();
      return { cookie: `cp_admin_session=${session.value}`, hash: session.hash };
    }
    // Browser logout must not revoke the launcher's independent assignment session.
    const internalSession = await mintSession(), cookie = internalSession.cookie;
    let browserSessionHash;
    async function assign() {
      const inspection = await mf.dispatchFetch(`${origin}/api/v1/admin/device-v3/nodes/${NODE}`, { headers: { Cookie: cookie } });
      check(inspection.status === 200, 'Cannot inspect local device.');
      const state = await inspection.json();
      const generation = (state.desired?.policy?.assignment_generation ?? 0) + 1;
      const policy = await createSimulationPolicy(device.capabilities, { placementId: PLACEMENT, cadenceMs, generation, localConfiguration });
      const result = await mf.dispatchFetch(origin + '/api/v1/admin/device-v3/assignments', { method: 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy, expected_generation: generation - 1 }) });
      if (result.status !== 200) {
        const error = await result.json();
        throw new Error(`Local assignment rejected (${result.status}: ${error.error?.code ?? 'unknown'}).`);
      }
    }
    async function boot(nextScenario) {
      device = await createSimulatedV3Device({ nodeId: NODE, deviceBearer, cadenceMs, scenario: nextScenario,
        transport: 'mqtt_tls', request: deviceRequest, replay, localConfiguration });
      // Register before enabling the requested offline scenario.
      if (nextScenario === 'offline') device.setScenario('quiet');
      await device.start();
      check(device.status().registered, 'Local device registration failed.');
      await assign();
      await device.tick();
      check(!device.status().lastError, 'Local device policy activation failed.');
      if (nextScenario === 'offline') device.setScenario('offline');
    }
    await boot(scenario);
    const snapshot = () => ({ schema: 'campuspulse-v3-simulator/1', dataset, view, isolation: 'ephemeral-local-d1', node_id: NODE,
      window_ms: device.status().cadenceMs, reboot_count: rebootCount, last_error: lastError, transport: { ...transportStatus },
      source: replay ? 'historical_cpraw_replay' : 'synthetic',
      device: device.status(), urls: { admin: '/__simulator/admin', public: '/?mode=field&place=library' } });
    const plugin = {
      name: 'campuspulse-local-v3-simulator',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          // A strict Host check also protects local auto-login against DNS rebinding.
          if (req.headers.host !== new URL(origin).host) { res.statusCode = 403; res.end('Local simulator host required.'); return; }
          const pathname = new URL(req.url, origin).pathname;
          if (!pathname.startsWith('/__simulator') && !pathname.startsWith('/api/')) return next();
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          try {
            if (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
              res.statusCode = 403; res.end('Same-origin access required.'); return;
            }
            if (pathname.startsWith('/api/')) {
              const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await requestBody(req);
              const headers = new Headers();
              for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
              const response = await mf.dispatchFetch(origin + req.url, { method: req.method, headers, ...(body ? { body } : {}) });
              await sendResponse(res, response); return;
            }
            if (req.method === 'GET' && pathname === '/__simulator') {
              res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(simulatorPage()); return;
            }
            if (req.method === 'GET' && pathname === '/__simulator/status') {
              res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(snapshot())); return;
            }
            if (req.method === 'GET' && pathname === '/__simulator/admin') {
              const session = await mintSession();
              if (browserSessionHash) await db.prepare('DELETE FROM admin_sessions WHERE token_sha256=?').bind(browserSessionHash).run();
              browserSessionHash = session.hash;
              res.setHeader('Set-Cookie', `${session.cookie}; HttpOnly; SameSite=Strict; Path=/api/v1/admin; Max-Age=28800`);
              res.statusCode = 302; res.setHeader('Location', '/admin'); res.end(); return;
            }
            if (req.method !== 'POST') { res.statusCode = 404; res.end('Not found.'); return; }
            if (req.headers.origin !== origin) { res.statusCode = 403; res.end('Same-origin access required.'); return; }
            if (req.headers['content-type'] !== 'application/json') { res.statusCode = 415; res.end('Use application/json.'); return; }
            const value = JSON.parse((await requestBody(req, 1024)).toString('utf8'));
            if (pathname === '/__simulator/scenario') {
              check(value && Object.keys(value).length === 1 && ['quiet', 'busy', 'loss', 'offline', 'failed'].includes(value.scenario), 'Unknown scenario.');
              check(!replay || !['busy', 'loss'].includes(value.scenario), 'Synthetic activity injection is unavailable during historical replay.');
              await exclusive(async () => {
                const previous = device.status().scenario;
                device.setScenario(value.scenario);
                if (value.scenario === 'failed' || previous === 'failed') await assign();
                await device.tick(); lastError = null;
              });
            } else if (pathname === '/__simulator/retry') {
              check(value && Object.keys(value).length === 0, 'Use an empty object.');
              await exclusive(async () => { device.retryPending(); await device.tick(); lastError = null; });
            } else if (pathname === '/__simulator/reboot') {
              check(value && Object.keys(value).length === 0, 'Use an empty object.');
              await exclusive(async () => {
                // Stop, drain pending eligible batches and retain them if reboot cannot safely proceed.
                await device.tick();
                check(!device.status().pendingItems && !device.status().pendingControlItems, 'Resolve pending requests before reboot.');
                const currentScenario = device.status().scenario;
                device.stop(); await boot(currentScenario); rebootCount++; lastError = null;
              });
            } else { res.statusCode = 404; res.end('Not found.'); return; }
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(snapshot()));
          } catch (error) {
            lastError = '模拟操作未完成；检查设备状态。重启前须先恢复网络并确认所有待处理回执。';
            res.statusCode = error.status ?? 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: { code: 'simulator_request_failed', message: lastError } }));
          }
        });
      },
    };
    vite = await createServer({ root: ROOT, configFile: false, plugins: [react(), plugin],
      server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
    await vite.listen();
    let tickPending = false;
    interval = setInterval(() => {
      if (tickPending || closing) return;
      tickPending = true;
      exclusive(() => device.tick()).then(() => { lastError = null; }, () => { lastError = '模拟设备请求失败；冻结批次保留等待重试。'; })
        .finally(() => { tickPending = false; });
    }, 250);
    return { origin, close, snapshot, db, mf };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let simulator;
  try {
    simulator = await startV3Simulator(parseSimulatorArgs(process.argv.slice(2)));
    console.log(`V3 模拟设备（${simulator.snapshot().source === 'historical_cpraw_replay' ? '历史采集回放' : '合成数据'} / ${simulator.snapshot().dataset} / 临时本地数据库）: ${simulator.origin}/__simulator`);
    console.log(`正常现场前台：${simulator.origin}${simulator.snapshot().urls.public}`);
    console.log('本地管理后台：控制面板中点击自动登录。Ctrl+C 停止；临时数据库和会话队列随进程结束清空。');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await simulator.close(); process.exit(0); });
  } catch {
    console.error('V3 模拟环境启动失败；确认端口未被占用、依赖已安装。使用 --port 指定其他端口。');
    process.exitCode = 1;
  }
}
