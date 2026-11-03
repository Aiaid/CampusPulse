import {describe,expect,it} from 'vitest';
import {startReadinessReasons} from '../../src/admin/provisioning/start-readiness.js';

const ready={pending:false,connected:true,mqttReady:true,reuseSavedMqtt:false,token:'synthetic-token',reuseSavedCredential:false,ssid:'Synthetic WiFi',security:'enterprise_peap',password:'',eapUsername:'synthetic-user',eapIdentity:'',eapPassword:'synthetic-password',eapServerVerification:'none',eapCaPem:'',eapDomain:''};

describe('V3 START presence checks',()=>{
 it('allows optional outer identity with supplied or locally reusable credentials',()=>{
  expect(startReadinessReasons(ready)).toEqual([]);
  expect(startReadinessReasons({...ready,eapIdentity:'synthetic-anonymous'})).toEqual([]);
  expect(startReadinessReasons({...ready,token:'',mqttReady:false,reuseSavedCredential:true,reuseSavedMqtt:true})).toEqual([]);
 });
 it.each([
  [{pending:true},'正在处理上一项操作'],
  [{connected:false},'连接 USB 串口'],
  [{mqttReady:false},'读取本设备已验证 MQTT 授权'],
  [{token:''},'备份设备凭证'],
  [{ssid:''},'Wi-Fi SSID'],
  [{eapUsername:''},'PEAP 用户名'],
  [{eapPassword:''},'PEAP 密码'],
  [{security:'personal',password:''},'个人 Wi-Fi 密码'],
  [{eapServerVerification:'ca',eapCaPem:'',eapDomain:'radius.example.test'},'PEAP CA 证书 PEM'],
  [{eapServerVerification:'ca',eapCaPem:'synthetic-ca',eapDomain:''},'PEAP 预期服务器域名'],
 ])('explains each existing blocking presence check: %j',(change,text)=>{
  const reasons=startReadinessReasons({...ready,...change});
  expect(reasons).toHaveLength(1);expect(reasons[0]).toContain(text);
  for(const value of Object.values(ready).filter(value=>typeof value==='string'&&value.startsWith('synthetic-')))expect(reasons.join(' ')).not.toContain(value);
 });
 it('retains the original presence gates across modes and credential combinations',()=>{
  for(const security of ['open','personal','enterprise_peap'])for(let mask=0;mask<2048;mask++){
   const keys=['pending','connected','mqttReady','reuseSavedMqtt','token','reuseSavedCredential','ssid','password','eapUsername','eapPassword','eapCaPem'];
   const values={...ready,security,eapServerVerification:'ca',eapDomain:'radius.example.test'};
   keys.forEach((key,i)=>{values[key]=mask&(1<<i)?ready[key]||true:false;});
   const blocked=values.pending||!values.connected||(!values.mqttReady&&!values.reuseSavedMqtt)||(!values.token&&!values.reuseSavedCredential)||!values.ssid||security==='personal'&&!values.password||security==='enterprise_peap'&&(!values.eapUsername||!values.eapPassword||!values.eapCaPem||!values.eapDomain);
   expect(startReadinessReasons(values).length>0).toBe(!!blocked);
  }
 });
 it('leaves value-format validation to the serial encoder',()=>{
  expect(startReadinessReasons({...ready,eapServerVerification:'ca',eapCaPem:'invalid-ca',eapDomain:'https://invalid.example.test'})).toEqual([]);
  expect(startReadinessReasons({...ready,security:'open',eapUsername:'',eapPassword:''})).toEqual([]);
 });
});
