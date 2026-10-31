// Local synthetic workerd/D1 plus real browser. No production or radio claim.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {chromium,expect} from '@playwright/test';
import {v3BrowserFlags,seedV3BrowserWindow} from './helpers/v3-browser-fixtures.mjs';
assert.ok(existsSync('dist/index.html'),'Build first');expect.configure({timeout:15000});
const source=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*']});
const mf=new Miniflare(convertV4MiniflareOptions({port:0,host:'127.0.0.1',workers:[{name:'v3-automatic-browser',modules:true,script:source.outputFiles[0].text,compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:v3BrowserFlags,assets:{directory:'./dist',binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true},assetConfig:{not_found_handling:'single-page-application'}}}]}));
let browser;
try{
 const base=(await mf.ready).origin,db=await mf.getD1Database('DB');assert.equal(new URL(base).hostname,'127.0.0.1');
 for(const name of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort())await db.exec(readFileSync('migrations/'+name,'utf8').replace(/^--.*$/gm,'').replace(/\n/g,' '));
 await db.prepare('UPDATE places SET observation_kinds_json=? WHERE id=?').bind('["activity","parking","elevator"]','library').run();
 await seedV3BrowserWindow(db,base,{request:(u,o)=>mf.dispatchFetch(u.replace(/^http:/,'https:'),o)});
 const summary=await(await fetch(base+'/api/v1/places/library/summary')).json();assert.equal(summary.sensor.protocol,'campuspulse/3');assert.equal(summary.sensor.visible_identifiers,2);assert.equal(summary.automatic_observations.vehicles.reason,'classification_unavailable');assert.equal(summary.automatic_observations.vehicles.candidate_count,null);
 for(const path of ['/api/v1/ingest','/api/v2/ingest','/api/v2/device/contact'])assert.equal((await fetch(base+path,{method:'POST'})).status,404);
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||(existsSync(chromium.executablePath())?chromium.executablePath():'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.name));await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==base)return route.abort();if(req.method()!=='GET')writes.push(req.method());return route.continue();});
 await page.goto(base+'/?mode=field&place=library');const live=page.getByRole('region',{name:'现场实时数据'});
 await expect(live).toContainText('2 个 BLE 可见标识');await expect(live).toContainText('当前识别规则尚未校准');await expect(live).not.toContainText('0 个电动车相关候选标识');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const axis=page.getByRole('slider',{name:'现场数据时间轴',exact:true});await axis.press('ArrowLeft');
 const replay=page.getByRole('region',{name:'现场历史回放'});await expect(replay).toContainText('自动分析尚未归档到此历史时间轴');await expect(replay.locator('.field-data-automatic')).toHaveCount(0);
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 console.log('V3 real D1/browser: statistics, exact retry, retired protocols, unknown classification, mobile layout and replay separation passed.');
}finally{await browser?.close();await mf.dispose();}
