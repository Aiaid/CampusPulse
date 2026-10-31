import React,{useEffect,useRef,useState} from 'react';
import {Dialog,ErrorNotice,Field,KeyValues,Notice,useAdmin,useMutation} from './shared.jsx';
import {V3Configuration} from './Configs.jsx';
import {openV3Serial,serialSupport} from './provisioning/v3-serial.js';
import {mqttSettings} from './provisioning/mqtt.js';
import './provisioning.css';

export default function Provisioning({onClose,initialNodeId=''}) {
 const {api,sensitiveAction}=useAdmin(), mutation=useMutation();
 const [identity,setIdentity]=useState(null),[registered,setRegistered]=useState(false),[name,setName]=useState(''),[board,setBoard]=useState('Waveshare ESP32-S3 ePaper V2');
 const [token,setToken]=useState(''),[ssid,setSsid]=useState(''),[password,setPassword]=useState(''),[windows,setWindows]=useState(1),[mqttReady,setMqttReady]=useState(false),[started,setStarted]=useState(false);
 const client=useRef(null),mqtt=useRef(null),mounted=useRef(true);
 const clear=()=>{mqtt.current=null;setMqttReady(false);setToken('');setPassword('');};
 const close=()=>{void client.current?.close().catch(()=>{});client.current=null;clear();onClose();};
 useEffect(()=>{mounted.current=true;const hide=()=>{void client.current?.close().catch(()=>{});client.current=null;clear();};window.addEventListener('pagehide',hide);return()=>{mounted.current=false;window.removeEventListener('pagehide',hide);void client.current?.close().catch(()=>{});client.current=null;mqtt.current=null;};},[]);
 const connect=()=>{const selected=navigator.serial.requestPort();mutation.run(async()=>{await client.current?.close();client.current=null;clear();setIdentity(null);setRegistered(false);setStarted(false);const connection=await openV3Serial(await selected);client.current=connection;try{const h=await connection.hello(initialNodeId||undefined);if(!mounted.current){await connection.close();return;}setIdentity(h.identity);try{const d=await api(`/devices/${h.identity.node_id}`);setRegistered(true);setName(d.device.name);}catch(e){if(e.status!==404)throw e;setName(h.identity.node_id);}}catch(e){await connection.close();client.current=null;throw e;}});};
 return <Dialog title="连接并部署 V3 设备" wide onClose={close} pending={mutation.pending}>
  <Notice>适用于原生 V3 Waveshare / T-Energy 固件。USB 使用新鲜 nonce 核对设备后发送启动材料；不会声称永久保存。默认仅运行 1 个统计窗口，须另行发布 V3 策略并取得 ACK。</Notice>
  {!serialSupport()?<Notice>当前浏览器没有安全上下文 Web Serial。请使用支持 Web Serial 的浏览器并打开 HTTPS 管理页或 localhost。</Notice>:<button className="cp-admin-button cp-admin-primary" disabled={mutation.pending||started} onClick={connect}>选择 USB 串口并核对 V3 身份</button>}
  {identity&&<><KeyValues entries={[[ '设备 ID',identity.node_id],['启动标识',identity.boot_id],['云端登记',registered?'已登记':'未登记']]}/>
   {!registered&&<div className="cp-admin-form-grid"><Field label="设备名称"><input value={name} onChange={e=>setName(e.target.value)} maxLength={80}/></Field><Field label="实际板型"><select value={board} onChange={e=>setBoard(e.target.value)}><option>Waveshare ESP32-S3 ePaper V2</option><option>LILYGO T-Energy-S3</option></select></Field><button className="cp-admin-button" disabled={mutation.pending||!name} onClick={()=>mutation.run(async()=>{const r=await sensitiveAction(()=>api('/devices',{method:'POST',body:{id:identity.node_id,name,board}}));setToken(r.credential);mqtt.current=mqttSettings(r.mqtt);setMqttReady(true);setRegistered(true);})}>登记此设备并分配 MQTT 授权</button></div>}
   {registered&&!started&&<><div className="cp-admin-form-grid"><Field label="设备凭证" hint="使用本设备备份凭证；重新连接不会自动轮换或假定设备已保存。"><input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></Field><Field label="Wi-Fi SSID"><input autoComplete="off" value={ssid} onChange={e=>setSsid(e.target.value)}/></Field><Field label="个人 Wi-Fi 密码"><input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/></Field><Field label="本次统计窗口数"><select value={windows} onChange={e=>setWindows(Number(e.target.value))}><option value={1}>1（默认有界运行）</option><option value={2}>2</option><option value={3}>3</option></select></Field></div>
    <button className="cp-admin-button" disabled={mutation.pending} onClick={()=>mutation.run(async()=>{const r=await sensitiveAction(()=>api(`/devices/${identity.node_id}/mqtt`,{method:'POST',body:{}}));mqtt.current=mqttSettings(r.mqtt);setMqttReady(true);})}>{mqttReady?'重新核对 MQTT 授权':'读取本设备已验证 MQTT 授权'}</button>
    <button className="cp-admin-button cp-admin-primary" disabled={mutation.pending||!mqttReady||!token||!ssid||!password||!client.current} onClick={()=>mutation.run(async()=>{await client.current.start({expectedNode:identity.node_id,bootId:identity.boot_id,token,mqtt:mqtt.current,ssid,password,windows});clear();setStarted(true);})}>发送并启动有界 V3 采集</button></>}
   {started&&<><Notice>已收到 V3 START ACCEPTED。它只表示启动材料被接收；请刷新下方能力，准备并发布策略，等待明确 ACK 和统计回执。更换 Wi-Fi 需要现场重启进入 USB bootstrap。</Notice><V3Configuration node={identity.node_id} embedded/></>}
  </>}
  <ErrorNotice error={mutation.error}/>
 </Dialog>;
}
