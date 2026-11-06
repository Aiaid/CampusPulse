/** Real React/browser acceptance against an isolated in-memory synthetic API. */
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium,expect} from '@playwright/test';
import {existsSync} from 'node:fs';
import {createServer as createHttpServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';

const cacheDir=await mkdtemp(join(tmpdir(),'campuspulse-online-ui-'));
const httpServer=createHttpServer();
const server=await createServer({configFile:false,cacheDir,plugins:[react()],server:{middlewareMode:true,hmr:{server:httpServer},watch:null}});
httpServer.on('request',server.middlewares);
httpServer.listen(0,'127.0.0.1');await once(httpServer,'listening');
const binary=process.env.CHROMIUM_PATH||(existsSync(chromium.executablePath())?chromium.executablePath():'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:binary});
 const page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[];
 page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 // Every API result stays in browser memory. No physical devices, credentials,
 // production API requests, screenshots or persistent browser profiles are used.
 const html=await server.transformIndexHtml('/online-binding-qa.html',`<html><body><div id="root"></div><script type="module">
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import OnlineBinding from '/src/admin/OnlineBinding.jsx';import {AdminContext} from '/src/admin/shared.jsx';
 import '/src/admin/admin.css';
 const boot='11111111-1111-4111-8111-111111111111',digest='a'.repeat(64),expiry=Date.now()+1200000;
 const mode=new URLSearchParams(location.search).get('mode')||'normal',first='synthetic-online-browser-a',second='synthetic-online-browser-b';
 const records=new Map();window.syntheticPosts=[];window.syntheticReads=[];window.syntheticNotifications=[];window.syntheticChanges=[];
 window.readInvisible=mode==='uncertain';window.holdNextRead=false;
 const control=node=>({node_id:node,capabilities:{boot_id:boot,expires_at:new Date(expiry).toISOString(),online_control:{schema:'online-control/1',scope_rebind:true,capability_renewal:true},statistics:{ruleset_versions:['unclassified-v1','cp-v3-vehicle-candidates/1']}},
  applied_generation:4,desired_unavailable_reason:null,acknowledgement:{assignment_generation:4,boot_id:boot,state:'applied',durability:'committed',evidence:'device_ack'},
  desired:{policy:{assignment_generation:4,collection:{enabled:true,summary:{enabled:true,window_ms:60000}},temporal:{mode:'rolling'},evidence:{mode:'statistics',schema:'window-statistics/1',extractor_version:'cp-v3-stats/1',ruleset_version:'unclassified-v1'},local_raw:{mode:'off'},local_queue:{mode:'durable'},
   uplink:{enabled:true,transport:'mqtt_tls',streams:['window_statistics','node_status'],raw_sample:{mode:'off'},archive:{mode:'off'}},custody:{accept_until:new Date(expiry+3600000).toISOString()},control:{capability_sha256:digest,activation:{boot_id:boot,expires_at:new Date(expiry).toISOString()}}}}});
 const setPhase=(t,state)=>Object.assign(t,{state,phase:state,assignment_generation:['assigned','applied','failed'].includes(state)?5:null,startup_grant_migrated:state==='applied',applied:state==='applied',requires_device_ack:['pending','assigned'].includes(state)});
 window.phase=state=>{for(const t of records.values())setPhase(t,state);};
 const envelope=(node,t)=>({protocol:'campuspulse/3',node_id:node,transition:t?structuredClone(t):null,...(!t||window.includeList?{transitions:t?[structuredClone(t)]:[]}: {})});
 const api=async(path,options={})=>{
  if(path==='/places')return {places:[{id:'synthetic-target',name:'Synthetic target',observation_kinds:['activity']}]};
  const node=path.split('/')[3];
  if(path.endsWith('/startup-grant'))return {protocol:'campuspulse/3',node_id:node,service_enabled:true,startup_grant:{node_id:node,revision:3,enabled:1,source_generation:4,grant_expires_at_ms:expiry+86400000,policy_ttl_ms:1800000,accept_grace_ms:86400000}};
  if(path.endsWith('/cancel')){window.syntheticPosts.push({path,body:options.body});const t=records.get(node);setPhase(t,'cancelled');return envelope(node,t);}
  if(!path.endsWith('/transitions'))throw new Error('Unexpected synthetic path '+path);
  if(options.method==='POST'){
   const b=options.body;window.syntheticPosts.push({path,body:structuredClone(b)});
   const t=setPhase({id:b.request_id,boot_id:b.expected_boot_id,capability_sha256:b.expected_capability_sha256,from_generation:b.expected_generation,expected_startup_revision:b.expected_startup_revision,
    target_place_id:b.target_place_id,target_dataset:b.target_dataset,target_ruleset:b.target_ruleset,expires_at:new Date(Date.now()+300000).toISOString()},'pending');
   records.set(node,t);const reply=envelope(node,t);
   if(mode==='uncertain')throw new Error('Synthetic connection lost after submission');
   if(mode==='held-post')return await new Promise(resolve=>{window.releasePost=()=>resolve(reply);});
   return reply;
  }
  window.syntheticReads.push({node,at:Date.now()});window.includeList=true;
  const reply=envelope(node,window.readInvisible?null:records.get(node));
  if(window.holdNextRead){window.holdNextRead=false;return await new Promise(resolve=>{window.releaseRead=()=>resolve(reply);});}
  return reply;
 };
 const context={api,version:0,notify:message=>window.syntheticNotifications.push(message)};
 function Harness(){const [node,setNode]=useState(first),[visible,setVisible]=useState(true);window.switchNode=()=>setNode(second);window.unmountBinding=()=>setVisible(false);return React.createElement(AdminContext.Provider,{value:context},React.createElement('div',{'data-testid':'current-node'},node),visible&&React.createElement(OnlineBinding,{node,control:control(node),onChange:()=>window.syntheticChanges.push(node)}));}
 createRoot(document.getElementById('root')).render(React.createElement(Harness));
 </script></body></html>`);
 await page.route(url=>url.pathname==='/online-binding-qa.html'&&!url.searchParams.has('html-proxy'),route=>route.fulfill({contentType:'text/html',body:html}));
 const url=`http://127.0.0.1:${httpServer.address().port}/online-binding-qa.html`;
 const submit=()=>page.getByRole('button',{name:'提交在线切换请求',exact:true});
 const load=async(mode='normal')=>{await page.goto(url+'?mode='+mode);await page.getByLabel('目标地点',{exact:true}).selectOption('synthetic-target');await expect(submit()).toBeEnabled();};
 const advance=async ms=>{await page.clock.runFor(ms);};
 const posts=()=>page.evaluate(()=>window.syntheticPosts);
 await page.clock.install();

 await load();await submit().click();
 await expect(page.getByText('等待设备安全暂停并同步旧记录',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.phase('assigned'));await advance(1001);
 await expect(page.getByText('新策略已发布，等待设备真实 ACK',{exact:true})).toBeVisible();await expect(submit()).toBeDisabled();
 await page.evaluate(()=>window.phase('applied'));await advance(3001);
 await expect(page.getByText('设备已应用，原授权截止时间保留',{exact:true})).toBeVisible();
 assert.equal((await posts()).length,1);assert.equal(await page.evaluate(()=>window.syntheticChanges.length),1);

 // A slow original pending POST response cannot replace a newer applied GET.
 await load('held-post');await submit().click();await page.waitForFunction(()=>!!window.releasePost);
 await page.evaluate(()=>window.phase('applied'));await advance(1001);
 await expect(page.getByText('设备已应用，原授权截止时间保留',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.releasePost());await expect(submit()).toBeEnabled();
 await expect(page.getByText('设备已应用，原授权截止时间保留',{exact:true})).toBeVisible();assert.equal((await posts()).length,1);

 // Hold a stale pending GET across a committed cancellation.
 await load();await submit().click();await expect(page.getByText('等待设备安全暂停并同步旧记录',{exact:true})).toBeVisible();
 await page.evaluate(()=>{window.holdNextRead=true;});await advance(1001);await page.waitForFunction(()=>!!window.releaseRead);
 await page.getByRole('button',{name:'取消待执行请求',exact:true}).click();await expect(page.getByText('已取消',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.releaseRead());await advance(3001);
 await expect(page.getByText('已取消',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'取消待执行请求',exact:true})).toHaveCount(0);
 assert.equal((await posts()).length,2);

 // Neither an empty read nor explicit refresh releases an uncertain submission.
 await load('uncertain');await submit().click();
 await expect(page.getByText('正在核对本次请求回执；发送结果尚未确定，提交已锁定。',{exact:false})).toBeVisible();await expect(submit()).toBeDisabled();
 await advance(1001);await page.getByRole('button',{name:'刷新状态',exact:true}).click();await advance(3001);
 await expect(submit()).toBeDisabled();assert.equal((await posts()).length,1);
 await page.evaluate(()=>{window.readInvisible=false;});await advance(3001);
 await expect(page.getByText('等待设备安全暂停并同步旧记录',{exact:true})).toBeVisible();assert.equal((await posts()).length,1);

 // A direct node prop change owns a fresh session; late old-node POST is ignored.
 await load('held-post');await submit().click();await page.waitForFunction(()=>!!window.releasePost);
 await page.evaluate(()=>window.switchNode());await expect(page.getByTestId('current-node')).toHaveText('synthetic-online-browser-b');
 await page.getByLabel('目标地点',{exact:true}).selectOption('synthetic-target');await expect(submit()).toBeEnabled();
 const beforeSwitchRelease=await page.evaluate(()=>({notices:window.syntheticNotifications.length,changes:window.syntheticChanges.length}));
 await page.evaluate(()=>window.releasePost());await advance(3001);
 await expect(page.getByText('等待设备安全暂停并同步旧记录',{exact:true})).toHaveCount(0);
 assert.deepEqual(await page.evaluate(()=>({notices:window.syntheticNotifications.length,changes:window.syntheticChanges.length})),beforeSwitchRelease);
 assert.equal((await posts()).length,1);assert.ok((await posts())[0].path.includes('synthetic-online-browser-a'));

 // Closing the component prevents late mutation notifications and stops polling.
 await load('held-post');await submit().click();await page.waitForFunction(()=>!!window.releasePost);
 await page.evaluate(()=>window.unmountBinding());await expect(submit()).toHaveCount(0);
 const beforeUnmount=await page.evaluate(()=>({notices:window.syntheticNotifications.length,changes:window.syntheticChanges.length,reads:window.syntheticReads.length}));
 await page.evaluate(()=>window.releasePost());await advance(6001);
 assert.deepEqual(await page.evaluate(()=>({notices:window.syntheticNotifications.length,changes:window.syntheticChanges.length,reads:window.syntheticReads.length})),beforeUnmount);
 assert.equal((await posts()).length,1);assert.deepEqual(errors,[]);
 console.log('Synthetic real-browser online binding passed: pending/assigned/applied, delayed POST monotonicity, cancellation versus delayed GET, uncertain outcome/read misses/refresh without duplicate writes, node changes and unmount cleanup.');
}finally{if(browser)await browser.close();await new Promise((resolve,reject)=>httpServer.close(error=>error?reject(error):resolve()));await server.close();await rm(cacheDir,{recursive:true,force:true});}
