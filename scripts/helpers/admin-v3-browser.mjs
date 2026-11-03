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
   Object.defineProperty(navigator,'serial',{configurable:true,value:{async requestPort(){let c;return{readable:new ReadableStream({start(controller){c=controller;}}),writable:new WritableStream({write(bytes){const text=new TextDecoder().decode(bytes);writes.push(text);if(text.startsWith('HELLO '))c.enqueue(new TextEncoder().encode('V3 HELLO '+JSON.stringify({node_id:node,boot_id:boot,request_id:text.trim().slice(6),mono_ms:1234,...window.syntheticV3State})+'\n'));if(text.startsWith('V3START '))c.enqueue(new TextEncoder().encode('V3 START ACCEPTED\n'));}}),async open(){},async setSignals(){},async close(){}};}}});
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
   const trigger=page.getByRole('button',{name:'查看「V3 能力与应用状态」的说明',exact:true}),helpPanel=page.getByRole('dialog',{name:'能力声明与设备确认分开核对',exact:true}),closeHelp=page.getByRole('button',{name:'关闭「V3 能力与应用状态」的说明',exact:true});
   await trigger.hover();await expect(helpPanel).toBeVisible();await expect(helpPanel).toHaveCSS('pointer-events','none');await expect(helpPanel).not.toHaveClass(/is-pinned/);
   // An explicit click turns the preview into a readable, interactive panel.
   await trigger.click();await expect(helpPanel).toHaveClass(/is-pinned/);await expect(helpPanel).toHaveCSS('pointer-events','auto');await closeHelp.click();await expect(helpPanel).not.toBeVisible();await expect(trigger).toBeFocused();
   // Keyboard focus can enter the preview and pin it without requiring a mouse.
   await trigger.blur();await trigger.focus();await expect(helpPanel).toBeVisible();await expect(helpPanel).toHaveCSS('pointer-events','none');await page.keyboard.press('Tab');await expect(helpPanel.getByLabel('能力声明与设备确认分开核对详细说明',{exact:true})).toBeFocused();await expect(helpPanel).toHaveClass(/is-pinned/);await expect(closeHelp).toBeVisible();await page.keyboard.press('Escape');await expect(helpPanel).not.toBeVisible();await expect(trigger).toBeFocused();
   await page.setViewportSize({width:390,height:360});await trigger.click();await expect(helpPanel).toHaveClass(/is-pinned/);await expect(helpPanel).toHaveCSS('pointer-events','auto');
   assert.equal(await helpPanel.evaluate(el=>el.scrollHeight>el.clientHeight),true,'A pinned help panel must offer bounded scrolling on a short viewport');await helpPanel.hover();await page.mouse.wheel(0,600);await expect.poll(()=>helpPanel.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);await expect(helpPanel).toBeVisible();await closeHelp.click();await expect(helpPanel).not.toBeVisible();
   await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Admin mobile layout');await page.setViewportSize({width:1440,height:1000});
  }
  if(['all','purposes'].includes(focus)){
   await page.getByRole('button',{name:'登记位置变更',exact:true}).click();const dialog=page.getByRole('dialog',{name:'登记位置变更',exact:true});
   await dialog.getByLabel('目标地点',{exact:true}).selectOption('library');await dialog.getByLabel('新部署 ID',{exact:true}).fill('synthetic-new-placement');
   await dialog.getByRole('button',{name:'检查并登记',exact:true}).click();await page.getByRole('button',{name:'确认登记位置',exact:true}).click();
   await expect(dialog).not.toBeVisible();const p=await db.prepare('SELECT observation_kinds_json FROM placements WHERE id=?').bind('synthetic-new-placement').first();assert.equal(p.observation_kinds_json,'["activity"]');
  }
  if(['all','usb'].includes(focus)&&!useWebkit){
   const caPem=readFileSync('firmware/certs/digicert-global-root-g2.crt','utf8');
   let clockRequests=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/v3/clock/key')clockRequests++;});
   for(const security of ['personal','open','enterprise_peap']){
    await page.getByRole('button',{name:'连接 V3 USB',exact:true}).click();const d=page.getByRole('dialog',{name:'连接并部署 V3 设备',exact:true});
    await d.getByRole('button',{name:'选择 USB 串口并核对 V3 身份',exact:true}).click();await d.getByText('已登记',{exact:true}).waitFor();
    const before=await page.evaluate(()=>window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')).length);
    await d.getByLabel('设备凭证',{exact:true}).fill(token);await d.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic WiFi');
    await d.getByLabel('个人 Wi-Fi 密码',{exact:true}).fill('synthetic-wifi-password');
    if(security==='enterprise_peap'){
     await d.getByLabel('保存并自动启动',{exact:true}).check();await d.getByLabel('本次统计窗口数',{exact:true}).selectOption('0');
    }
    await d.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption(security);
    if(security==='personal')await d.getByLabel('个人 Wi-Fi 密码',{exact:true}).fill('synthetic-wifi-password');
    if(security==='open')await expect(d.getByLabel('个人 Wi-Fi 密码',{exact:true})).toHaveCount(0);
    if(security==='enterprise_peap'){
     const save=d.getByLabel('保存并自动启动',{exact:true});await expect(save).not.toBeChecked();await expect(save).toBeDisabled();
     await expect(d.getByLabel('本次统计窗口数',{exact:true})).toHaveValue('1');await expect(d.getByLabel('本次统计窗口数',{exact:true}).locator('option[value="0"]')).toHaveCount(0);
     await d.getByText(/当前持久启动配置尚未保存 PEAP 验证选择/).waitFor();
     const fillPeap=async()=>{await d.getByLabel('PEAP 认证服务器验证',{exact:true}).selectOption('ca');await d.getByLabel('PEAP 外层身份',{exact:true}).fill('synthetic_outer_identity');await d.getByLabel('PEAP 用户名',{exact:true}).fill('synthetic_eap_username');await d.getByLabel('PEAP 密码',{exact:true}).fill('synthetic_eap_password');await d.getByLabel('PEAP CA 证书 PEM',{exact:true}).fill(caPem);await d.getByLabel('PEAP 预期服务器域名',{exact:true}).fill('radius.example.test');};
     await fillPeap();await d.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption('personal');await expect(d.getByLabel('个人 Wi-Fi 密码',{exact:true})).toHaveValue('');
     await d.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption('enterprise_peap');for(const label of ['PEAP 外层身份','PEAP 用户名','PEAP 密码'])await expect(d.getByLabel(label,{exact:true})).toHaveValue('');
     await fillPeap();await d.getByLabel('本次统计窗口数',{exact:true}).selectOption('3');
    }
    await d.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}).click();await d.getByRole('button',{name:'重新核对 MQTT 授权',exact:true}).waitFor();
    const startButton=d.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true});await expect(startButton).toBeEnabled();await startButton.click();await d.getByText(/已收到 V3 START ACCEPTED/).waitFor();
    const safe=await page.evaluate(({caPem})=>{const starts=window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')),b=JSON.parse(starts.at(-1).slice(8));const stored=JSON.stringify({...localStorage,...sessionStorage})+location.href;return{count:starts.length,protocol:b.uplink_transport,windows:b.max_windows,security:b.security,emptyPassword:b.password==='',eapKeys:Object.keys(b).filter(key=>key.startsWith('eap_')).sort(),eapExact:b.security!=='enterprise_peap'||b.eap_ca_pem===caPem&&b.eap_domain==='radius.example.test'&&b.eap_identity==='synthetic_outer_identity'&&b.eap_username==='synthetic_eap_username'&&b.eap_password==='synthetic_eap_password',legacy:Object.hasOwn(b,'capture_config_id'),save:Object.hasOwn(b,'save_startup'),persisted:['synthetic-browser-device-token','synthetic-wifi-password','synthetic_eap_password','synthetic_outer_identity','synthetic_eap_username','BEGIN CERTIFICATE','radius.example.test'].some(value=>stored.includes(value))};},{caPem});
    assert.deepEqual(safe,{count:before+1,protocol:'mqtt_tls',windows:security==='enterprise_peap'?3:1,security,emptyPassword:security!=='personal',eapKeys:security==='enterprise_peap'?['eap_ca_pem','eap_domain','eap_identity','eap_password','eap_server_verification','eap_username']:[],eapExact:true,legacy:false,save:false,persisted:false});
    await d.getByRole('button',{name:'关闭对话框',exact:true}).click();
   }
   for(const security of ['personal','open','enterprise_peap']){
    await page.getByRole('button',{name:'连接 V3 USB',exact:true}).click();const invalid=page.getByRole('dialog',{name:'连接并部署 V3 设备',exact:true});
    await invalid.getByRole('button',{name:'选择 USB 串口并核对 V3 身份',exact:true}).click();await invalid.getByText('已登记',{exact:true}).waitFor();
    await expect(invalid.getByText(/当前 USB 的 SSID、个人密码、PEAP 用户名、外层身份和密码仅支持可打印 ASCII/)).toBeVisible();
    await invalid.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption(security);await invalid.getByLabel('设备凭证',{exact:true}).fill(token);await invalid.getByLabel('Wi-Fi SSID',{exact:true}).fill(security==='open'?'Synthetic中文':'Synthetic WiFi');
    if(security==='personal')await invalid.getByLabel('个人 Wi-Fi 密码',{exact:true}).fill('synthetic_中文_password');
    if(security==='enterprise_peap'){
     await invalid.getByLabel('PEAP 认证服务器验证',{exact:true}).selectOption('ca');await invalid.getByLabel('PEAP 外层身份',{exact:true}).fill('synthetic_outer_identity');await invalid.getByLabel('PEAP 用户名',{exact:true}).fill('synthetic_eap_username');await invalid.getByLabel('PEAP 密码',{exact:true}).fill('synthetic_中文_password');await invalid.getByLabel('PEAP CA 证书 PEM',{exact:true}).fill(caPem);await invalid.getByLabel('PEAP 预期服务器域名',{exact:true}).fill('radius.example.test');
    }
    await invalid.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}).click();await invalid.getByRole('button',{name:'重新核对 MQTT 授权',exact:true}).waitFor();
    const before=await page.evaluate(()=>window.syntheticV3Usb.length);await invalid.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await expect(invalid.getByRole('alert')).toContainText('可打印 ASCII');
    assert.equal(await page.evaluate(()=>window.syntheticV3Usb.length),before,'Non-ASCII '+security+' must fail before all serial writes');
    await expect(invalid.getByLabel('设备凭证',{exact:true})).toHaveValue('');await expect(invalid.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true})).toBeDisabled();
    await invalid.getByRole('button',{name:'关闭对话框',exact:true}).click();
   }
   // A failed local check and page departure both scrub all held credentials.
   await page.getByRole('button',{name:'连接 V3 USB',exact:true}).click();const rejected=page.getByRole('dialog',{name:'连接并部署 V3 设备',exact:true});
   await rejected.getByRole('button',{name:'选择 USB 串口并核对 V3 身份',exact:true}).click();await rejected.getByText('已登记',{exact:true}).waitFor();
   await rejected.getByLabel('设备凭证',{exact:true}).fill(token);await rejected.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic WiFi');await rejected.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption('enterprise_peap');
   const fillRejected=async domain=>{await rejected.getByLabel('PEAP 认证服务器验证',{exact:true}).selectOption('ca');await rejected.getByLabel('PEAP 外层身份',{exact:true}).fill('synthetic_outer_identity');await rejected.getByLabel('PEAP 用户名',{exact:true}).fill('synthetic_eap_username');await rejected.getByLabel('PEAP 密码',{exact:true}).fill('synthetic_eap_password');await rejected.getByLabel('PEAP CA 证书 PEM',{exact:true}).fill(caPem);await rejected.getByLabel('PEAP 预期服务器域名',{exact:true}).fill(domain);};
   await fillRejected('https://invalid.example.test');await rejected.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}).click();await rejected.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();
   await rejected.getByText(/PEAP 预期服务器域名须为单个 DNS 名称/).waitFor();
   await expect(rejected.getByLabel('PEAP 认证服务器验证',{exact:true})).toHaveValue('ca');for(const label of ['PEAP CA 证书 PEM','PEAP 预期服务器域名'])await expect(rejected.getByLabel(label,{exact:true})).toHaveValue('');
   for(const label of ['设备凭证','PEAP 外层身份','PEAP 用户名','PEAP 密码'])await expect(rejected.getByLabel(label,{exact:true})).toHaveValue('');
   await expect(rejected.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true})).toBeDisabled();
   assert.equal(await page.evaluate(()=>window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')).length),3,'Invalid domain cannot send credentials');
   await rejected.getByLabel('设备凭证',{exact:true}).fill(token);await fillRejected('radius.example.test');await rejected.getByLabel('PEAP CA 证书 PEM',{exact:true}).fill('invalid CA');await rejected.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}).click();await rejected.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await expect(rejected.getByRole('alert')).toContainText('PEM CA');await expect(rejected.getByLabel('PEAP 认证服务器验证',{exact:true})).toHaveValue('ca');await expect(rejected.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true})).toBeDisabled();assert.equal(await page.evaluate(()=>window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')).length),3);
   await rejected.getByLabel('设备凭证',{exact:true}).fill(token);await fillRejected('radius.example.test');await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
   for(const label of ['设备凭证','PEAP 外层身份','PEAP 用户名','PEAP 密码'])await expect(rejected.getByLabel(label,{exact:true})).toHaveValue('');
   await rejected.getByRole('button',{name:'关闭对话框',exact:true}).click();
   assert.equal(clockRequests,0,'Manual modes must never fetch startup clock keys');
   const openSaved=async state=>{await page.evaluate(value=>{window.syntheticV3State=value;},state);await page.getByRole('button',{name:'连接 V3 USB',exact:true}).click();const d=page.getByRole('dialog',{name:'连接并部署 V3 设备',exact:true});await d.getByRole('button',{name:'选择 USB 串口并核对 V3 身份',exact:true}).click();await d.getByText('已登记',{exact:true}).waitFor();await d.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic WiFi');await d.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption('open');return d;};
   const closeSaved=async d=>d.getByRole('button',{name:'关闭对话框',exact:true}).click();
   const startCount=()=>page.evaluate(()=>window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')).length);
   let mqttReads=0;const countMqtt=request=>{if(new URL(request.url()).pathname===`/api/v1/admin/devices/${node}/mqtt`)mqttReads++;};page.on('request',countMqtt);
   // Same-node saved-ready credentials stay on the device, including PEAP without CA.
   const saved=await openSaved({credential_state:'ready',mqtt_state:'ready'});
   await expect(saved.getByLabel('设备凭证',{exact:true})).toHaveCount(0);await expect(saved.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true})).toHaveCount(0);
   await saved.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption('enterprise_peap');await expect(saved.getByLabel('PEAP 认证服务器验证',{exact:true})).toHaveValue('none');await expect(saved.getByText(/未验证认证服务器：账户和密码可能被假冒服务器获取/)).toBeVisible();
   for(const [label,value] of [['PEAP 外层身份','synthetic_outer'],['PEAP 用户名','synthetic_user'],['PEAP 密码','synthetic_password']])await saved.getByLabel(label,{exact:true}).fill(value);
   // Switching verification clears trust material and does not retain it in an unverified frame.
   await saved.getByLabel('PEAP 认证服务器验证',{exact:true}).selectOption('ca');await saved.getByLabel('PEAP CA 证书 PEM',{exact:true}).fill(caPem);await saved.getByLabel('PEAP 预期服务器域名',{exact:true}).fill('radius.example.test');await saved.getByLabel('PEAP 认证服务器验证',{exact:true}).selectOption('none');await saved.getByLabel('PEAP 认证服务器验证',{exact:true}).selectOption('ca');await expect(saved.getByLabel('PEAP CA 证书 PEM',{exact:true})).toHaveValue('');await expect(saved.getByLabel('PEAP 预期服务器域名',{exact:true})).toHaveValue('');await saved.getByLabel('PEAP 认证服务器验证',{exact:true}).selectOption('none');
   await saved.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await saved.getByText(/已收到 V3 START ACCEPTED/).waitFor();
   const local=await page.evaluate(()=>{const b=JSON.parse(window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')).at(-1).slice(8));return{credential:b.reuse_saved_credential,mqtt:b.reuse_saved_mqtt,mode:b.eap_server_verification,secrets:['device_token','mqtt_uri','mqtt_username','mqtt_password','mqtt_namespace','eap_ca_pem','eap_domain'].filter(k=>Object.hasOwn(b,k))};});assert.deepEqual(local,{credential:true,mqtt:true,mode:'none',secrets:[]});assert.equal(mqttReads,0);await closeSaved(saved);
   // Missing token, unavailable storage and legacy unknown states never silently mint.
   for(const state of ['missing','unavailable',undefined]){const d=await openSaved(state?{credential_state:state,mqtt_state:state}:{});await expect(d.getByLabel('设备凭证',{exact:true})).toHaveCount(1);await expect(d.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true})).toBeDisabled();await closeSaved(d);}
   // A saved token plus missing MQTT uses the protected existing-authorization read only.
   const partial=await openSaved({credential_state:'ready',mqtt_state:'missing'});await expect(partial.getByLabel('设备凭证',{exact:true})).toHaveCount(0);await expect(partial.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true})).toBeDisabled();// Reproduce the hover + form-scroll path that previously let help text intercept MQTT recovery.
   const readMqtt=partial.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}),wifiHelp=partial.getByRole('dialog',{name:'选择实际网络认证',exact:true});await partial.getByRole('button',{name:'查看「Wi-Fi 认证方式」的说明',exact:true}).hover();await expect(wifiHelp).toBeVisible();await expect(wifiHelp).toHaveCSS('pointer-events','none');await readMqtt.scrollIntoViewIfNeeded();await readMqtt.click();await partial.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await partial.getByText(/已收到 V3 START ACCEPTED/).waitFor();assert.equal(mqttReads,1);assert.deepEqual(await page.evaluate(()=>{const b=JSON.parse(window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')).at(-1).slice(8));return{saved:b.reuse_saved_credential,token:Object.hasOwn(b,'device_token'),mqtt:typeof b.mqtt_password};}),{saved:true,token:false,mqtt:'string'});await closeSaved(partial);
   // Saved locally does not prove current broker acceptance: a deliberate server override persists across failures.
   const override=await openSaved({credential_state:'ready',mqtt_state:'ready'}),overrideReads=mqttReads,overrideStarts=await startCount(),mqttUrl=`${base}/api/v1/admin/devices/${node}/mqtt`;
   await override.getByRole('button',{name:'改用服务器 MQTT 授权',exact:true}).click();assert.equal(mqttReads,overrideReads,'Choosing override must not issue a secret request');await expect(override.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true})).toBeDisabled();
   await page.route(mqttUrl,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'synthetic_mqtt_unavailable'})}));
   await override.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}).click();await expect(override.getByRole('alert')).toBeVisible();assert.equal(mqttReads,overrideReads+1);await expect(override.getByRole('button',{name:'改用服务器 MQTT 授权',exact:true})).toHaveCount(0);await expect(override.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true})).toBeVisible();await expect(override.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true})).toBeDisabled();assert.equal(await startCount(),overrideStarts);await page.unroute(mqttUrl);
   await override.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}).click();await override.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic中文');await override.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await expect(override.getByRole('alert')).toContainText('ASCII');await expect(override.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true})).toBeVisible();await expect(override.getByRole('button',{name:'改用服务器 MQTT 授权',exact:true})).toHaveCount(0);await expect(override.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true})).toBeDisabled();assert.equal(await startCount(),overrideStarts);
   await override.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic WiFi');await override.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}).click();await override.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await override.getByText(/已收到 V3 START ACCEPTED/).waitFor();assert.deepEqual(await page.evaluate(()=>{const b=JSON.parse(window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')).at(-1).slice(8));return{savedToken:b.reuse_saved_credential,providedMqtt:typeof b.mqtt_password,savedMqtt:Object.hasOwn(b,'reuse_saved_mqtt'),token:Object.hasOwn(b,'device_token')};}),{savedToken:true,providedMqtt:'string',savedMqtt:false,token:false});assert.equal(mqttReads,overrideReads+3);await closeSaved(override);
   // UI readiness is never a substitute for the fresh HELLO state or boot identity.
   for(const fresh of [{credential_state:'missing',mqtt_state:'ready'},{credential_state:'ready',mqtt_state:'unavailable'},{credential_state:'ready',mqtt_state:'ready',boot_id:'22222222-2222-4222-8222-222222222222'},{credential_state:'ready',mqtt_state:'ready',node_id:'cp_ffeeddccbbaa'}]){const d=await openSaved({credential_state:'ready',mqtt_state:'ready'}),before=await startCount();await page.evaluate(value=>{window.syntheticV3State=value;},fresh);await d.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await expect(d.getByRole('alert')).toBeVisible();assert.equal(await startCount(),before);await closeSaved(d);}
   // A newly minted enrollment always supplies its new secrets even if old local slots look ready.
   const mockMqtt={uri:'mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883',username:'synthetic_enroll_user',password:'synthetic_enroll_password',namespace:'synthetic_new'},newToken='synthetic_new_enrollment_token_32characters';
   const deviceUrl=`${base}/api/v1/admin/devices/${node}`,devicesUrl=`${base}/api/v1/admin/devices`;
   await page.route(deviceUrl,route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'not_found'})}));
   await page.route(devicesUrl,route=>route.request().method()==='POST'?route.fulfill({contentType:'application/json',body:JSON.stringify({device:{id:node},credential:newToken,mqtt:mockMqtt})}):route.continue());
   const enroll=async()=>{await page.evaluate(()=>{window.syntheticV3State={credential_state:'ready',mqtt_state:'ready'};});await page.getByRole('button',{name:'连接 V3 USB',exact:true}).click();const d=page.getByRole('dialog',{name:'连接并部署 V3 设备',exact:true});await d.getByRole('button',{name:'选择 USB 串口并核对 V3 身份',exact:true}).click();await d.getByRole('button',{name:'登记此设备并分配 MQTT 授权',exact:true}).click();await d.getByLabel('Wi-Fi SSID',{exact:true}).waitFor();return d;};
   const failedEnrollment=await enroll();await failedEnrollment.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic中文');await failedEnrollment.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption('open');const beforeEnrollment=await startCount();await failedEnrollment.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await expect(failedEnrollment.getByRole('alert')).toContainText('ASCII');await expect(failedEnrollment.getByLabel('设备凭证',{exact:true})).toHaveValue('');await expect(failedEnrollment.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true})).toBeVisible();await expect(failedEnrollment.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true})).toBeDisabled();assert.equal(await startCount(),beforeEnrollment);await closeSaved(failedEnrollment);
   const enrollment=await enroll();await enrollment.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic WiFi');await enrollment.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption('open');await enrollment.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true}).click();await enrollment.getByText(/已收到 V3 START ACCEPTED/).waitFor();assert.deepEqual(await page.evaluate(({newToken,mockMqtt})=>{const b=JSON.parse(window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')).at(-1).slice(8));return{token:b.device_token===newToken,mqtt:b.mqtt_password===mockMqtt.password,reuse:Object.hasOwn(b,'reuse_saved_credential')||Object.hasOwn(b,'reuse_saved_mqtt')};},{newToken,mockMqtt}),{token:true,mqtt:true,reuse:false});await closeSaved(enrollment);await page.unroute(deviceUrl);await page.unroute(devicesUrl);page.off('request',countMqtt);
   // Reproduce the blocked form with synthetic inputs only: a legacy HELLO
   // omits saved-state fields, while backup token and protected MQTT are supplied.
   for(const outerIdentity of ['', 'synthetic_anonymous']){
    const d=await openSaved({}),start=d.getByRole('button',{name:'发送并启动有界 V3 采集',exact:true});
    await d.getByLabel('Wi-Fi 认证方式',{exact:true}).selectOption('enterprise_peap');
    await expect(d.getByLabel('PEAP 认证服务器验证',{exact:true})).toHaveValue('none');
    await expect(d.getByText('可选；留空时使用 PEAP 用户名，也可按网络管理员要求指定匿名外层身份。',{exact:true})).toBeVisible();
    const descriptionId=await start.getAttribute('aria-describedby');assert.ok(descriptionId);
    const reasons=d.locator(`[id="${descriptionId}"]`);
    await expect(start).toBeDisabled();await expect(reasons).toContainText('请填写 PEAP 用户名。');await expect(reasons).toContainText('请填写 PEAP 密码。');
    await d.getByLabel('PEAP 用户名',{exact:true}).fill('synthetic_eap_username');
    await expect(start).toBeDisabled();await expect(reasons).not.toContainText('请填写 PEAP 用户名。');await expect(reasons).toContainText('请填写 PEAP 密码。');
    await d.getByLabel('PEAP 密码',{exact:true}).fill('synthetic_eap_password');
    await expect(start).toBeDisabled();await expect(reasons).toContainText('请填写本设备的备份设备凭证');
    await d.getByLabel('设备凭证',{exact:true}).fill(token);await expect(start).toBeDisabled();await expect(reasons).toContainText('请读取本设备已验证 MQTT 授权');
    await d.getByLabel('PEAP 外层身份',{exact:true}).fill(outerIdentity);
    await d.getByRole('button',{name:'读取本设备已验证 MQTT 授权',exact:true}).click();await expect(start).toBeEnabled();await expect(reasons).toBeEmpty();
    const before=await startCount();await start.click();await d.getByText(/已收到 V3 START ACCEPTED/).waitFor();assert.equal(await startCount(),before+1);
    assert.deepEqual(await page.evaluate(expected=>{const b=JSON.parse(window.syntheticV3Usb.filter(s=>s.startsWith('V3START ')).at(-1).slice(8));return{identity:b.eap_identity===expected,username:b.eap_username==='synthetic_eap_username',mode:b.eap_server_verification,token:typeof b.device_token,mqtt:typeof b.mqtt_password,noCa:!Object.hasOwn(b,'eap_ca_pem')&&!Object.hasOwn(b,'eap_domain')};},outerIdentity||'synthetic_eap_username'),{identity:true,username:true,mode:'none',token:'string',mqtt:'string',noCa:true});
    await closeSaved(d);
   }

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
