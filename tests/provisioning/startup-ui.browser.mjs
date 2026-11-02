/** Isolated browser acceptance with synthetic APIs/Web Serial. Never connects to
 * an actual device, production authenticated API or deployment. */
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';

const server=await createServer({configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:5187,strictPort:true}});
await server.listen();
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const spki=Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5','hex').toString('base64url');
 await page.route('https://pulse.anend.net/api/v3/clock/key',async route=>{
  assert.equal(route.request().headers().authorization,undefined);assert.equal(route.request().headers().cookie,undefined);
  await route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({schema:'cp-v3-signed-clock-key/1',audience:'https://pulse.anend.net',key_id:'synthetic-key-1',public_key_spki:spki})});
 });
 const html=await server.transformIndexHtml('/startup-qa.html',`<html><body><div id="root"></div><script type="module">
 import React from 'react';
 import {createRoot} from 'react-dom/client';
 import Provisioning from '/src/admin/Provisioning.jsx';
 import {AdminContext} from '/src/admin/shared.jsx';
 import '/src/admin/admin.css';
 const node='cp_001122aabbcc',end=Date.now()+1200000;
 let applied=false,serialEmit,boot='11111111-1111-4111-8111-111111111111',safeRequired=true;
 const policy={assignment_generation:4,policy_id:'synthetic-policy',collection:{enabled:true,summary:{enabled:true,window_ms:60000}},temporal:{mode:'rolling'},evidence:{mode:'statistics',schema:'window-statistics/1',extractor_version:'cp-v3-stats/1',ruleset_version:'unclassified-v1'},local_raw:{mode:'off'},local_queue:{mode:'durable'},uplink:{enabled:true,transport:'mqtt_tls',streams:['window_statistics','node_status'],raw_sample:{mode:'off'},archive:{mode:'off'}},custody:{accept_until:new Date(end+3600000).toISOString()},control:{activation:{boot_id:boot,expires_at:new Date(end).toISOString()}}};
 const control=()=>({protocol:'campuspulse/3',node_id:node,state:applied?'applied':'pending',capabilities:{boot_id:boot,expires_at:new Date(end+1200000).toISOString()},desired:{policy},applied_generation:applied?4:null,acknowledgement:applied?{state:'applied',assignment_generation:4,boot_id:boot,durability:'committed',evidence:'device_ack'}:null});
 let grant=null;window.syntheticPosts=[];window.syntheticFrames=[];window.failNextGrant=false;
 const mqtt={uri:'mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883',username:'synthetic_user',password:'synthetic_broker_password',namespace:'synthetic_ns'};
 const port={async open(){this.readable=new ReadableStream({start(c){serialEmit=text=>c.enqueue(new TextEncoder().encode(text));}});this.writable=new WritableStream({write(bytes){const line=new TextDecoder().decode(bytes);if(line.startsWith('HELLO '))serialEmit('V3 HELLO '+JSON.stringify({node_id:node,boot_id:boot,request_id:line.trim().slice(6),mono_ms:1234,...(safeRequired?{restart_required:true}:{})})+'\\n');if(line==='RESTART\\n'){safeRequired=false;boot='22222222-2222-4222-8222-222222222222';policy.control.activation.boot_id=boot;window.syntheticRestarts=(window.syntheticRestarts||0)+1;}if(line.startsWith('V3START ')){window.syntheticFrames.push(JSON.parse(line.slice(8)));serialEmit('V3 START ACCEPTED\\n');}}});},async setSignals(){},async close(){}};
 Object.defineProperty(navigator,'serial',{value:{requestPort:async()=>port},configurable:true});
 window.applyAndSave=()=>{applied=true;serialEmit('V3 STARTUP SAVED\\n');};
 const api=async(path,options={})=>{
  if(path.endsWith('/startup-grant')){if(options.method==='POST'){const b=options.body;window.syntheticPosts.push(b);if(window.failNextGrant){window.failNextGrant=false;grant={node_id:node,revision:5,enabled:0,source_generation:null,grant_expires_at_ms:null,policy_ttl_ms:null,accept_grace_ms:null};const error=new Error('Synthetic revision conflict');error.status=409;throw error;}grant={node_id:node,revision:b.expected_revision+1,enabled:b.enabled?1:0,source_generation:b.enabled?b.source_generation:null,grant_expires_at_ms:b.enabled?Date.parse(b.grant_expires_at):null,policy_ttl_ms:b.enabled?b.policy_ttl_ms:null,accept_grace_ms:b.enabled?b.accept_grace_ms:null};return {protocol:'campuspulse/3',node_id:node,startup_grant:{...grant},applied:false,requires_device_ack:true};}return {protocol:'campuspulse/3',node_id:node,startup_grant:grant?{...grant}:null,service_enabled:true,applied:false};}
  if(path==='/device-v3/nodes/'+node)return control();
  if(path==='/devices/'+node+'/mqtt')return {mqtt};
  if(path==='/devices/'+node)return {device:{id:node,name:'Synthetic device'},placements:[]};
  throw new Error('Unexpected synthetic route');
 };
 const context={api,version:0,sensitiveAction:fn=>fn(),notify:text=>{window.syntheticNotice=text;}};
 createRoot(document.getElementById('root')).render(React.createElement(AdminContext.Provider,{value:context},React.createElement(Provisioning,{initialNodeId:node,onClose:()=>{}})));
 </script></body></html>`);
 await page.route('**/startup-qa.html',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.goto(server.resolvedUrls.local[0]+'startup-qa.html');
 await page.waitForFunction(()=>document.querySelector('dialog'),{},{timeout:5000}).catch(()=>{throw new Error('Synthetic page initialization errors: '+JSON.stringify(errors));});
 await page.getByRole('button',{name:'选择 USB 串口并核对 V3 身份'}).click();
 await page.getByRole('button',{name:'安全重启并进入 USB 配置'}).waitFor();
 assert.equal(await page.getByLabel('设备凭证',{exact:true}).count(),0,'Safe restart state cannot send credentials');
 await page.getByRole('button',{name:'安全重启并进入 USB 配置'}).click();
 await page.getByLabel('设备凭证',{exact:true}).fill('synthetic_device_token_32_characters');
 assert.equal(await page.evaluate(()=>window.syntheticRestarts),1);
 await page.getByLabel('Wi-Fi SSID',{exact:true}).fill('Synthetic WiFi');
 await page.getByLabel('个人 Wi-Fi 密码',{exact:true}).fill('synthetic_wifi_password');
 const save=page.getByLabel('保存并自动启动',{exact:true});
 assert.equal(await save.isChecked(),false);
 assert.equal(await page.getByLabel('本次统计窗口数',{exact:true}).inputValue(),'1');
 await save.check();await page.getByLabel('本次统计窗口数',{exact:true}).selectOption('0');
 await page.getByRole('button',{name:'读取本设备已验证 MQTT 授权'}).click();
 await page.getByRole('button',{name:'发送并申请保存启动配置'}).click();
 await page.getByText('正在等待 V3 STARTUP SAVED。',{exact:false}).waitFor();
 assert.equal(await page.getByText('已收到 V3 STARTUP SAVED：',{exact:false}).count(),0);
 assert.equal(await page.getByRole('button',{name:'明确批准自动启动（7 天）'}).isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.syntheticFrames[0].save_startup),true);
 assert.equal(await page.evaluate(()=>window.syntheticFrames[0].max_windows),0);
 await page.evaluate(()=>window.applyAndSave());
 await page.getByText('已收到 V3 STARTUP SAVED：',{exact:false}).waitFor();
 await page.getByRole('button',{name:'刷新设备状态'}).click();
 const approval=page.getByRole('button',{name:'明确批准自动启动（7 天）'});
 await approval.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='明确批准自动启动（7 天）'&&!b.disabled));
 await page.evaluate(()=>{window.failNextGrant=true;});await approval.click();
 await page.getByText('Synthetic revision conflict',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.syntheticPosts.length),1,'Conflict must never resend authority silently');
 await approval.click();await page.getByText('已批准，尚需每次启动重新取得策略与 ACK',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.syntheticPosts[1].expected_revision),5);
 assert.equal(await page.evaluate(()=>window.syntheticPosts[1].source_generation),4);
 await page.getByRole('button',{name:'撤销自动启动授权'}).click();
 await page.getByText('未批准',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.syntheticPosts[2]),{expected_revision:6,enabled:false});
 assert.deepEqual(errors,[]);
 console.log('Synthetic browser passed: safe USB restart/new HELLO, explicit save/continuous USB, accepted != saved, real-state grant gating, conflict refresh without replay, approve/revoke.');
}finally{await browser.close();await server.close();}
