import React, { useEffect, useRef, useState } from 'react';
import { Bluetooth, Usb, WifiHigh } from '@phosphor-icons/react';
import { Dialog, ErrorNotice, Field, Notice, Resource, useAdmin, useMutation, useResource } from './shared.jsx';
import { bluetoothSupport, connectProvisioning, selectProvisioningDevice } from './provisioning/bluetooth.js';
import { PIN_PATTERN } from './provisioning/security2.js';
import { serialSupport, selectProvisioningPort, connectSerialProvisioning } from './provisioning/serial.js';
import { assignProvisionConfig, cloudProgress, NODE_PATTERN, TOKEN_PATTERN } from './provisioning/enrollment.js';
import './provisioning.css';

export default function Provisioning({ onClose }) {
  const { api, sensitiveAction, notify } = useAdmin();
  const available = bluetoothSupport(), usbAvailable = serialSupport();
  const [mode, setMode] = useState(available ? 'ble' : usbAvailable ? 'usb' : 'ap');
  const [proof, setProof] = useState(''), [identity, setIdentity] = useState(null), [manualNode, setManualNode] = useState('');
  const [name, setName] = useState(''), [place, setPlace] = useState(''), [dataset, setDataset] = useState('controlled_test');
  const [ssid, setSsid] = useState(''), [password, setPassword] = useState(''), [existingToken, setExistingToken] = useState('');
  const [registered, setRegistered] = useState(false), [credentialReady, setCredentialReady] = useState(false), [configId, setConfigId] = useState('');
  const [registerUncertain, setRegisterUncertain] = useState(false), [rotateConsent, setRotateConsent] = useState(false), [detail, setDetail] = useState(null);
  const [submitted, setSubmitted] = useState(false), [handoff, setHandoff] = useState('');
  const [localStatus, setLocalStatus] = useState(null), [localError, setLocalError] = useState('');
  const [message, setMessage] = useState(''), [disconnected, setDisconnected] = useState(false);
  const client = useRef(null), token = useRef(''), attempt = useRef(crypto.randomUUID()), started = useRef(Date.now()), mounted = useRef(true);
  const mutation = useMutation(), places = useResource('/places');
  const node = identity?.node_id || manualNode;
  const progress = cloudProgress(detail, configId, started.current);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; client.current?.close(); client.current = null; token.current = ''; }; }, []);
  const close = () => { client.current?.close(); token.current = ''; setProof(''); setPassword(''); setExistingToken(''); setHandoff(''); onClose(); };
  useEffect(() => { const clear = () => { client.current?.close(); token.current = ''; setProof(''); setPassword(''); setExistingToken(''); setHandoff(''); setCredentialReady(false); }; window.addEventListener('pagehide', clear); return () => window.removeEventListener('pagehide', clear); }, []);
  const connect = () => {
    // The chooser must run synchronously in the user gesture.
    const selection = mode === 'usb' ? selectProvisioningPort() : selectProvisioningDevice();
    mutation.run(async () => {
      try {
        const selected = await selection; await client.current?.close(); client.current = null; setDisconnected(true);
        const connected = mode === 'usb'
          ? await connectSerialProvisioning(selected, { onDisconnect: () => { if (mounted.current) setDisconnected(true); } })
          : await connectProvisioning(selected, proof);
        if (!mounted.current) { await connected.client.close(); return; }
        if (identity && connected.identity.node_id !== identity.node_id) { await connected.client.close(); throw new Error('连接了另一台设备，请关闭向导后重新开始。'); }
        client.current = connected.client; setIdentity(connected.identity); setDisconnected(false); setLocalStatus(connected.identity); setLocalError('');
        if (mode === 'ble') selected.addEventListener('gattserverdisconnected', () => { if (mounted.current) setDisconnected(true); }, { once: true });
        setMessage(mode === 'usb' ? 'USB 配网已就绪；已读取现场设备的工厂身份，无需输入配网码。' : '8 位配网码已验证；以下工厂身份来自 Security 2 加密会话。');
      } finally { setProof(''); }
    });
  };
  const inspect = async () => { const result = await api(`/devices/${node}`); setDetail(result); setRegistered(true); setMessage('云端已有此设备。已有凭证无法从服务器取回；请使用已保存的设备凭证，或明确确认轮换。'); return result; };
  const register = () => mutation.run(async () => {
    if (!NODE_PATTERN.test(node) || !name.trim()) throw new Error('请先获取工厂节点 ID 并填写设备名称。');
    if (registerUncertain || registered) throw new Error('请先检查已有登记，并提供凭证或明确确认轮换。');
    setRegisterUncertain(true); // Keep this guard even if the HTTP response is lost.
    const result = await sensitiveAction(() => api('/devices', { method: 'POST', body: { id: node, name: name.trim(), board: identity?.board || 'FoloToy AI Passport / ESP32-C3' } }));
    if (!TOKEN_PATTERN.test(result.credential)) throw new Error('服务端未返回有效设备凭证。请检查登记结果。');
    token.current = result.credential; setCredentialReady(true); setRegistered(true); setRegisterUncertain(false); setMessage('设备已登记；独立设备凭证只保留在本向导内存中。');
  });
  const useSaved = () => mutation.run(async () => { if (!TOKEN_PATTERN.test(existingToken.trim())) throw new Error('仅接受该设备的 cpd_ 独立凭证。'); await inspect(); token.current = existingToken.trim(); setExistingToken(''); setCredentialReady(true); setRegisterUncertain(false); });
  const rotate = () => mutation.run(async () => {
    if (!rotateConsent) throw new Error('请先确认旧凭证会立即失效。');
    setCredentialReady(false); token.current = ''; setRegisterUncertain(true);
    const result = await sensitiveAction(() => api(`/devices/${node}/rotate-credential`, { method: 'POST', body: {} }));
    if (!TOKEN_PATTERN.test(result.credential)) throw new Error('未收到新凭证，请检查设备状态。');
    token.current = result.credential; setCredentialReady(true); setRegisterUncertain(false); setRotateConsent(false); setMessage('已按你的明确选择轮换凭证；需要把新凭证写入此设备。');
  });
  const assign = () => mutation.run(async () => { setConfigId(await assignProvisionConfig(api, node, attempt.current, place, dataset)); setMessage('位置和采集配置已发布，等待设备联网后获取并确认。'); });
  const transmit = () => mutation.run(async () => {
    if (!client.current || disconnected) throw new Error('请重新连接同一设备；蓝牙需要本次屏幕上的配网码。');
    if (!TOKEN_PATTERN.test(token.current)) throw new Error('设备凭证不可用，请重新开始登记检查。');
    if (!ssid || new TextEncoder().encode(ssid).length > 32 || new TextEncoder().encode(password).length < 8 || new TextEncoder().encode(password).length > 63) throw new Error('SSID 最多 32 字节；WPA2 密码需要 8–63 字节。');
    if (localStatus?.state === 'failed') attempt.current = crypto.randomUUID();
    started.current = Date.now(); setSubmitted(true); setLocalStatus(null); setLocalError('');
    try {
      const r = await client.current.request({ op: 'configure', node_id: node, attempt_id: attempt.current, ssid, password, device_token: token.current });
      if (r.attempt_id !== attempt.current || !['received', 'testing', 'saved'].includes(r.state)) throw new Error('设备返回了不同的尝试标识或未知状态，请核对设备。');
      setLocalStatus(r); setPassword(''); setSsid(''); setMessage(r.state === 'saved' ? '设备报告候选设置已保存，等待本次云端联系与配置应用确认。' : r.state === 'testing' ? '设备已开始验证网络与云端，仍需等待本次云端联系与配置应用确认。' : '设备已接收候选设置，正在验证网络与云端。接收不代表已保存或配置已生效。');
    } catch (error) { setMessage('未收到设备确认。请先检查设备屏幕和下方云端状态；本向导仍保留同一设备凭证，请勿因丢失响应盲目轮换。'); throw error; }
  });
  const prepareAp = () => { started.current = Date.now(); setHandoff(JSON.stringify({ v: 1, node_id: node, device_token: token.current, attempt_id: attempt.current })); setSubmitted(true); };
  useEffect(() => {
    if (!submitted || !node) return;
    let active = true, timer; const poll = async () => { try { const result = await api(`/devices/${node}`); if (active) setDetail(result); } catch { /* Explicit refresh exposes errors; polling never alters credentials. */ } if (active) timer = setTimeout(poll, 5000); };
    poll(); return () => { active = false; clearTimeout(timer); };
  }, [submitted, node, api]);
  useEffect(() => {
    if (!submitted || mode !== 'usb' || disconnected || mutation.pending || progress.applied) return;
    let active = true, timer;
    const poll = async () => {
      try { const status = await client.current?.request({ op: 'status' }); if (active && status) { setLocalStatus(status); setLocalError(''); } }
      catch { if (active) setLocalError('暂时无法读取 USB 状态。请保留当前向导并检查设备；仍以云端联系和 applied ACK 为完成依据。'); }
      if (active) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 300); return () => { active = false; clearTimeout(timer); };
  }, [submitted, mode, disconnected, mutation.pending, progress.applied]);
  useEffect(() => { if (progress.applied) { token.current = ''; setHandoff(''); setCredentialReady(false); setPassword(''); } }, [progress.applied]);
  return <Dialog title="连接并部署设备" onClose={close} pending={mutation.pending} wide>
    <div className="cp-provision" aria-busy={mutation.pending}>
      <p>依次完成本机连接、云端登记与配置发布、设备联网验证和设备应用确认。只支持本固件的 WPA2 个人网络；校园企业网 / PEAP 请使用已验证的个人热点或其他受支持网络。</p>
      <div className="cp-provision-modes">
        <button type="button" className={`cp-admin-button ${mode === 'ble' ? 'cp-admin-primary' : ''}`} disabled={!available || registered || !!identity || mutation.pending} onClick={() => setMode('ble')}><Bluetooth />蓝牙配网</button>
        <button type="button" className={`cp-admin-button ${mode === 'usb' ? 'cp-admin-primary' : ''}`} disabled={!usbAvailable || registered || !!identity || mutation.pending} onClick={() => setMode('usb')}><Usb />USB 配网</button>
        <button type="button" className={`cp-admin-button ${mode === 'ap' ? 'cp-admin-primary' : ''}`} disabled={registered || !!identity || mutation.pending} onClick={() => setMode('ap')}><WifiHigh />设备热点配网</button>
      </div>
      {(!available || !usbAvailable) && <Notice>此浏览器{!available ? '没有可用的 Web Bluetooth' : ''}{!available && !usbAvailable ? '，也' : ''}{!usbAvailable ? '没有可用的 Web Serial' : ''}。iPhone / iPad 请使用有屏幕设备的热点页面；无屏幕设备可连接支持 Web Serial 的桌面浏览器（如 Chrome / Edge）完成 USB 配网。功能以本浏览器实际可用接口为准。</Notice>}
      <section><h3>1 · 确认现场设备</h3>{mode === 'ble' ? <>
        <Field label="设备屏幕上的配网码" hint="8 位数字，保留开头的 0；5 分钟有效。使用 Security 2 验证，累计 5 次失败会锁定本次配网。"><input type="password" inputMode="numeric" pattern="[0-9]{8}" autoComplete="off" maxLength={8} value={proof} onChange={e => setProof(e.target.value)} /></Field>
        <button type="button" className="cp-admin-button" disabled={mutation.pending || !PIN_PATTERN.test(proof)} onClick={connect}>{identity ? '重新连接同一设备' : '选择蓝牙设备并验证'}</button>
      </> : mode === 'usb' ? <>
        <Notice>用数据线连接现场设备，关闭占用串口的终端或烧录工具，再选择对应 USB 串口。开始后会暂停采集并进入 USB 配网；无需屏幕或配网码。数据线连接本身不会登记云端身份。</Notice>
        <button type="button" className="cp-admin-button" disabled={mutation.pending} onClick={connect}>{identity ? '重新连接同一 USB 设备' : '选择 USB 设备并开始配网'}</button>
      </> : <><Notice>在设备屏幕选择 AP 模式。先保持互联网连接完成下方登记；随后加入设备显示的 CampusPulse 热点，输入本次 12 位热点密码，并在 Safari 打开 <strong>http://192.168.4.1</strong>。页面会核对屏幕上的 8 位配网码。HTTPS 管理页面不会直接请求本地 HTTP 设备。</Notice><Field label="设备屏幕上的工厂节点 ID" hint="本地设备页面还会核对该 ID；不能填写浏览器的蓝牙标识。"><input value={manualNode} onChange={e => setManualNode(e.target.value.trim().toLowerCase())} disabled={registered || registerUncertain} pattern="cp_[a-f0-9]{12}" placeholder="cp_001122aabbcc" autoComplete="off" /></Field></>}
        {identity && <p className="cp-admin-mono">{node} · {identity.board} {disconnected ? '（本机连接已断开）' : mode === 'usb' ? '（USB 工厂身份已读取）' : '（已验证身份）'}</p>}
      </section>
      <fieldset disabled={mutation.pending || !NODE_PATTERN.test(node)}><legend>2 · 云端登记</legend><Field label="设备名称"><input value={name} maxLength={80} onChange={e => setName(e.target.value)} disabled={registered} /></Field><button type="button" className="cp-admin-button" onClick={register} disabled={registered || registerUncertain || !name.trim()}>登记并取得设备凭证</button> <button type="button" className="cp-admin-button" onClick={() => mutation.run(inspect)}>检查已有登记</button>
        {(registered || registerUncertain) && !credentialReady && <><Notice>登记或轮换响应丢失时不会自动重发或轮换。先检查登记；只有你明确确认时才使旧凭证失效。</Notice><Field label="已有的独立设备凭证"><input type="password" autoComplete="off" value={existingToken} onChange={e => setExistingToken(e.target.value)} /></Field><button type="button" className="cp-admin-button" onClick={useSaved}>使用已有设备凭证</button>{registered && <details><summary>无法取得旧凭证：明确轮换</summary><label className="cp-admin-checkbox"><input type="checkbox" checked={rotateConsent} onChange={e => setRotateConsent(e.target.checked)} />我确认让这台设备的旧凭证立即失效，并在现场重新写入。</label><button type="button" className="cp-admin-button cp-admin-danger" disabled={!rotateConsent} onClick={rotate}>确认轮换并重新配网</button></details>}</>}
        {credentialReady && <p role="status">设备凭证已准备，仅保留于当前向导。</p>}</fieldset>
      <fieldset disabled={mutation.pending || !credentialReady || !!configId}><legend>3 · 位置与采集配置</legend><Field label="部署地点"><Resource resource={places}>{data => <select value={place} onChange={e => setPlace(e.target.value)}><option value="">未定位 / 移动中</option>{data.places.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Resource></Field><Field label="数据用途"><select value={dataset} onChange={e => setDataset(e.target.value)}><option value="controlled_test">受控测试</option><option value="field">现场观测</option></select></Field><p>发布 7 天有效配置：30 秒地址汇总、5 秒分箱、最多 64 个地址；MAC 仅作 BLE 可见标识，不能当作人数。地址汇总保留 24 小时；窗口和状态保留 30 天。固定地点需选择实际位置。</p><button type="button" className="cp-admin-button" onClick={assign} disabled={places.loading || !!places.error}>登记位置并发布配置</button>{configId && <p className="cp-admin-mono">已发布 {configId}</p>}</fieldset>
      <fieldset disabled={mutation.pending || !credentialReady || !configId || progress.applied}><legend>4 · 将配置交给设备</legend>{mode !== 'ap' ? <form onSubmit={e => { e.preventDefault(); transmit(); }}><Field label="Wi-Fi SSID"><input value={ssid} onChange={e => setSsid(e.target.value)} required autoComplete="off" /></Field><Field label="Wi-Fi 密码" hint={mode === 'usb' ? '通过现场 USB 数据线发往设备，不发送给云端 API。' : '通过 Security 2 加密蓝牙发往现场设备，不发送给云端 API。'}><input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" /></Field><button type="submit" className="cp-admin-button cp-admin-primary" disabled={disconnected}>{mode === 'usb' ? '通过 USB 发送给设备' : '加密发送给设备'}</button></form> : <><button type="button" className="cp-admin-button cp-admin-primary" onClick={prepareAp}>显示本地配网交接内容</button>{handoff && <Field label="复制到设备本地页面的交接内容" hint="包含独立设备凭证。勿发送给他人；关闭向导后清除。Wi-Fi 密码只在设备本地页面填写。"><textarea readOnly rows={5} value={handoff} autoComplete="off" spellCheck={false} onFocus={e => e.target.select()} /></Field>}<p>复制后加入设备热点，打开 http://192.168.4.1，核对节点 ID、填写屏幕配网码和目标 Wi-Fi。设备收到后会关闭热点并测试网络；完成后恢复互联网连接返回此页。</p></>}</fieldset>
      {submitted && <section aria-live="polite"><h3>5 · 等待真实设备确认</h3><ol className="cp-provision-checks"><li>云端身份：{registered ? '已登记' : '待检查'}</li><li>期望配置：{configId || '尚未发布'}</li><li>本机验证状态：{localStatus?.state || '等待设备状态'}{localStatus?.reason ? `（${localStatus.reason}）` : ''}</li><li>本次云端联系：{progress.contact ? '已收到设备联系' : '等待，尚未确认联网'}</li><li>设备应用确认：{progress.applied ? '已收到当前配置 applied ACK' : '等待，尚未确认配置生效'}</li></ol><button type="button" className="cp-admin-button" disabled={mutation.pending} onClick={() => mutation.run(async () => { setDetail(await api(`/devices/${node}`)); })}>检查云端状态</button>{localError && <p role="status">{localError}</p>}<Notice>设备接收设置后先测试网络与云端认证，通过后才保存并重启；失败信息在设备屏幕或 USB 状态显示。蓝牙断开、USB 重启或热点消失本身不代表成功。云端确认也不等于射频完整性或硬件验收。</Notice>{progress.applied && <button type="button" className="cp-admin-button cp-admin-primary" onClick={() => { notify('设备已联系云端并确认应用配置。'); close(); }}>完成并返回设备目录</button>}</section>}
      {message && <p role="status" className="cp-provision-status">{message}</p>}<ErrorNotice error={mutation.error} />
    </div>
  </Dialog>;
}
