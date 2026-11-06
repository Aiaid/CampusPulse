/** Isolated React browser acceptance with synthetic API/Web Serial only. */
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium,expect} from '@playwright/test';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';

const server=await createServer({configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:5187,strictPort:true}});
await server.listen();
const binary=process.env.CHROMIUM_PATH||(existsSync(chromium.executablePath())?chromium.executablePath():'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const browser=await chromium.launch({headless:true,executablePath:binary});
try {
 const page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[];page.setDefaultTimeout(10000);
 page.on('pageerror',error=>errors.push(error.message));
 const spki=Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5','hex').toString('base64url');
 await page.route('https://pulse.anend.net/api/v3/clock/key',async route=>{
  assert.equal(route.request().headers().authorization,undefined);assert.equal(route.request().headers().cookie,undefined);
  await route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({schema:'cp-v3-signed-clock-key/1',audience:'https://pulse.anend.net',key_id:'synthetic-key-1',public_key_spki:spki})});
 });
 const html=await server.transformIndexHtml('/startup-qa.html',`<html><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';
 import Provisioning from '/src/admin/Provisioning.jsx';import {V3Configuration} from '/src/admin/Configs.jsx';
 import {AdminContext} from '/src/admin/shared.jsx';import '/src/admin/admin.css';
 const initialMode=new URLSearchParams(location.search).has('initial'),raceMode=new URLSearchParams(location.search).get('race');
 const node='cp_001122aabbcc',end=Date.now()+1200000,digest='a'.repeat(64);
 let assigned=!initialMode;window.capabilityDelay=initialMode?3:0;
 let applied=false,serialEmit,boot='11111111-1111-4111-8111-111111111111',safeRequired=true;
 const policy={node_id:node,assignment_generation:initialMode?1:4,policy_id:'synthetic-policy',collection:{enabled:true,summary:{enabled:true,window_ms:60000}},temporal:{mode:'rolling'},evidence:{mode:'statistics',schema:'window-statistics/1',extractor_version:'cp-v3-stats/1',ruleset_version:'unclassified-v1'},local_raw:{mode:'off'},local_queue:{mode:'durable'},uplink:{enabled:true,transport:'mqtt_tls',streams:['window_statistics','node_status'],raw_sample:{mode:'off'},archive:{mode:'off'}},custody:{accept_until:new Date(end+3600000).toISOString()},control:{activation:{boot_id:boot,expires_at:new Date(end).toISOString()}}};
 const control=()=>({protocol:'campuspulse/3',node_id:node,state:applied?'applied':'pending',capabilities:{boot_id:window.cloudBoot||(window.capabilityDelay>0?'33333333-3333-4333-8333-333333333333':boot),expires_at:new Date(window.capExpired?0:end+1200000).toISOString()},desired:assigned?{policy,policy_sha256:digest}:null,last_applied_policy:applied?{policy,policy_sha256:digest}:null,applied_generation:applied?policy.assignment_generation:null,acknowledgement:applied?{state:'applied',policy_id:policy.policy_id,policy_sha256:window.badDigest?'b'.repeat(64):digest,assignment_generation:policy.assignment_generation,boot_id:boot,durability:'committed',evidence:'device_ack'}:null});
 let grant=null;window.syntheticPosts=[];window.syntheticFrames=[];window.syntheticPrepares=0;window.syntheticAssignments=[];window.syntheticValidations=0;
 const mqtt={uri:'mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883',username:'synthetic_user',password:'synthetic_broker_password',namespace:'synthetic_ns'};
 const port={async open(){this.readable=new ReadableStream({start(c){serialEmit=text=>c.enqueue(new TextEncoder().encode(text));}});this.writable=new WritableStream({write(bytes){const line=new TextDecoder().decode(bytes);if(line.startsWith('HELLO '))serialEmit('V3 HELLO '+JSON.stringify({node_id:node,boot_id:boot,request_id:line.trim().slice(6),mono_ms:1234,...(safeRequired?{restart_required:true}:{})})+'\\n');if(line==='RESTART\\n'){safeRequired=false;boot='22222222-2222-4222-8222-222222222222';policy.control.activation.boot_id=boot;window.syntheticRestarts=(window.syntheticRestarts||0)+1;}if(line.startsWith('V3START ')){window.syntheticFrames.push(JSON.parse(line.slice(8)));if(raceMode){assigned=true;policy.assignment_generation=2;if(raceMode==='other')policy.control.activation.boot_id='44444444-4444-4444-8444-444444444444';}serialEmit('V3 START ACCEPTED\\n');}}});},async setSignals(){},async close(){}};
 Object.defineProperty(navigator,'serial',{value:{requestPort:async()=>port},configurable:true});
 window.saveOnly=()=>serialEmit('V3 STARTUP SAVED\\n');window.applyOnly=()=>{applied=true;};
 const api=async(path,options={})=>{
  if(path.endsWith('/startup-grant')){if(options.method==='POST'){const b=options.body;window.syntheticPosts.push(b);if(window.failNextGrant){window.failNextGrant=false;grant={node_id:node,revision:5,enabled:0,source_generation:null,grant_expires_at_ms:null,policy_ttl_ms:null,accept_grace_ms:null};const error=new Error('Synthetic revision conflict');error.status=409;throw error;}grant={node_id:node,revision:b.expected_revision+1,enabled:b.enabled?1:0,source_generation:b.enabled?b.source_generation:null,grant_expires_at_ms:b.enabled?Date.parse(b.grant_expires_at):null,policy_ttl_ms:b.enabled?b.policy_ttl_ms:null,accept_grace_ms:b.enabled?b.accept_grace_ms:null};return {protocol:'campuspulse/3',node_id:node,startup_grant:{...grant},applied:false,requires_device_ack:true};}return {protocol:'campuspulse/3',node_id:node,startup_grant:grant?{...grant}:null,service_enabled:true,applied:false};}
  if(path==='/device-v3/nodes/'+node){const c=structuredClone(control());window.capabilityDelay=Math.max(0,window.capabilityDelay-1);return c;}
  if(path==='/device-v3/prepare'){window.syntheticPrepares++;return {valid:true,expected_generation:assigned?policy.assignment_generation:0,policy:structuredClone(policy)};}
  if(path==='/device-v3/validate'){window.syntheticValidations++;return {valid:true,policy:options.body.policy,policy_sha256:digest,expected_generation:assigned?policy.assignment_generation:0,issues:[]};}
  // Abstract AdminContext.api result: transition headers are normalized by the real API client.
  if(path==='/device-v3/assignments'){window.syntheticAssignments.push(options.body);assigned=true;return {protocol:'campuspulse/3',node_id:node,assignment_generation:policy.assignment_generation,policy_id:policy.policy_id,policy_sha256:digest,applied:false,requires_device_ack:true,startup_grant_revision_before:0,startup_grant_revision_after:0,startup_grant_revoked:false};}
  if(path==='/devices/'+node+'/mqtt')return {mqtt};
  if(path==='/devices/'+node)return {device:{id:node,name:'Synthetic device'},placements:[{id:'synthetic-place',node_id:node,place_id:null,valid_from_ms:0,effective_valid_until_ms:null}]};
  throw new Error('Unexpected synthetic route');
 };
 const context={api,version:0,sensitiveAction:async fn=>{if(window.cancelSensitive)throw new Error('Synthetic authentication cancelled');if(window.holdSensitive)await new Promise(resolve=>{window.releaseSensitive=resolve;});return fn();},notify:()=>{}};
 const standalone=new URLSearchParams(location.search).has('standalone');
 createRoot(document.getElementById('root')).render(React.createElement(AdminContext.Provider,{value:context},standalone?React.createElement(V3Configuration,{node}):React.createElement(Provisioning,{initialNodeId:node,onClose:()=>{document.querySelector('dialog')?.close();}})));
 </script></body></html>`);
 await page.route(url=>url.pathname==='/startup-qa.html'&&!url.searchParams.has('html-proxy'),route=>route.fulfill({contentType:'text/html',body:html}));
 const url=server.resolvedUrls.local[0]+'startup-qa.html';
 const load=async(query='')=>{await page.goto(url+query);await page.waitForFunction(()=>document.querySelector('dialog'),{},{timeout:5000}).catch(()=>{throw new Error('Synthetic initialization: '+JSON.stringify(errors));});await page.getByRole('button',{name:'选择 USB 串口并核对 V3 身份'}).click();await page.getByRole('button',{name:'安全重启并进入 USB 配置'}).click();await page.getByLabel('设备凭证',{exact:true}).fill('synthetic_device_token_32_characters');await page.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic WiFi');await page.getByLabel('个人 Wi-Fi 密码',{exact:true}).fill('synthetic_wifi_password');};
 const start=async()=>{await page.getByRole('button',{name:'读取本设备已验证 MQTT 授权'}).click();await page.getByRole('button',{name:'发送并自动下发策略、保存与授权（7 天）'}).click();await page.getByText('正在等待 V3 STARTUP SAVED。',{exact:false}).waitFor();};
 const posts=()=>page.evaluate(()=>window.syntheticPosts);
 await load();assert.equal(await page.evaluate(()=>window.syntheticRestarts),1);
 const save=page.getByLabel('保存并自动启动',{exact:true}),windows=page.getByLabel('本次统计窗口数',{exact:true}),mode=page.getByLabel('Wi-Fi 认证方式',{exact:true});
 await expect(save).toBeChecked();await expect(windows).toHaveValue('0');
 for(const value of ['open','personal','enterprise_peap']){await mode.selectOption(value);await expect(save).toBeEnabled();await expect(save).toBeChecked();await expect(windows).toHaveValue('0');}
 await page.getByLabel('PEAP 认证服务器验证',{exact:true}).selectOption('ca');await expect(save).toBeDisabled();await expect(save).not.toBeChecked();await expect(windows).toHaveValue('1');
 await page.getByLabel('PEAP 认证服务器验证',{exact:true}).selectOption('none');await expect(save).toBeChecked();await expect(windows).toHaveValue('0');
 await save.uncheck();for(const value of ['open','personal','enterprise_peap']){await mode.selectOption(value);await expect(save).not.toBeChecked();await expect(windows).toHaveValue('1');}
 await save.check();await page.getByLabel('PEAP 用户名',{exact:true}).fill('synthetic_user');await page.getByLabel('PEAP 密码',{exact:true}).fill('synthetic_password');
 await start();assert.deepEqual(await posts(),[],'ACCEPTED must not issue grant');
 assert.equal(await page.evaluate(()=>window.syntheticFrames[0].security),'enterprise_peap');assert.equal(await page.evaluate(()=>window.syntheticFrames[0].save_startup),true);assert.equal(await page.evaluate(()=>window.syntheticFrames[0].max_windows),0);
 await page.evaluate(()=>window.saveOnly());await page.getByText('已收到 V3 STARTUP SAVED：',{exact:false}).waitFor();assert.deepEqual(await posts(),[],'SAVED without current durable ACK must not issue grant');
 await page.evaluate(()=>window.applyOnly());await page.getByText('默认 7 天自动启动授权已确认；',{exact:false}).waitFor();assert.equal((await posts()).length,1);assert.equal((await posts())[0].source_generation,4);
 await page.getByRole('button',{name:'撤销自动启动授权'}).click();await expect.poll(async()=>(await posts()).length).toBe(2);await page.getByRole('button',{name:'刷新设备状态'}).click();await expect(page.getByText('未批准',{exact:true})).toBeVisible();assert.deepEqual((await posts())[1],{expected_revision:1,enabled:false});
 await page.waitForTimeout(1100);assert.equal((await posts()).length,2,'Manual revoke must not regrant');
 // Fresh initial policy is prepared, validated and assigned without any manual policy clicks.
 await load('?initial=1');await start();await expect.poll(()=>page.evaluate(()=>window.syntheticAssignments.length)).toBe(1);
 assert.equal(await page.evaluate(()=>window.syntheticPrepares),1);assert.equal(await page.evaluate(()=>window.syntheticValidations),1);assert.equal(await page.evaluate(()=>window.syntheticAssignments[0].expected_startup_revision),0);assert.deepEqual(await posts(),[]);
 await page.evaluate(()=>{window.applyOnly();window.saveOnly();});await page.getByText('默认 7 天自动启动授权已确认；',{exact:false}).waitFor();assert.equal((await posts()).length,1);assert.equal((await posts())[0].source_generation,1);
 // A competing manual policy after USB submission cannot be adopted or overwritten.
 for(const race of ['same','other']){await load('?initial=1&race='+race);await start();await page.getByText('期望策略已在本次 USB 提交后被其他操作修改',{exact:false}).waitFor();await page.evaluate(()=>{window.applyOnly();window.saveOnly();});await page.getByText('已收到 V3 STARTUP SAVED：',{exact:false}).waitFor();assert.equal(await page.evaluate(()=>window.syntheticAssignments.length),0);assert.equal(await page.evaluate(()=>window.syntheticPrepares),0);assert.deepEqual(await posts(),[]);}
 // Revision conflict is terminal for this setup attempt.
 await load();await start();await page.evaluate(()=>{window.failNextGrant=true;window.applyOnly();window.saveOnly();});await page.getByText('Synthetic revision conflict',{exact:true}).waitFor();await page.getByRole('button',{name:'刷新设备状态'}).click();await page.waitForTimeout(1100);assert.equal((await posts()).length,1);await expect(page.getByText('自动启动授权未完成：',{exact:false})).toBeVisible();
 // Authentication cancellation keeps SAVED separate and never sends authority.
 await load();await start();await page.evaluate(()=>{window.cancelSensitive=true;window.applyOnly();window.saveOnly();});await page.getByText('Synthetic authentication cancelled',{exact:true}).waitFor();assert.deepEqual(await posts(),[]);await expect(page.getByText('已收到 V3 STARTUP SAVED：',{exact:false})).toBeVisible();
 // Closing while authentication is pending cancels every future write.
 await load();await start();await page.evaluate(()=>{window.holdSensitive=true;window.applyOnly();window.saveOnly();});await page.waitForFunction(()=>!!window.releaseSensitive);await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.evaluate(()=>window.releaseSensitive());await page.waitForTimeout(100);assert.deepEqual(await posts(),[]);
 // Stale cloud boot and expired capabilities cannot prepare or publish.
 await load();await start();await page.getByLabel('部署位置',{exact:true}).selectOption('synthetic-place');
 await page.evaluate(()=>{window.cloudBoot='33333333-3333-4333-8333-333333333333';});await page.getByRole('button',{name:'刷新设备状态'}).click();await expect(page.getByRole('button',{name:'根据当前能力准备 V3 策略'})).toBeDisabled();await expect(page.getByText('云端能力与本次 USB 启动标识不一致。',{exact:false})).toBeVisible();assert.equal(await page.evaluate(()=>window.syntheticPrepares),0);
 await page.evaluate(()=>{window.cloudBoot=null;});await page.getByRole('button',{name:'刷新设备状态'}).click();await page.getByRole('button',{name:'根据当前能力准备 V3 策略'}).click();await page.getByRole('button',{name:'校验能力与策略'}).click();await expect(page.getByRole('button',{name:'发布不可变 V3 assignment'})).toBeEnabled();
 await page.evaluate(()=>{window.capExpired=true;});await page.getByRole('button',{name:'刷新设备状态'}).click();await expect(page.getByLabel('V3 策略 JSON',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'根据当前能力准备 V3 策略'})).toBeDisabled();assert.equal(await page.evaluate(()=>window.syntheticPrepares),1);
 // Opening the ordinary configuration page never requests a startup grant.
 await page.goto(url+'?standalone=1');await page.getByRole('heading',{name:'V3 能力与应用状态',exact:true}).waitFor();await page.evaluate(()=>{window.capExpired=true;});await page.getByRole('button',{name:'刷新设备状态'}).click();await page.getByLabel('部署位置',{exact:true}).selectOption('synthetic-place');await expect(page.getByRole('button',{name:'根据当前能力准备 V3 策略'})).toBeDisabled();assert.deepEqual(await posts(),[]);
 assert.deepEqual(errors,[]);
 console.log('Synthetic browser passed: automatic defaults and mode preference, safe restart, accepted/saved/ACK boundaries, automatic prepare/validate/assign without manual clicks, one-shot seven-day grant, revoke/conflict/cancel/close, stale boot/expired capabilities and draft invalidation.');
}finally{await browser.close();await server.close();}
