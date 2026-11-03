// Presence checks only. The serial encoder still validates all supplied values
// and checks a fresh device identity before writing startup materials.
export function startReadinessReasons({pending,connected,mqttReady,reuseSavedMqtt,token,reuseSavedCredential,ssid,security,password,eapUsername,eapPassword,eapServerVerification,eapCaPem,eapDomain}) {
 const reasons=[];
 if(pending)reasons.push('正在处理上一项操作，请等待完成。');
 if(!connected)reasons.push('请先连接 USB 串口并核对 V3 身份。');
 if(!mqttReady&&!reuseSavedMqtt)reasons.push('请读取本设备已验证 MQTT 授权，或明确复用设备已保存的授权。');
 if(!token&&!reuseSavedCredential)reasons.push('请填写本设备的备份设备凭证，或明确复用设备已保存的凭证。');
 if(!ssid)reasons.push('请填写 Wi-Fi SSID。');
 if(security==='personal'&&!password)reasons.push('请填写个人 Wi-Fi 密码。');
 if(security==='enterprise_peap'){
  if(!eapUsername)reasons.push('请填写 PEAP 用户名。');
  if(!eapPassword)reasons.push('请填写 PEAP 密码。');
  if(eapServerVerification==='ca'){
   if(!eapCaPem)reasons.push('使用 CA 验证时，请填写 PEAP CA 证书 PEM。');
   if(!eapDomain)reasons.push('使用 CA 验证时，请填写 PEAP 预期服务器域名。');
  }
 }
 return reasons;
}
