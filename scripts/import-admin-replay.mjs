#!/usr/bin/env node
/** Authenticated aggregate import. Never uploads raw CPRAW, addresses or payloads. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const hash = x => createHash('sha256').update(x).digest('hex');

export function prepareAdminReplay(input, id, label = 'TF 历史采集 · 完整回放') {
  check(input.schema === 'campuspulse-cpraw-replay/1' && input.provenance.complete_source === true, 'A complete validated CPRAW aggregate is required.');
  check(input.provenance.total_reports === input.provenance.replayed_reports, 'Replay source counts differ.');
  return { schema: 'campuspulse-replay-import/1', id, label, place_id: null,
    window_ms: input.window_ms, bin_ms: input.bin_ms,
    source: { sha256: input.provenance.source_sha256, total_reports: input.provenance.total_reports,
      replayed_reports: input.provenance.replayed_reports, time_semantics: 'historical_capture',
      clock_anchors: input.provenance.source_clock_anchors },
    windows: input.windows.map(w => ({ source_start_mono_us: w.source_start_mono_us, source_end_mono_us: w.source_end_mono_us, item: w.item })) };
}
async function hiddenPassword() {
  check(process.stdin.isTTY, 'Login requires a terminal for hidden password entry.');
  process.stderr.write('Administrator password (hidden): ');
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', receive); process.stderr.write('\n'); };
    const receive = chunk => {
      for (const c of chunk.toString('utf8')) {
        if (c === '\r' || c === '\n') { finish(); resolve(value); return; }
        if (c === '\u0003') { finish(); reject(new Error('Login cancelled.')); return; }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (c >= ' ') value += c;
      }
    };
    process.stdin.on('data', receive);
  });
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    check(['--origin', '--input', '--id', '--session', '--phase', '--username'].includes(args[i]) && args[i + 1], 'Invalid arguments.');
    options[args[i].slice(2)] = args[i + 1];
  }
  const origin = options.origin;
  check(origin === 'https://pulse.anend.net' || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin), 'Pinned production or loopback origin required.');
  check(options.session && ['login', 'import', 'verify'].includes(options.phase), 'Use --session PRIVATE_FILE --phase login|import|verify.');
  async function request(route, init = {}) {
    return fetch(origin + '/api/v1/admin' + route, { redirect: 'error', ...init,
      headers: { Origin: origin, ...init.headers }, signal: AbortSignal.timeout(30000) });
  }
  if (options.phase === 'login') {
    let password = await hiddenPassword();
    const response = await request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: options.username ?? 'admin', password }) });
    password = '';
    check(response.status === 200, `Administrator login failed (HTTP ${response.status}).`);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    check(cookie?.startsWith('cp_admin_session='), 'Missing signed administrator session.');
    const folder = path.dirname(options.session); await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(options.session, JSON.stringify({ origin, cookie }) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('Administrator session established; secret input was not stored.'); return;
  }
  const sessionStat = await stat(options.session);
  check((sessionStat.mode & 0o077) === 0, 'Session file must be private.');
  const session = JSON.parse(await readFile(options.session, 'utf8'));
  check(session.origin === origin && typeof session.cookie === 'string', 'Session origin mismatch.');
  check(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.id ?? ''), 'Valid replay id required.');
  const input = options.input ? JSON.parse(await readFile(options.input, 'utf8')) : null;
  const body = input ? JSON.stringify(prepareAdminReplay(input, options.id)) : null;
  if (options.phase === 'import') {
    check(body && Buffer.byteLength(body) <= 262144, 'Bounded aggregate input required.');
    const response = await request('/replays', { method: 'POST', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' }, body });
    const result = await response.json();
    check([200, 201].includes(response.status), `Replay import rejected (HTTP ${response.status}; ${result.error?.code ?? 'unknown'}).`);
    console.log(JSON.stringify({ phase: 'import', status: response.status, id: options.id, input_sha256: hash(body), windows: input.windows.length, reports: input.provenance.replayed_reports }));
  }
  const response = await request('/replays/' + options.id, { headers: { Cookie: session.cookie } });
  const view = await response.json();
  check(response.status === 200 && view.schema === 'campuspulse-replay-view/1' && view.dataset === 'controlled_test', 'Replay read failed.');
  if (body) check(view.body_sha256 === hash(body) && view.windows.length === input.windows.length &&
    view.windows.reduce((n, w) => n + w.item.reports.worker, 0) === input.provenance.replayed_reports, 'Online replay differs from complete source.');
  if (body) {
    const compiled = await build({ stdin: { contents: "export {validateReplayImport} from './worker/admin-replays';",
      resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
    const { validateReplayImport } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
    const expected = validateReplayImport(JSON.parse(body));
    check(JSON.stringify(view.windows) === JSON.stringify(expected.windows) && JSON.stringify(view.source_metadata) === JSON.stringify(expected.source_metadata),
      'Replay window values differ from validated source.');
  }
  console.log(JSON.stringify({ phase: 'verify', id: options.id, windows: view.windows.length,
    reports: view.windows.reduce((n, w) => n + w.item.reports.worker, 0),
    frontend: origin + '/?capture_replay=' + options.id }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message?.startsWith('Replay') || error.message?.startsWith('Administrator') ? error.message : 'Replay operation failed; private session and aggregate were not printed.'); process.exitCode = 1; });
