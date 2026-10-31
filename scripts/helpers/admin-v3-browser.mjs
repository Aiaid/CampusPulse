// Real React browser + ephemeral real workerd/D1. Synthetic peers only.
// No production requests, physical serial devices, screenshots or secret logs.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {chromium,webkit,expect} from '@playwright/test';
import {installAdminCosmeticFilter} from '../admin-cosmetic-filter-fixture.mjs';

export async function runAdminV3Browser(focus='all') {
 const source=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*']});
 const utility=await build({stdin:{contents:"export {statisticsCapabilities} from './tests/helpers/v3-statistics-policy-fixtures'; export {v3Registration,v3Ack} from './tests/helpers/device-v3-fixtures'; export {encryptMqttPassword} from './worker/mqtt-credentials'; export {statisticsFixture,seedStatistics,statisticsBatch} from './tests/helpers/v3-statistics-fixtures';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm'});
 const helpers=await import('data:text/javascript;base64,'+Buffer.from(utility.outputFiles[0].text).toString('base64'));
 const bootstrap='synthetic-browser-admin-bootstrap',token='synthetic-browser-device-token-32characters',node='cp_001122aabbcc',placement='synthetic-v3-placement';
 const key='BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
 const mf=new Miniflare(convertV4MiniflareOptions({port:0,host:'127.0.0.1',log:new Log(LogLevel.ERROR),workers:[{name:'admin-v3-browser',modules:true,script:source.outputFiles[0].text,
  compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['RAW_BUCKET'],
  assets:{directory:'./dist',binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true},assetConfig:{not_found_handling:'single-page-application'}},
  bindings:{ADMIN_TOKEN:bootstrap,MQTT_PROVISIONING_KEY:key,DEVICE_V3_CONTROL_ENABLED:'true',DEVICE_V3_STATISTICS_ENABLED:'true',DEVICE_V3_PRODUCER_VERSIONS:'["synthetic-statistics/1","cp-v3-small/1"]'}}]}));
 let browser;
 try {
  const base=(await mf.ready).origin,db=await mf.getD1Database('DB');
  for(const name of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort())await db.exec(readFileSync(`migrations/${name}`,'utf8').replace(/^--.*$/gm,'').replace(/\n/g,' '));
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256,name,board) VALUES(?,?,?,?)').bind(node,createHash('sha256').update(token).digest('hex'),'Synthetic V3 management node','Synthetic capability fixture').run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)').bind(placement,node,'library').run();
  const row={id:randomUUID(),username:'synthetic_user',namespace:'synthetic_ns'};
  const encrypted=await helpers.encryptMqttPassword({MQTT_PROVISIONING_KEY:key},row,'synthetic-broker-private-password');
  await db.prepare("INSERT INTO mqtt_credentials(id,username,namespace,password_ciphertext,state,node_id,created_at,verified_at) VALUES(?,?,?,?,'assigned',?,?,?)").bind(row.id,row.username,row.namespace,encrypted,node,new Date().toISOString(),new Date().toISOString()).run();
  const deviceRequest=async(path,body)=>{const r=await fetch(base+'/api/v3/device/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,'Synthetic V3 device request '+path);return r.json();};
  const caps=helpers.statisticsCapabilities(node);caps.uplink.transports=['mqtt_tls'];caps.summary.max_addresses=256;
  await deviceRequest('capabilities',helpers.v3Registration(caps));
  const diagnosticToken='synthetic-independent-diagnostics-token';
  const diagnostic={node:'synthetic-diagnostics',placement:'synthetic-diagnostics-placement'};
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(diagnostic.node,createHash('sha256').update(diagnosticToken).digest('hex')).run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,NULL,0)').bind(diagnostic.placement,diagnostic.node).run();
  const f=await helpers.statisticsFixture(diagnostic.node,diagnostic.placement);f.caps.producer_version='synthetic-statistics/1';
  // Seed authority and then submit exact bytes through the actual HTTPS handler
  // in this local workerd. No external HTTPS endpoint is contacted.
  const utilityDigest=await build({stdin:{contents:"export {capabilityDigestV3} from './worker/device-v3-config';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm'});
  const {capabilityDigestV3}=await import('data:text/javascript;base64,'+Buffer.from(utilityDigest.outputFiles[0].text).toString('base64'));
  f.policy.control.capability_sha256=await capabilityDigestV3(f.caps);await helpers.seedStatistics(db,f);
  const bytes=JSON.stringify(await helpers.statisticsBatch(f)),headers={Authorization:'Bearer '+diagnosticToken,'Content-Type':'application/json','X-Body-SHA256':createHash('sha256').update(bytes).digest('hex')};
  const receipt=await mf.dispatchFetch('https://synthetic-admin.example.test/api/v3/statistics/ingest',{method:'POST',headers,body:bytes});assert.equal(receipt.status,200,JSON.stringify(await receipt.json()));
  const useWebkit=process.argv.includes('--webkit');
  const binary=process.env.CHROMIUM_PATH||(existsSync(chromium.executablePath())?chromium.executablePath():'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  browser=useWebkit?await webkit.launch({headless:true}):await chromium.launch({headless:true,executablePath:binary,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await installAdminCosmeticFilter(context);
  if(process.argv.includes('--fallback'))await context.addInitScript(()=>{delete HTMLElement.prototype.showPopover;delete HTMLElement.prototype.hidePopover;});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  if(!useWebkit)await context.addInitScript(({node,boot})=>{
   const writes=[];Object.defineProperty(window,'syntheticV3Usb',{value:writes});
   Object.defineProperty(navigator,'serial',{configurable:true,value:{async requestPort(){let c;return{readable:new ReadableStream({start(controller){c=controller;}}),writable:new WritableStream({write(bytes){const text=new TextDecoder().decode(bytes);writes.push(text);if(text.startsWith('HELLO '))c.enqueue(new TextEncoder().encode('V3 HELLO '+JSON.stringify({node_id:node,boot_id:boot,request_id:text.trim().slice(6),mono_ms:1234})+'\n'));if(text.startsWith('V3START '))c.enqueue(new TextEncoder().encode('V3 START ACCEPTED\n'));}}),async open(){},async setSignals(){},async close(){}};}}});
  },{node,boot:caps.boot_id});
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.name));
  await page.goto(base+'/admin');
  await page.getByLabel('初始化凭证',{exact:true}).fill(bootstrap);await page.getByRole('button',{name:'验证并初始化账号',exact:true}).click();
  await page.getByLabel('用户名',{exact:true}).fill('v3-browser-admin');await page.getByLabel('显示名称',{exact:true}).fill('Synthetic administrator');
  await page.getByLabel('新密码',{exact:true}).fill('synthetic-v3-browser-password');await page.getByLabel('确认新密码',{exact:true}).fill('synthetic-v3-browser-password');
  await page.getByRole('button',{name:'创建管理员账号',exact:true}).click();await page.getByRole('heading',{name:'运行概览',exact:true}).waitFor();
  const nav=label=>page.getByRole('navigation',{name:'管理导航'}).getByRole('button',{name:label,exact:true}).click();
  await nav('设备管理');await page.getByRole('button',{name:`查看设备 ${node}`,exact:true}).click();
  await page.getByRole('heading',{name:'V3 能力与应用状态',exact:true}).waitFor();
  if(['all','config','help'].includes(focus)){
   await page.getByLabel('部署位置',{exact:true}).selectOption(placement);await page.getByRole('button',{name:'根据当前能力准备 V3 策略',exact:true}).click();
   const editor=page.getByLabel('V3 策略 JSON',{exact:true});await editor.waitFor();const prepared=JSON.parse(await editor.inputValue());
   assert.equal(prepared.protocol,'campuspulse/3');assert.equal(prepared.uplink.transport,'mqtt_tls');assert.equal(prepared.local_raw.mode,'off');assert.equal(prepared.collection.summary.max_addresses,256);
   await editor.fill(JSON.stringify({...prepared,collection:{...prepared.collection,summary:{...prepared.collection.summary,max_addresses:512}}},null,2));
   await page.getByRole('button',{name:'校验能力与策略',exact:true}).click();await page.getByText('能力或策略不兼容，发布已禁用。',{exact:true}).waitFor();
   await expect(page.getByRole('button',{name:'发布不可变 V3 assignment',exact:true})).toBeDisabled();
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM device_assignments_v3 WHERE node_id=?').bind(node).first()).n,0);
   await editor.fill(JSON.stringify(prepared,null,2));await page.getByRole('button',{name:'校验能力与策略',exact:true}).click();
   await expect(page.getByRole('button',{name:'发布不可变 V3 assignment',exact:true})).toBeEnabled();
   await page.getByRole('button',{name:'发布不可变 V3 assignment',exact:true}).click();await page.getByText('等待设备',{exact:true}).first().waitFor();
   const assignment=await db.prepare('SELECT envelope_json FROM device_assignments_v3 WHERE node_id=?').bind(node).first();assert.ok(assignment);
   assert.equal((await db.prepare('SELECT applied_generation FROM device_control_v3 WHERE node_id=?').bind(node).first()).applied_generation,null);
   await deviceRequest('config/ack',await helpers.v3Ack(JSON.parse(assignment.envelope_json).policy));
   await page.getByRole('button',{name:'刷新设备状态',exact:true}).click();await page.getByText('设备确认应用',{exact:true}).first().waitFor();
   await page.getByRole('button',{name:'查看不可变策略',exact:true}).click();await page.getByRole('dialog',{name:'不可变 V3 策略',exact:true}).waitFor();await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
  }
  if(['all','help'].includes(focus)){
   const trigger=page.getByRole('button',{name:'查看「V3 能力与应用状态」的说明',exact:true});await trigger.click();await page.getByText('能力声明与设备确认分开核对',{exact:true}).waitFor();await page.keyboard.press('Escape');
   await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Admin mobile layout');await page.setViewportSize({width:1440,height:1000});
  }
  if(['all','purposes'].includes(focus)){
   await page.getByRole('button',{name:'登记位置变更',exact:true}).click();const dialog=page.getByRole('dialog',{name:'登记位置变更',exact:true});
   await dialog.getByLabel('目标地点',{exact:true}).selectOption('library');await dialog.getByLabel('新部署 ID',{exact:true}).fill('synthetic-new-placement');
   await dialog.getByRole('button',{name:'检查并登记',exact:true}).click();await page.getByRole('button',{name:'确认登记位置',exact:true}).click();
   await expect(dialog).not.toBeVisible();const p=await db.prepare('SELECT observation_kinds_json FROM placements WHERE id=?').bind('synthetic-new-placement').first();assert.equal(p.observation_kinds_json,'["activity"]');
  }
  if(['all','usb'].includes(focus)&&!useWebkit){
   await page.getByRole('button',{name:'连接 V3 USB',exact:true}).click();const d=page.getByRole('dialog',{name:'连接并部署 V3 设备',exact:true});
   await d.getByRole('button',{name:'选择 USB 串口并核对 V3 身份',exact:true}).click();await d.getByText('已登记',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>window.syntheticV3Usb.some(s=>s.startsWith('V3START '))),false);
   await d.getByLabel('设备凭证',{exact:true}).fill(token);await d.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic WiFi');await d.getByLabel('个人 Wi-Fi 密码',{exact:true}).fill('synthetic-wifi-password');
   await d.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}).click();await d.getByRole('button',{name:'重新核对 MQTT 授权',exact:true}).waitFor();
   await d.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await d.getByText(/已收到 V3 START ACCEPTED/).waitFor();
   const safe=await page.evaluate(()=>{const starts=window.syntheticV3Usb.filter(s=>s.startsWith('V3START '));const b=JSON.parse(starts[0].slice(8));return{count:starts.length,protocol:b.uplink_transport,windows:b.max_windows,legacy:Object.hasOwn(b,'capture_config_id'),persisted:JSON.stringify({...localStorage,...sessionStorage}).includes('synthetic-browser-device-token')};});
   assert.deepEqual(safe,{count:1,protocol:'mqtt_tls',windows:1,legacy:false,persisted:false});await d.getByRole('button',{name:'关闭对话框',exact:true}).click();
  }
  if(['all','diagnostics'].includes(focus)){
   await page.getByRole('button',{name:'全部设备',exact:true}).click();await page.getByRole('button',{name:`查看设备 ${diagnostic.node}`,exact:true}).click();
   await page.getByRole('heading',{name:'V3 上传与保管回执',exact:true}).waitFor();await page.getByText('已提交；绑定匹配',{exact:true}).waitFor();
   await page.getByText('查看回执',{exact:true}).first().click();await page.getByText(/"original_request_bytes_rehashed": false/).waitFor();
   await page.getByRole('heading',{name:'V3 运行诊断',exact:true}).waitFor();await page.getByText('未提供 / 未校准',{exact:true}).waitFor();
  }
  assert.deepEqual(errors,[],'Browser runtime errors');
  console.log(`V3 admin browser passed (${focus}): real workerd/D1, capability rejection, immutable/pending/ACK boundaries, scoped UI checks; synthetic evidence only.`);
 } finally {await browser?.close();await mf.dispose();}
}
