import { mqttSettings } from './mqtt.js';
export const V3_ORIGIN='https://pulse.anend.net';
const nodePattern=/^cp_[0-9a-f]{12}$/;
const bootPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noncePattern=/^[0-9a-f]{32}$/;
const clockPrefix=[0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00,0x04];
export const serialSupport=()=>typeof navigator!=='undefined'&&!!navigator.serial&&globalThis.isSecureContext;
export function validateV3ClockKey(value) {
 if (!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['schema','audience','key_id','public_key_spki'].includes(k))||value.schema!=='cp-v3-signed-clock-key/1'||value.audience!==V3_ORIGIN||typeof value.key_id!=='string'||!/^[A-Za-z0-9_-]{1,32}$/.test(value.key_id)||typeof value.public_key_spki!=='string'||!/^[A-Za-z0-9_-]{122}$/.test(value.public_key_spki)) throw new Error('生产时钟公钥元数据无效；未发送启动配置。');
 let bytes;try{bytes=Uint8Array.from(atob(value.public_key_spki.replaceAll('-','+').replaceAll('_','/')+'=='),c=>c.charCodeAt(0));}catch{throw new Error('生产时钟公钥编码无效。');}
 const canonical=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 if(bytes.length!==91||canonical!==value.public_key_spki||clockPrefix.some((b,i)=>bytes[i]!==b)||!bytes.slice(clockPrefix.length).some(b=>b!==0)) throw new Error('生产时钟公钥必须为 P-256 SPKI DER 公钥。');
 return {schema:value.schema,audience:value.audience,key_id:value.key_id,public_key_spki:value.public_key_spki};
}
export async function fetchV3ClockKey(fetcher=globalThis.fetch) {
 const response=await fetcher(`${V3_ORIGIN}/api/v3/clock/key`,{credentials:'omit',cache:'no-store',redirect:'error'});
 if(!response.ok||response.redirected)throw new Error('无法读取生产时钟公钥；尚未发送启动配置。');
 const key=validateV3ClockKey(await response.json());
 const bytes=Uint8Array.from(atob(key.public_key_spki.replaceAll('-','+').replaceAll('_','/')+'=='),c=>c.charCodeAt(0));
 try{await crypto.subtle.importKey('spki',bytes,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}catch{throw new Error('生产时钟公钥曲线校验失败。');}
 return key;
}
export function validateV3Hello(value,nonce,expectedNode,{allowRestartRequired=false}={}) {
 if (typeof nonce!=='string'||!noncePattern.test(nonce)||!value||typeof value!=='object'||Array.isArray(value)||!nodePattern.test(value.node_id)||!bootPattern.test(value.boot_id)||value.request_id!==nonce||!Number.isSafeInteger(value.mono_ms)||value.mono_ms<0||
  Object.keys(value).some(k=>!['node_id','boot_id','request_id','mono_ms','restart_required','credential_state','mqtt_state'].includes(k))) throw new Error('V3 USB 身份或 nonce 校验失败；未发送凭证。');
 if (expectedNode&&value.node_id!==expectedNode) throw new Error('连接的设备与所选节点不一致；未发送凭证。');
 if (value.restart_required===true&&allowRestartRequired!==true) throw new Error('设备要求安全重启进入 USB 配置，当前未发送凭证。');
 if (value.restart_required!==undefined&&typeof value.restart_required!=='boolean') throw new Error('设备启动状态无效。');
 for(const key of ['credential_state','mqtt_state'])if(value[key]!==undefined&&!['ready','missing','unavailable'].includes(value[key]))throw new Error('设备保存凭证状态无效。');
 return value;
}
const utf8Bytes=value=>new TextEncoder().encode(value).length;
const printableAsciiPattern=/^[\x20-\x7e]+$/;
/** Structural browser checks only. Firmware parses and verifies X.509 and the server chain. */
export function validateV3Wifi({ssid,password,security='personal',eapUsername,eapIdentity,eapPassword,eapCaPem,eapDomain,eapServerVerification}) {
 if(typeof ssid!=='string'||utf8Bytes(ssid)<1||utf8Bytes(ssid)>32||!printableAsciiPattern.test(ssid))throw new Error('当前 USB 的 SSID 仅支持 1–32 个可打印 ASCII 字符，不支持中文等非 ASCII 文本。');
 if(!['open','personal','enterprise_peap'].includes(security))throw new Error('请选择支持的 Wi-Fi 认证方式。');
 const eap=[eapUsername,eapIdentity,eapPassword,eapCaPem,eapDomain,eapServerVerification];
 if(security!=='enterprise_peap'&&eap.some(value=>value!==undefined))throw new Error('开放或个人网络不能携带企业认证材料。');
 if(security==='open'){if(password!=='')throw new Error('开放网络不使用密码。');return {ssid,password:'',security};}
 if(security==='personal'){
  if(typeof password!=='string'||utf8Bytes(password)<8||utf8Bytes(password)>64||!printableAsciiPattern.test(password)||utf8Bytes(password)===64&&!/^[0-9a-fA-F]{64}$/.test(password))throw new Error('当前 USB 的个人 Wi-Fi 密码仅支持 8–63 个可打印 ASCII 字符或 64 位十六进制密钥。');
  return {ssid,password,security};
 }
 if(password!=='')throw new Error('PEAP 不使用个人 Wi-Fi 密码。');
 if([eapUsername,eapIdentity,eapPassword].some(value=>typeof value!=='string'||utf8Bytes(value)<1||utf8Bytes(value)>128||!printableAsciiPattern.test(value)))throw new Error('当前 USB 的 PEAP 用户名、外层身份和密码均仅支持 1–128 个可打印 ASCII 字符。');
 const emptyTrust=value=>value===undefined||value==='';
 const hasTrust=!emptyTrust(eapCaPem)||!emptyTrust(eapDomain);
 const verification=eapServerVerification===undefined?(hasTrust?'ca':'none'):eapServerVerification;
 if(!['none','ca'].includes(verification))throw new Error('PEAP 服务器验证方式无效。');
 const base={ssid,password:'',security,eap_username:eapUsername,eap_identity:eapIdentity,eap_password:eapPassword,eap_server_verification:verification};
 if(verification==='none'){
  if(hasTrust)throw new Error('不验证服务器时不能携带 CA 或域名；提供的证书不会被自动忽略。');
  return base;
 }
 if(typeof eapDomain!=='string'||utf8Bytes(eapDomain)>253||/^[0-9.]+$/.test(eapDomain)||eapDomain.split('.').some(label=>!/^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])$/.test(label)))throw new Error('PEAP 预期服务器域名须为单个 DNS 名称，不能使用 IP、URL、通配符或列表。');
 if(typeof eapCaPem!=='string'||utf8Bytes(eapCaPem)>4096||!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----(?:\r?\n)?$/.test(eapCaPem))throw new Error('PEAP 必须提供单个 PEM CA 证书，最多 4096 个 UTF-8 字节；固件将进一步解析并验证证书。');
 return {...base,eap_ca_pem:eapCaPem,eap_domain:eapDomain};
}
export function buildV3Start({identity,nonce,expectedNode,bootId,token,mqtt,reuseSavedCredential=false,reuseSavedMqtt=false,ssid,password,security='personal',eapUsername,eapIdentity,eapPassword,eapCaPem,eapDomain,eapServerVerification,windows=1,saveStartup=false,startupReconfigure=false,clockKey,sentWall,sentMono,receivedWall,receivedMono}) {
 validateV3Hello(identity,nonce,expectedNode);
 if(typeof reuseSavedCredential!=='boolean'||typeof reuseSavedMqtt!=='boolean')throw new Error('保存凭证复用选项无效。');
 if((reuseSavedCredential||reuseSavedMqtt)&&(!expectedNode||bootId!==identity.boot_id))throw new Error('复用保存凭证必须核对同一设备和本次启动。');
 if(reuseSavedCredential?(token!==undefined||identity.credential_state!=='ready'):(typeof token!=='string'||!/^[A-Za-z0-9_-]{32,192}$/.test(token)))throw new Error('请输入本设备有效的设备凭证，或核对设备已保存且可用的凭证；不能混用。');
 if(reuseSavedMqtt&&(mqtt!==undefined||identity.mqtt_state!=='ready'))throw new Error('设备未确认已保存可用的 MQTT 授权，或与提供的授权混用。');
 const bytes=utf8Bytes,wifi=validateV3Wifi({ssid,password,security,eapUsername,eapIdentity,eapPassword,eapCaPem,eapDomain,eapServerVerification});
 if(security==='enterprise_peap'&&saveStartup===true)throw new Error('当前持久启动配置尚未保存 PEAP 验证选择或实现其启动流程；PEAP 仅支持 USB 临时运行 1–3 个窗口。');
 if (typeof saveStartup!=='boolean'||typeof startupReconfigure!=='boolean'||startupReconfigure&&!saveStartup||clockKey!==undefined&&!saveStartup) throw new Error('启动保存选项无效。');
 if (![1,2,3].includes(windows)&&!(saveStartup&&windows===0)) throw new Error('临时运行仅支持 1–3 个窗口；保存模式才可选择连续运行。');
 const rtt=receivedMono-sentMono;
 if (![sentWall,sentMono,receivedWall,receivedMono].every(Number.isFinite)||rtt<0||rtt>2000||Math.abs(receivedWall-sentWall-rtt)>20) throw new Error('USB 时钟交换超时或主机时间跳变，请重试。');
 const m=reuseSavedMqtt?null:mqttSettings(mqtt);
 const payload={node_id:identity.node_id,boot_id:identity.boot_id,uplink_transport:'mqtt_tls',origin:V3_ORIGIN,...(reuseSavedCredential?{reuse_saved_credential:true}:{device_token:token}),...wifi,
  ...(reuseSavedMqtt?{reuse_saved_mqtt:true}:{mqtt_uri:m.uri,mqtt_username:m.username,mqtt_password:m.password,mqtt_namespace:m.namespace}),
  utc_ms:Math.floor((sentWall+receivedWall)/2),uncertainty_ms:Math.ceil(rtt/2)+251,anchor_mono_ms:identity.mono_ms,max_windows:windows};
 if(saveStartup){const key=validateV3ClockKey(clockKey);Object.assign(payload,{save_startup:true,startup_reconfigure:startupReconfigure,clock_key_id:key.key_id,clock_public_spki:key.public_key_spki});}
 const frame=`V3START ${JSON.stringify(payload).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))}\n`;
 if (bytes(frame)>=8192) throw new Error('V3 USB 消息超出固件上限。');
 return frame;
}
/** Bounded line reader. Unrecognized device output is discarded, never logged. */
export async function openV3Serial(port) {
 await port.open({baudRate:115200});
 let reader,writer,closed=false,buffer='',overflow=false,failure=null,startedSave=false,saved=false,waitingSave=false;
 const lines=[],waiters=[];
 try { await port.setSignals?.({dataTerminalReady:false,requestToSend:false}); reader=port.readable.getReader();writer=port.writable.getWriter(); }
 catch(error){await port.close();throw error;}
 const push=line=>{if(!line.startsWith('V3 HELLO ')&&!line.startsWith('V3 START REJECTED')&&!['V3 START ACCEPTED','V3 STARTUP SAVED','V3 STARTUP SAVE FAILED','V3 ERR BOOTSTRAP'].includes(line))return;if(waiters.length)waiters.shift()(line);else {lines.push(line);if(lines.length>32)lines.shift();}};
 const pump=(async()=>{try{while(!closed){const {value,done}=await reader.read();if(done)break;for(const byte of value){if(byte===10){if(!overflow)push(buffer.replace(/\r$/,''));buffer='';overflow=false;}else if(buffer.length<8192&&!overflow){buffer+=String.fromCharCode(byte);}else{overflow=true;buffer='';}}}}catch{failure=new Error('USB 连接已中断。');}finally{closed=true;while(waiters.length)waiters.shift()(null);}})();
 const line=async timeout=>{if(lines.length)return lines.shift();if(closed)throw failure||new Error('USB 连接已关闭。');return new Promise(resolve=>{const deliver=value=>{clearTimeout(timer);resolve(value);};const timer=setTimeout(()=>{const i=waiters.indexOf(deliver);if(i>=0)waiters.splice(i,1);resolve(null);},timeout);waiters.push(deliver);});};
 const write=async text=>{if(closed)throw failure||new Error('USB 连接已关闭。');const bytes=new TextEncoder().encode(text);try{await writer.write(bytes);}finally{bytes.fill(0);}};
 const hello=async(expectedNode,{allowRestartRequired=false}={})=>{
  for(let attempt=0;attempt<3;attempt++){
   const nonce=crypto.randomUUID().replaceAll('-',''),sentWall=Date.now(),sentMono=performance.now();lines.length=0;
   await write(`HELLO ${nonce}\n`);const deadline=performance.now()+2000;
   while(performance.now()<deadline){const text=await line(Math.max(1,deadline-performance.now()));if(!text?.startsWith('V3 HELLO '))continue;
    let value;try{value=JSON.parse(text.slice(9));}catch{continue;}if(value.request_id!==nonce)continue;
    const identity=validateV3Hello(value,nonce,expectedNode,{allowRestartRequired});return {identity,nonce,sentWall,sentMono,receivedWall:Date.now(),receivedMono:performance.now()};}
  }throw new Error('没有收到本次 nonce 对应的 V3 HELLO；未发送凭证。');
 };
 return {hello,async restart(expectedNode){if(typeof expectedNode!=='string'||!nodePattern.test(expectedNode))throw new Error('安全重启前必须核对设备身份。');const anchor=await hello(expectedNode,{allowRestartRequired:true});if(anchor.identity.restart_required!==true)throw new Error('设备未声明安全重启状态；未发送 RESTART。');await write('RESTART\n');return {restart_requested:true,node_id:anchor.identity.node_id};},async start(input){validateV3Wifi(input);const anchor=await hello(input.expectedNode);if(input.bootId&&anchor.identity.boot_id!==input.bootId)throw new Error('设备已经重启，请重新连接并核对身份。');const frame=buildV3Start({...input,...anchor});lines.length=0;await write(frame);const deadline=performance.now()+5000;
  while(performance.now()<deadline){const text=await line(Math.max(1,deadline-performance.now()));if(text==='V3 START ACCEPTED'){startedSave=input.saveStartup===true;saved=false;return {accepted:true,node_id:anchor.identity.node_id,boot_id:anchor.identity.boot_id};}if(text==='V3 ERR BOOTSTRAP'||text?.startsWith('V3 START REJECTED'))throw new Error('固件拒绝 V3 启动材料。');}
  throw new Error('启动结果未知；不能据此认定已保存或已采集。请检查设备与云端状态。');},
  async waitStartupSaved(timeout=300000){if(!startedSave)throw new Error('本次未请求保存启动配置。');if(saved)return {saved:true};if(waitingSave)throw new Error('正在等待启动配置保存回执。');if(!Number.isFinite(timeout)||timeout<=0||timeout>600000)throw new Error('保存确认等待时限无效。');waitingSave=true;try{const deadline=performance.now()+timeout;while(performance.now()<deadline){const text=await line(Math.max(1,deadline-performance.now()));if(text==='V3 STARTUP SAVED'){saved=true;return {saved:true};}if(text==='V3 STARTUP SAVE FAILED'||text==='V3 ERR BOOTSTRAP')throw new Error('保存未确认，请检查诊断或重新配置；当前不能确认生效的启动配置。');}throw new Error('尚未收到 V3 STARTUP SAVED；保存状态未知。请完成首次策略 ACK 后继续等待。');}finally{waitingSave=false;}},
  async close(){closed=true;lines.length=0;buffer='';try{await reader.cancel();await pump;}finally{reader.releaseLock();writer.releaseLock();await port.close();}}};
}
