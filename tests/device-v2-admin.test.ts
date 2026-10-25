import { afterEach, beforeEach, expect, it } from 'vitest';
import { authState, Client, json } from './admin-auth-helpers';
import { fixture, DEVICE_TOKEN } from './helpers/ingestion';
import worker from '../worker/index';
let state:Awaited<ReturnType<typeof authState>>;
let client:Client;
beforeEach(async()=>{state=await authState();client=new Client(state);await client.initialize();});
afterEach(()=>state.db.close());
const contact=(body:unknown)=>worker.fetch(new Request('https://admin.example.test/api/v2/device/contact',{method:'POST',body:JSON.stringify(body),headers:{Authorization:`Bearer ${DEVICE_TOKEN}`,'Content-Type':'application/json'}}),state.env);
const activate=(body:unknown)=>worker.fetch(new Request('https://admin.example.test/api/v2/device/config/ack',{method:'POST',body:JSON.stringify(body),headers:{Authorization:`Bearer ${DEVICE_TOKEN}`,'Content-Type':'application/json'}}),state.env);
it('publishes v2 through existing administrator routes and reconciles unassigned contact and actual activation',async()=>{
 const cfg=fixture('capture-config-v2.fixture');cfg.accept_until=new Date(Date.now()+86400000).toISOString();
 let fleet=await json(await client.call('/devices'));expect(fleet.devices[0].contact_state).toBe('unknown');
 const c=fixture('device-contact-v2.request');await json(await contact(c));
 fleet=await json(await client.call('/devices'));expect(fleet.devices[0]).toMatchObject({contact_state:'recent',config_state:'unassigned',applied_config_id:null,latest_control:{boot_id:c.boot_id,capture_state:'unassigned'}});
 const draft=await json(await client.call('/configs','POST',{config:cfg}),201);expect(draft.draft.config.protocol).toBe('campuspulse/2');
 await json(await client.call(`/configs/${cfg.capture_config_id}/validate`,'POST',{revision:1}));
 await json(await client.call(`/configs/${cfg.capture_config_id}/publish`,'POST',{revision:1}));
 const desired=await json(await client.call(`/devices/${cfg.node_id}`));expect(desired.device).toMatchObject({desired_config_id:cfg.capture_config_id,applied_config_id:null,config_state:'pending'});
 // A heartbeat claim cannot grant applied status.
 await json(await contact({...c,contact_seq:2,applied_config_id:cfg.capture_config_id,capture_state:'running'}));
 expect((await json(await client.call(`/devices/${cfg.node_id}`))).device.applied_config_id).toBeNull();
 await json(await activate(fixture('device-activation-v2.request')));
 const applied=await json(await client.call(`/devices/${cfg.node_id}`));expect(applied.device).toMatchObject({applied_config_id:cfg.capture_config_id,config_state:'applied'});expect(applied.activation.current).toMatchObject({boot_id:c.boot_id,apply_seq:1,state:'applied'});
 const overview=await json(await client.call('/overview'));expect(overview).toMatchObject({devices_recent:1,devices_unknown:0,config_pending:0});
 await json(await client.call(`/configs/${cfg.capture_config_id}`,'PUT',{config:cfg,revision:1}),409);
 expect(JSON.stringify(await json(await client.call('/audit')))).not.toContain('02:00:00');
});
it('keeps previous actual config explicit when desired policy publication advances',async()=>{
 for(const id of ['first-v2','next-v2']){const cfg=fixture('capture-config-v2.fixture');cfg.capture_config_id=id;cfg.accept_until=new Date(Date.now()+86400000).toISOString();await json(await client.call('/configs','POST',{config:cfg}),201);await json(await client.call(`/configs/${id}/publish`,'POST',{revision:1}));if(id==='first-v2'){await json(await contact(fixture('device-contact-v2.request')));await json(await activate({...fixture('device-activation-v2.request'),capture_config_id:id}));}}
 const result=await json(await client.call('/devices/cp-demo-01'));expect(result.device).toMatchObject({desired_config_id:'next-v2',applied_config_id:'first-v2',config_state:'pending'});
});
