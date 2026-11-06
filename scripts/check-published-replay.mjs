#!/usr/bin/env node
/** HTTP + actual React-component verification; deliberately not a browser test. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const check = (v, code) => { if (!v) throw new Error(code); };
const hash = b => createHash('sha256').update(b).digest('hex');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) options[args[i].slice(2)] = args[i + 1];
try {
  check(options.origin === 'https://pulse.anend.net' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.id ?? ''), 'pinned_target_required');
  const sessionMetadata = await stat(options.session);
  check((sessionMetadata.mode & 0o077) === 0, 'private_session_required');
  const session = JSON.parse(await readFile(options.session, 'utf8'));
  check(session.origin === options.origin, 'session_origin_mismatch');
  const response = await fetch(`${options.origin}/api/v1/admin/replays/${options.id}`, { headers: { Cookie: session.cookie, Origin: options.origin }, redirect: 'error' });
  check(response.status === 200 && response.headers.get('cache-control') === 'private, no-store', 'private_replay_read');
  const data = await response.json();
  const compiled = await build({ stdin: { contents: `export {default as Panel} from './src/campus/ControlledReplayPanel.jsx'; export {default as Timeline} from './src/campus/ControlledReplayTimeline.jsx'; export {normalizeControlledReplay} from './src/campus/controlled-replay-data.js'; export {createElement} from 'react'; export {renderToStaticMarkup} from 'react-dom/server';`, resolveDir: ROOT, loader: 'jsx' },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', loader: { '.css': 'empty' }, jsx: 'automatic', logLevel: 'silent',
    banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))});` } });
  const rendering = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  rendering.normalizeControlledReplay(data, options.id);
  const renderAt = index => {
    const state = { data, index, selectedWindow: data.windows[index], loading: false, error: '', unauthorized: false,
      playing: false, seek() {}, togglePlaying() {}, refresh() {} };
    return rendering.renderToStaticMarkup(rendering.createElement('div', null,
      rendering.createElement(rendering.Panel, { session: state }), rendering.createElement(rendering.Timeline, { session: state })));
  };
  const first = renderAt(0), last = renderAt(data.windows.length - 1);
  check(first.includes('602,315') && first.includes('data-dataset="controlled_test"') && first.includes('max="112"'), 'full_source_card_and_axis_render');
  check(last.includes('42.339') && last.includes('非完整窗口'), 'partial_tail_card_render');
  const page = await fetch(options.origin + '/?capture_replay=' + options.id, { redirect: 'error', cache: 'no-store' });
  const html = await page.text();
  const localHtml = await readFile(path.join(ROOT, 'dist/index.html'), 'utf8');
  check(page.status === 200 && hash(html) === hash(localHtml), 'published_main_entry_matches_build');
  const appFiles = (await import('node:fs/promises')).readdir;
  const app = (await appFiles(path.join(ROOT, 'dist/assets'))).find(name => /^App-.*\.js$/.test(name));
  check(app, 'main_app_asset_present');
  const onlineAsset = await fetch(options.origin + '/assets/' + app, { cache: 'no-store', redirect: 'error' });
  const asset = Buffer.from(await onlineAsset.arrayBuffer());
  check(onlineAsset.status === 200 && hash(asset) === hash(await readFile(path.join(ROOT, 'dist/assets', app))) && asset.toString().includes('capture_replay'), 'published_main_app_matches_build');
  const unauthenticated = await fetch(`${options.origin}/api/v1/admin/replays/${options.id}`, { redirect: 'error' });
  check(unauthenticated.status === 401, 'replay_not_public');
  const field = await fetch(options.origin + '/api/v3/places/library/statistics', { redirect: 'error' });
  const fieldBody = await field.json();
  check(field.status === 200 && fieldBody.schema === 'public-statistics/3' && !JSON.stringify(fieldBody).includes('historical_cpraw'), 'field_route_stays_independent');
  const report = { schema: 'published-main-replay-check/1', result: 'passed', origin: options.origin, id: options.id,
    windows: data.windows.length, reports: data.source_metadata.replayed_reports, dataset: data.dataset,
    first_markup_sha256: hash(first), last_markup_sha256: hash(last), entry_sha256: hash(html), main_asset_sha256: hash(asset),
    checks: ['frontend_source_normalizer', 'first_and_partial_tail_card_static_render', 'complete_fixed_axis_static_render',
      'published_main_entry_and_asset_match', 'authenticated_replay_read', 'anonymous_denied', 'independent_field_route'],
    render_mode: 'react_static_markup_not_browser', browser_visual_validation: 'blocked_by_work_browser_setting' };
  await mkdir(path.dirname(options.output), { recursive: true, mode: 0o700 });
  await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, windows: report.windows, reports: report.reports, checks: report.checks.length, browser_visual_validation: report.browser_visual_validation }));
} catch (error) {
  console.error('Published replay check failed: ' + (/^[a-z_]+$/.test(error.message ?? '') ? error.message : 'verification_failed'));
  process.exitCode = 1;
}
