import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

// Read-only frontend benchmark. Never opens a record form or sends API writes.
// A visible browser is intentional: software/headless canvas timings can differ
// radically from hardware-accelerated desktop Chrome.
const out = path.resolve(process.env.PERF_DIR || 'captures/performance/verification');
const targets = [process.env.BASELINE_URL, process.env.BASE_URL || 'http://127.0.0.1:5199/'].filter(Boolean);
const headless = process.env.HEADLESS === '1';
const width = Number(process.env.VIEW_WIDTH || 1920), height = Number(process.env.VIEW_HEIGHT || 1080);
const dpr = Number(process.env.DEVICE_SCALE_FACTOR || 2);
const tileCache = new Map();
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless });
const results = [];
const runs = [
  ...(targets.length > 1 ? [{ url: targets[0], warmup: true, index: -1 }] : []),
  ...targets.map((url, index) => ({ url, warmup: false, index })),
];
try {
  for (const { url, warmup, index } of runs) {
    const quality = warmup || index === 0 && targets.length > 1
      ? process.env.BASELINE_QUALITY || 'full' : process.env.LIGHTING_QUALITY || 'efficient';
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
    await context.addInitScript(value => localStorage.setItem('campuspulse.lighting-quality', value), quality);
    // Keep this renderer comparison independent of backend availability and
    // each server's default field/demo setting. These are browser-local GET
    // fixtures; no backend state is created or changed.
    await context.route('**/api/v1/**', route => {
      if (route.request().method() !== 'GET') throw new Error('Unexpected API write in lighting benchmark');
      const pathname = new URL(route.request().url()).pathname;
      const json = pathname === '/api/v1/settings' ? { site_name: 'CampusPulse', default_mode: 'demo' }
        : pathname === '/api/v1/places' ? { places: [], truncated: false }
        : pathname.endsWith('/history') ? { observations: [] } : { latest_observation: null };
      return route.fulfill({ json });
    });
    // Both runs use the same official online tile bytes, retained only in this
    // process. This is neither a bundled raster nor a persistent GIS mirror.
    await context.route('https://gis.ccnu.edu.cn/**', async route => {
      const key = route.request().url();
      if (!tileCache.has(key)) tileCache.set(key, route.fetch({ timeout: 15_000 }).then(async response => {
        if (!response.ok()) throw new Error(`Official tile returned ${response.status()}`);
        return { status: response.status(), headers: response.headers(), body: await response.body() };
      }).catch(error => { tileCache.delete(key); throw error; }));
      try { await route.fulfill(await tileCache.get(key)); }
      catch { await route.continue(); }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__lightingPerf = { tasks: [], peakCanvasBytes: 0 };
      new PerformanceObserver(list => window.__lightingPerf.tasks.push(...list.getEntries()
        .map(entry => ({ start: entry.startTime, duration: entry.duration }))))
        .observe({ type: 'longtask', buffered: true });
      setInterval(() => {
        const bytes = [...document.querySelectorAll('canvas')]
          .reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0);
        window.__lightingPerf.peakCanvasBytes = Math.max(window.__lightingPerf.peakCanvasBytes, bytes);
      }, 100);
    });
    console.log(`${warmup ? 'Warming official tiles for' : 'Measuring'} ${url} (${quality}, ${width}x${height}, DPR ${dpr}, ${headless ? 'headless' : 'visible'})`);
    let complete = false;
    for (let attempt = 0; attempt < (warmup ? 3 : 1); attempt++) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '模拟演示', exact: true }).click();
      await page.getByRole('button', { name: '深色', exact: true }).click();
      await page.waitForFunction(() => {
        const library = [...document.querySelectorAll('.cp-library-light-host')];
        const campus = [...document.querySelectorAll('.cp-campus-light-host')];
        return library.length === 2 && campus.length === 2
          && library.every(host => Boolean(host.dataset.model))
          && (campus.every(host => host.dataset.materialStatus === 'ready')
            || campus.every(host => host.dataset.runningJobs === '0')
              && campus.some(host => +host.dataset.failedChunks > 0));
      }, undefined, { timeout: 90_000 });
      const statuses = await page.locator('.cp-campus-light-host').evaluateAll(els => els.map(el => ({ ...el.dataset })));
      complete = statuses.every(host => host.materialStatus === 'ready');
      if (complete) break;
      if (!warmup) throw new Error(`Official source incomplete; this is not a valid performance sample: ${JSON.stringify(statuses)}`);
      // Only warm-up may retry a transient source-image failure. A measured run
      // is never silently replaced or counted as fully rendered after failure.
      console.log(`Warm-up ${attempt + 1}: waiting for official source requests before retrying`);
      await Promise.allSettled([...tileCache.values()]);
    }
    if (!complete) throw new Error('Official source warm-up remained incomplete');
    const startup = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return { readyMs: performance.now(), ...window.__lightingPerf,
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
        library: [...document.querySelectorAll('.cp-library-light-host')].map(host => ({ ...host.dataset })),
        campus: [...document.querySelectorAll('.cp-campus-light-host')].map(host => ({ ...host.dataset })),
        canvasBytes: [...document.querySelectorAll('canvas')].reduce((sum, c) => sum + c.width * c.height * 4, 0),
      };
    });
    if (warmup) { await context.close(); continue; }
    const startFrames = await page.locator('.cp-activity-layer').evaluateAll(canvases => canvases.map(c => +c.dataset.drawFrame));
    const motionStart = performance.now();
    await page.waitForTimeout(3000);
    const endFrames = await page.locator('.cp-activity-layer').evaluateAll(canvases => canvases.map(c => +c.dataset.drawFrame));
    const motionMs = performance.now() - motionStart;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(150);
    const panStart = performance.now();
    const detail = page.locator('.detail-scene .cp-map');
    await detail.focus();
    for (let n = 0; n < 12; n++) { await page.keyboard.press(n % 2 ? 'ArrowLeft' : 'ArrowRight'); await page.waitForTimeout(80); }
    const panMs = performance.now() - panStart;
    const alignment = await page.locator('.cp-map').evaluateAll(maps => maps.map(map => {
      const raster = new DOMMatrixReadOnly(getComputedStyle(map.querySelector('.cp-map__raster')).transform);
      const layer = map.querySelector('.cp-library-light-host');
      return { raster: [raster.a, raster.e, raster.f], library: [+layer.dataset.worldScale, +layer.dataset.worldX, +layer.dataset.worldY] };
    }));
    for (const map of alignment) for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(map.raster[axis] - map.library[axis]) > (axis ? .02 : .00001)) throw new Error('Raster/library registration changed');
    }
    const result = { url, quality, headless, officialTilesPrewarmed: targets.length > 1,
      viewport: { width, height, dpr }, startup, motionMs,
      motionFrames: endFrames.map((n, i) => n - startFrames[i]), panMs, alignment, errors };
    results.push(result);
    await fs.writeFile(path.join(out, `run-${index + 1}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ url, quality, readyMs: Math.round(startup.readyMs),
      maxLongTaskMs: Math.round(Math.max(0, ...startup.tasks.map(task => task.duration))),
      blockingMs: Math.round(startup.tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0)),
      canvasMiB: +(startup.canvasBytes / 1048576).toFixed(1),
      peakCanvasMiB: +(startup.peakCanvasBytes / 1048576).toFixed(1),
      motionFps: result.motionFrames.map(n => +(n / motionMs * 1000).toFixed(1)), panMs: Math.round(panMs), errors }));
    await context.close();
  }
  await fs.writeFile(path.join(out, 'comparison.json'), JSON.stringify(results, null, 2));
  if (results.some(result => result.errors.length)) process.exitCode = 1;
} finally { await browser.close(); }
