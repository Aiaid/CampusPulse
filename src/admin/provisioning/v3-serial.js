import { mqttSettings } from './mqtt.js';
export const V3_ORIGIN='https://pulse.anend.net';
const nodePattern=/^cp_[0-9a-f]{12}$/;
const bootPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const serialSupport=()=>typeof navigator!=='undefined'&&!!navigator.serial&&globalThis.isSecureContext;
export function validateV3Hello(value,nonce,expectedNode) {
 if (!value||typeof value!=='object'||Array.isArray(value)||!nodePattern.test(value.node_id)||!bootPattern.test(value.boot_id)||value.request_id!==nonce||!Number.isSafeInteger(value.mono_ms)||value.mono_ms<0||
  Object.keys(value).some(k=>!['node_id','boot_id','request_id','mono_ms','restart_required'].includes(k))) throw new Error('V3 USB 身份或 nonce 校验失败；未发送凭证。');
 if (expectedNode&&value.node_id!==expectedNode) throw new Error('连接的设备与所选节点不一致；未发送凭证。');
 if (value.restart_required===true) throw new Error('设备要求重新启动。请现场重启后再连接，当前未发送凭证。');
 if (value.restart_required!==undefined&&value.restart_required!==false) throw new Error('设备启动状态无效。');
 return value;
}
export function buildV3Start({identity,nonce,expectedNode,token,mqtt,ssid,password,windows=1,sentWall,sentMono,receivedWall,receivedMono}) {
 validateV3Hello(identity,nonce,expectedNode);
 if (typeof token!=='string'||!/^[A-Za-z0-9_-]{32,192}$/.test(token)) throw new Error('请输入本设备有效的设备凭证。');
 const bytes=value=>new TextEncoder().encode(value).length;
 if (typeof ssid!=='string'||bytes(ssid)<1||bytes(ssid)>32||/[\x00-\x1f\x7f]/.test(ssid)||typeof password!=='string'||bytes(password)<8||bytes(password)>64||/[\x00-\x1f\x7f]/.test(password)||bytes(password)===64&&!/^[0-9a-fA-F]{64}$/.test(password)) throw new Error('V3 当前支持个人 Wi-Fi：SSID 最多 32 字节，密码 8–63 字节或 64 位十六进制密钥。');
 if (![1,2,3].includes(windows)) throw new Error('本流程仅支持 1–3 个有界采集窗口。');
 const rtt=receivedMono-sentMono;
 if (![sentWall,sentMono,receivedWall,receivedMono].every(Number.isFinite)||rtt<0||rtt>2000||Math.abs(receivedWall-sentWall-rtt)>20) throw new Error('USB 时钟交换超时或主机时间跳变，请重试。');
 const m=mqttSettings(mqtt);
 const payload={node_id:identity.node_id,boot_id:identity.boot_id,uplink_transport:'mqtt_tls',origin:V3_ORIGIN,device_token:token,ssid,password,security:'personal',
  mqtt_uri:m.uri,mqtt_username:m.username,mqtt_password:m.password,mqtt_namespace:m.namespace,
  utc_ms:Math.floor((sentWall+receivedWall)/2),uncertainty_ms:Math.ceil(rtt/2)+251,anchor_mono_ms:identity.mono_ms,max_windows:windows};
 const frame=`V3START ${JSON.stringify(payload).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))}\n`;
 if (bytes(frame)>=8192) throw new Error('V3 USB 消息超出固件上限。');
 return frame;
}
/** Bounded line reader. Unrecognized device output is discarded, never logged. */
export async function openV3Serial(port) {
 await port.open({baudRate:115200});
 let reader,writer,closed=false,buffer='',overflow=false,failure=null;
 const lines=[],waiters=[];
 try { await port.setSignals?.({dataTerminalReady:false,requestToSend:false}); reader=port.readable.getReader();writer=port.writable.getWriter(); }
 catch(error){await port.close();throw error;}
 const push=line=>{if(waiters.length)waiters.shift()(line);else {lines.push(line);if(lines.length>32)lines.shift();}};
 const pump=(async()=>{try{while(!closed){const {value,done}=await reader.read();if(done)break;for(const byte of value){if(byte===10){if(!overflow)push(buffer.replace(/\r$/,''));buffer='';overflow=false;}else if(buffer.length<8192&&!overflow){buffer+=String.fromCharCode(byte);}else{overflow=true;buffer='';}}}}catch{failure=new Error('USB 连接已中断。');}finally{closed=true;while(waiters.length)waiters.shift()(null);}})();
 const line=async timeout=>{if(lines.length)return lines.shift();if(closed)throw failure||new Error('USB 连接已关闭。');return new Promise(resolve=>{const deliver=value=>{clearTimeout(timer);resolve(value);};const timer=setTimeout(()=>{const i=waiters.indexOf(deliver);if(i>=0)waiters.splice(i,1);resolve(null);},timeout);waiters.push(deliver);});};
 const write=async text=>{if(closed)throw failure||new Error('USB 连接已关闭。');const bytes=new TextEncoder().encode(text);try{await writer.write(bytes);}finally{bytes.fill(0);}};
 const hello=async expectedNode=>{
  for(let attempt=0;attempt<3;attempt++){
   const nonce=crypto.randomUUID().replaceAll('-',''),sentWall=Date.now(),sentMono=performance.now();lines.length=0;
   await write(`HELLO ${nonce}\n`);const deadline=performance.now()+2000;
   while(performance.now()<deadline){const text=await line(Math.max(1,deadline-performance.now()));if(!text?.startsWith('V3 HELLO '))continue;
    let value;try{value=JSON.parse(text.slice(9));}catch{continue;}if(value.request_id!==nonce)continue;
    const identity=validateV3Hello(value,nonce,expectedNode);return {identity,nonce,sentWall,sentMono,receivedWall:Date.now(),receivedMono:performance.now()};}
  }throw new Error('没有收到本次 nonce 对应的 V3 HELLO；未发送凭证。');
 };
 return {hello,async start(input){const anchor=await hello(input.expectedNode);if(input.bootId&&anchor.identity.boot_id!==input.bootId)throw new Error('设备已经重启，请重新连接并核对身份。');const frame=buildV3Start({...input,...anchor});lines.length=0;await write(frame);const deadline=performance.now()+5000;
  while(performance.now()<deadline){const text=await line(Math.max(1,deadline-performance.now()));if(text==='V3 START ACCEPTED')return {accepted:true,node_id:anchor.identity.node_id,boot_id:anchor.identity.boot_id};if(text==='V3 ERR BOOTSTRAP'||text?.startsWith('V3 START REJECTED'))throw new Error('固件拒绝 V3 启动材料。');}
  throw new Error('启动结果未知；不能据此认定已保存或已采集。请检查设备与云端状态。');},
  async close(){closed=true;lines.length=0;buffer='';try{await reader.cancel();await pump;}finally{reader.releaseLock();writer.releaseLock();await port.close();}}};
}
