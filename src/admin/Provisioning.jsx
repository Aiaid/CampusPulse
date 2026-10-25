import React, { useEffect, useRef, useState } from 'react';
import { Bluetooth, Usb, WifiHigh } from '@phosphor-icons/react';
import { Dialog, ErrorNotice, Field, Notice, Resource, useAdmin, useMutation, useResource } from './shared.jsx';
import { bluetoothSupport, connectProvisioning, selectProvisioningDevice } from './provisioning/bluetooth.js';
import { PIN_PATTERN } from './provisioning/security2.js';
import { serialSupport, selectProvisioningPort, connectSerialProvisioning, connectSerialDiagnostics } from './provisioning/serial.js';
import { saveProvisionSettings, cloudProgress, inspectEnrollment, currentProvisionConfig, NODE_PATTERN, TOKEN_PATTERN } from './provisioning/enrollment.js';
import { diagnosticView, previousDiagnostic, bootEvidence } from './provisioning/diagnostics.js';
import { wifiPayload, supportsWifiMode } from './provisioning/network.js';
import './provisioning.css';

export default function Provisioning({ onClose, initialNodeId = '' }) {
  const { api, sensitiveAction, notify } = useAdmin();
  const available = bluetoothSupport(), usbAvailable = serialSupport();
  const [mode, setMode] = useState(available ? 'ble' : usbAvailable ? 'usb' : 'ap');
  const [proof, setProof] = useState(''), [identity, setIdentity] = useState(null), [manualNode, setManualNode] = useState(initialNodeId);
  const [lookup, setLookup] = useState('idle'), [lookupError, setLookupError] = useState(null), [detail, setDetail] = useState(null);
  const [name, setName] = useState(''), [place, setPlace] = useState(''), [dataset, setDataset] = useState('controlled_test');
  const [ssid, setSsid] = useState(''), [password, setPassword] = useState(''), [existingToken, setExistingToken] = useState('');
  const [wifiSecurity, setWifiSecurity] = useState('wpa2'), [eapUsername, setEapUsername] = useState(''), [eapIdentity, setEapIdentity] = useState(''), [eapPassword, setEapPassword] = useState('');
  const [credentialChanged, setCredentialChanged] = useState(false);
  const [credentialMode, setCredentialMode] = useState(''), [configId, setConfigId] = useState(''), [configDirty, setConfigDirty] = useState(false);
  const [registerUncertain, setRegisterUncertain] = useState(false), [rotateConsent, setRotateConsent] = useState(false);
  const [writeComplete, setWriteComplete] = useState(false);
  const [submitted, setSubmitted] = useState(false), [handoff, setHandoff] = useState(''), [message, setMessage] = useState('');
  const [localStatus, setLocalStatus] = useState(null), [lastDiagnostic, setLastDiagnostic] = useState(null), [localError, setLocalError] = useState('');
  const [bootChanged, setBootChanged] = useState(false);
  const knownBoot = useRef(null);
  const [disconnected, setDisconnected] = useState(false), [debugAttached, setDebugAttached] = useState(false), [cloudError, setCloudError] = useState('');
  const preparedNode = useRef(''), configOperation = useRef(crypto.randomUUID()), selectedConnection = useRef(null);
  const client = useRef(null), diagnosticClient = useRef(null), diagnosticPort = useRef(null), token = useRef('');
  const attempt = useRef(crypto.randomUUID()), started = useRef(0), mounted = useRef(true), selectedNode = useRef('');
  const mutation = useMutation(), places = useResource('/places');
  const node = identity?.node_id || manualNode;
  selectedNode.current = node;
  const registered = lookup === 'existing';
  const physicalReady = mode === 'ap' ? NODE_PATTERN.test(manualNode) : !!identity && !!client.current;
  const reusableCredential = registered && !credentialChanged && identity?.has_saved_credential === true;
  const mayRequestSavedCredential = reusableCredential || (registered && !credentialChanged && mode === 'ap');
  const credentialReady = credentialMode === 'saved' ? mayRequestSavedCredential : credentialMode === 'provided' && TOKEN_PATTERN.test(token.current);
  const currentConfig = currentProvisionConfig(detail);
  const progress = submitted ? cloudProgress(detail, configId, started.current) : { contact: false, applied: false };
  const diagnosis = diagnosticView(localStatus), previous = previousDiagnostic(localStatus), boot = bootEvidence(localStatus);
  const validating = submitted && !diagnosis.failed && !writeComplete && !progress.applied &&
    (mode !== 'ap' || ['sending', 'received', 'testing', 'saved'].includes(localStatus?.state));
  const submitReason = validating ? '设备正在处理本次设置，等待明确结果后可继续修改。'
    : writeComplete ? '本次配网已完成。再次发送前，点击重新配置网络。'
      : !registered ? '请先确认设备的云端登记。'
        : !physicalReady || disconnected ? '发送前请连接同一台现场设备。'
          : !credentialReady ? '发送前请在上方准备设备凭证；现在仍可编辑配置和 Wi-Fi。'
            : configDirty || !configId ? '位置或采集设置尚未保存，请先点击保存配置。'
              : currentConfig?.id !== configId ? '云端当前配置已变化或失效，请重新检查并保存配置。'
              : detail?.device?.enabled === false ? '此设备已停用，请先在设备详情启用。'
                : mode !== 'ap' && !supportsWifiMode(identity, wifiSecurity) ? '当前固件未报告支持此认证方式，请升级固件或选择受支持的网络。' : '';
  const acceptStatus = status => {
    if (!status) return;
    if (status.node_id && status.node_id !== selectedNode.current) throw new Error('USB 返回了另一台设备的身份，已停止读取。');
    const staleAttempt = submitted && !writeComplete &&
      ((status.attempt_id && status.attempt_id !== attempt.current) ||
        (['failed', 'stop_failed'].includes(status.state) && status.attempt_id !== attempt.current));
    if (staleAttempt) {
      setLocalError('收到的状态属于其他尝试，仍在等待本次设备结果。');
      return;
    }
    const evidence = bootEvidence(status);
    if (evidence) { if (knownBoot.current && knownBoot.current !== evidence.boot_id) setBootChanged(true); knownBoot.current = evidence.boot_id; }
    setLocalStatus(status);
    const safe = diagnosticView(status).diagnostic; if (safe) setLastDiagnostic(safe);
    setLocalError('');
  };
  const clearSecrets = () => { token.current = ''; setCredentialMode(''); setProof(''); setPassword(''); setEapPassword(''); setExistingToken(''); setHandoff(''); };
  const close = () => { void client.current?.close(); void diagnosticClient.current?.close(); clearSecrets(); onClose(); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void client.current?.close(); void diagnosticClient.current?.close(); client.current = null; diagnosticClient.current = null; token.current = ''; }; }, []);
  useEffect(() => { const clear = () => { void client.current?.close(); void diagnosticClient.current?.close(); clearSecrets(); }; window.addEventListener('pagehide', clear); return () => window.removeEventListener('pagehide', clear); }, []);
  const applyLookup = (result, target) => {
    if (!mounted.current || selectedNode.current !== target) return;
    setLookup(result.kind); setLookupError(null); setDetail(result.detail);
    if (result.kind === 'existing') {
      setName(result.detail.device.name || '');
      if (preparedNode.current !== target || (!configDirty && !submitted)) {
        const current = currentProvisionConfig(result.detail);
        const desired = result.detail.configs?.find(row => row.id === result.detail.device.desired_config_id);
        const placement = result.detail.placements?.find(row => row.id === desired?.config?.placement_id);
        setPlace(placement?.place_id || ''); setDataset(desired?.config?.dataset || 'controlled_test');
        setConfigId(current?.id || ''); setConfigDirty(false);
        preparedNode.current = target; configOperation.current = crypto.randomUUID();
      }
    }
  };
  const inspect = async (target = node) => {
    setLookup('checking'); setLookupError(null);
    try { const result = await inspectEnrollment(api, target); applyLookup(result, target); return result; }
    catch (error) { if (selectedNode.current === target && mounted.current) { setLookup('error'); setLookupError(error); } throw error; }
  };
  useEffect(() => {
    if (!NODE_PATTERN.test(node)) { setLookup('idle'); setDetail(null); return; }
    const timer = setTimeout(() => { void inspect(node).catch(() => {}); }, 150);
    return () => clearTimeout(timer);
  }, [node, api]);
  useEffect(() => { if (reusableCredential && !credentialMode && !registerUncertain) setCredentialMode('saved'); }, [reusableCredential, credentialMode, registerUncertain]);
  const bindConnection = async (connected, targetMode, selected) => {
    const expected = initialNodeId || identity?.node_id || (NODE_PATTERN.test(manualNode) ? manualNode : null);
    if (expected && connected.identity.node_id !== expected) { await connected.client.close(); throw new Error('现场设备与所选云端节点不同。请连接同一台设备，原凭证未发送。'); }
    if (!mounted.current) { await connected.client.close(); return; }
    selectedConnection.current = selected;
    client.current = connected.client; setIdentity(connected.identity); setMode(targetMode); setDisconnected(false); setDebugAttached(false);
    const evidence = bootEvidence(connected.identity);
    if (evidence) { if (knownBoot.current && knownBoot.current !== evidence.boot_id) setBootChanged(true); knownBoot.current = evidence.boot_id; }
    setLocalStatus(connected.identity); setLocalError('');
    if (targetMode === 'ble') selected.addEventListener('gattserverdisconnected', () => { if (mounted.current && client.current === connected.client) setDisconnected(true); }, { once: true });
    setMessage(targetMode === 'usb' ? '现场 USB 配网已就绪，正在核对云端登记。' : '配网码已验证，正在核对云端登记。');
  };
  const connect = (targetMode = mode, knownPort = null) => {
    const selection = knownPort ? Promise.resolve(knownPort) : targetMode === 'usb' ? selectProvisioningPort() : selectProvisioningDevice();
    mutation.run(async () => {
      try {
        const selected = await selection; await client.current?.close(); await diagnosticClient.current?.close(); client.current = null; diagnosticClient.current = null;
        setDisconnected(true); setDebugAttached(false);
        setMessage(targetMode === 'usb' ? '正在等待设备启动并确认 USB 配网，尚未发送 Wi-Fi 设置。' : '正在验证配网码并读取现场身份。');
        const connected = targetMode === 'usb' ? await connectSerialProvisioning(selected, { onDisconnect: () => { if (mounted.current) setDisconnected(true); } }) : await connectProvisioning(selected, proof);
        await bindConnection(connected, targetMode, selected);
      } finally { setProof(''); }
    });
  };
  const attachDiagnostics = () => {
    const selection = selectProvisioningPort();
    mutation.run(async () => {
      const port = await selection; await diagnosticClient.current?.close();
      const { client: reader, status } = await connectSerialDiagnostics(port, node, { onDisconnect: () => { if (mounted.current) setDebugAttached(false); } });
      try {
        if (!NODE_PATTERN.test(status.node_id) || (node && status.node_id !== node)) throw new Error('USB 诊断来自另一台设备，原配网向导未改变。');
        if (!node) { setManualNode(status.node_id); selectedNode.current = status.node_id; }
        acceptStatus(status); diagnosticClient.current = reader; diagnosticPort.current = port; setDebugAttached(true);
        setMessage('已连接只读 USB 诊断，未发送配置命令。若设备因串口打开而复位，之前的 RAM 故障信息可能已丢失。');
      } catch (error) { await reader.close(); throw error; }
    });
  };
  const register = () => mutation.run(async () => {
    if (lookup !== 'new' || !physicalReady || registerUncertain || !name.trim()) throw new Error('请先核对现场身份与云端登记状态。');
    const before = await inspectEnrollment(api, node);
    if (before.kind === 'existing') { applyLookup(before, node); throw new Error('此节点已被登记，已切换为已有设备重配。请保留原云端身份。'); }
    setRegisterUncertain(true);
    try {
      const result = await sensitiveAction(() => api('/devices', { method: 'POST', body: { id: node, name: name.trim(), board: identity?.board || 'FoloToy AI Passport / ESP32-C3' } }));
      if (!TOKEN_PATTERN.test(result.credential)) throw new Error('登记未返回有效凭证，请查询登记结果。');
      token.current = result.credential; setCredentialChanged(true); setCredentialMode('provided'); setRegisterUncertain(false);
      await inspect(); setMessage('首次登记完成。独立设备凭证保留在本向导内存，接下来配置网络。');
    } catch (error) {
      if (error.status === 409) {
        const existing = await inspectEnrollment(api, node); applyLookup(existing, node); setRegisterUncertain(false);
        throw new Error(existing.kind === 'existing' ? '登记时发生冲突（409），查询已确认此节点存在。请按已有设备流程重配；未重新创建身份或轮换凭证。' : '登记发生冲突（409），请重新检查状态后处理。');
      }
      if (error.status >= 400 && error.status < 500) setRegisterUncertain(false);
      throw error;
    }
  });
  const useSaved = () => mutation.run(async () => {
    if (!TOKEN_PATTERN.test(existingToken.trim())) throw new Error('仅接受这台设备已保存的 cpd_ 独立凭证。');
    const current = await inspect(); if (current.kind !== 'existing') throw new Error('云端尚未登记这台设备。');
    token.current = existingToken.trim(); setExistingToken(''); setCredentialMode('provided'); setRegisterUncertain(false); setMessage('已使用提供的设备凭证；云端身份和旧凭证未被修改。');
  });
  const rotate = () => mutation.run(async () => {
    if (!registered || !rotateConsent) throw new Error('请先确认旧凭证会立即失效。');
    token.current = ''; setCredentialMode(''); setCredentialChanged(true); setRegisterUncertain(true);
    const result = await sensitiveAction(() => api(`/devices/${node}/rotate-credential`, { method: 'POST', body: {} }));
    if (!TOKEN_PATTERN.test(result.credential)) throw new Error('未收到新凭证，请先查询状态，勿自动重复轮换。');
    token.current = result.credential; setCredentialMode('provided'); setRegisterUncertain(false); setRotateConsent(false); setMessage('已按明确确认轮换凭证；旧凭证已失效，需要完成现场写入。');
  });
  const changeConfig = (key, value) => {
    if (key === 'place') setPlace(value); else setDataset(value);
    setConfigDirty(true); setConfigId(''); configOperation.current = crypto.randomUUID();
    if (mode === 'ap' && submitted && !validating) {
      setHandoff(''); setSubmitted(false); started.current = 0; attempt.current = crypto.randomUUID();
      setMessage('配置已修改，保存后请重新生成本地配网交接内容。');
    }
  };
  const saveConfig = () => mutation.run(async () => {
    if (!registered || validating) throw new Error('请先确认已登记设备，并等待本次设备写入结束。');
    const id = await saveProvisionSettings(api, node, configOperation.current, place, dataset);
    setConfigId(id); setConfigDirty(false);
    configOperation.current = crypto.randomUUID();
    await inspect(); setMessage('配置已保存，后续以当前设置为准；设备应用状态会单独确认。');
  });
  const restartNetwork = () => {
    attempt.current = crypto.randomUUID(); started.current = 0;
    token.current = ''; setCredentialMode(''); setCredentialChanged(false); setRegisterUncertain(false);
    setSubmitted(false); setWriteComplete(false); setHandoff(''); setPassword(''); setEapPassword('');
    setLocalStatus(null); setCloudError('');
    if (mode === 'usb') connect(mode, selectedConnection.current);
    else if (mode === 'ble') {
      setManualNode(node); void client.current?.close(); client.current = null; setIdentity(null); setDisconnected(true);
      setMessage('请在设备上开始新配网，输入新显示的配网码后连接同一台设备。');
    }
  };
  const transmit = () => mutation.run(async () => {
    if (!client.current || disconnected) throw new Error('请连接同一台现场设备后再提交。');
    if (submitReason) throw new Error(submitReason);
    if (detail?.device?.enabled === false) throw new Error('此云端节点已停用，请先在设备详情启用，再重新检查登记状态。');
    if (!supportsWifiMode(identity, wifiSecurity)) throw new Error('当前设备固件未报告此认证方式，请先升级固件。');
    const network = wifiPayload({ mode: wifiSecurity, ssid, password, username: eapUsername, identity: eapIdentity, enterprisePassword: eapPassword });
    if (localStatus?.state === 'failed' || (submitted && localStatus?.state === 'waiting')) attempt.current = crypto.randomUUID();
    const body = { op: 'configure', node_id: node, attempt_id: attempt.current, ...network, ...(credentialMode === 'saved' ? { reuse_saved_credential: true } : { device_token: token.current }) };
    const wasSubmitted = submitted, previousStarted = started.current, previousStatus = localStatus;
    started.current = Date.now(); setWriteComplete(false); setSubmitted(true); setLocalError(''); setCloudError('');
    setLocalStatus({ state: 'sending' });
    try {
      const result = await client.current.request(body);
      if (result.attempt_id !== attempt.current || !['received', 'testing', 'saved'].includes(result.state)) throw new Error('设备返回了不同尝试标识或未知状态，请读取诊断。');
      acceptStatus(result); setPassword(''); setEapPassword(''); setMessage('设备已接收本次网络设置。下面分别显示设备验证与云端应用确认。');
    } catch (error) {
      if (error.configureSent === false) { started.current = previousStarted; setSubmitted(wasSubmitted); setLocalStatus(previousStatus); setLocalError('本次设置尚未发送。请处理设备就绪或身份检查提示后再试，现有凭证仍保留。'); }
      else setLocalError('本机确认尚不确定。请先读取设备状态；连接断开不代表验证失败。现有凭证仍保留，勿因响应丢失直接轮换。');
      throw error;
    }
  });
  const prepareAp = () => { if (submitReason) return; started.current = Date.now(); setHandoff(JSON.stringify({ v: 1, node_id: node, attempt_id: attempt.current, ...(credentialMode === 'saved' ? { reuse_saved_credential: true } : { device_token: token.current }) })); setSubmitted(true); };
  const readStatus = async () => {
    const source = diagnosticClient.current || client.current;
    if (!source) throw new Error('请先连接 USB 诊断或现场设备。');
    const status = await source.request({ op: 'status' }); acceptStatus(status);
  };
  useEffect(() => {
    if (!submitted || !node) return;
    let active = true, timer;
    const poll = async () => { try { const result = await api(`/devices/${node}`); if (active) { setDetail(result); setCloudError(''); } } catch { if (active) setCloudError('暂时无法查询云端。请恢复互联网后重新检查；现有设备状态仍保留。'); } if (active) timer = setTimeout(poll, 5000); };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [submitted, node, api]);
  useEffect(() => {
    if (!(debugAttached || (submitted && mode === 'usb' && !disconnected)) || mutation.pending || progress.applied) return;
    let active = true, timer;
    const poll = async () => { try { const source = diagnosticClient.current || client.current; const status = await source?.request({ op: 'status' }); if (active) acceptStatus(status); } catch { if (active) setLocalError('USB 状态暂时不可读，已保留最后一次诊断；请检查数据线或串口占用，并继续检查云端。'); } if (active) timer = setTimeout(poll, 1500); };
    timer = setTimeout(poll, 300); return () => { active = false; clearTimeout(timer); };
  }, [submitted, mode, disconnected, debugAttached, mutation.pending, progress.applied]);
  useEffect(() => { if (progress.applied && !writeComplete) { setWriteComplete(true); token.current = ''; setCredentialMode(''); setHandoff(''); setPassword(''); setEapPassword(''); } }, [progress.applied, writeComplete]);
  return <Dialog title={initialNodeId ? '重新配置设备网络' : '连接并部署设备'} onClose={close} pending={mutation.pending} wide>
    <div className="cp-provision" aria-busy={mutation.pending}>
      <p>已登记设备会带入当前设置。位置、采集配置和 Wi-Fi 可以继续修改，保存后以新设置为准；发送到设备前再核对连接和设备凭证。</p>
      <div className="cp-provision-modes">{[['ble', '蓝牙配网', Bluetooth, available], ['usb', 'USB 配网', Usb, usbAvailable], ['ap', '设备热点配网', WifiHigh, true]].map(([key, label, Icon, supported]) => <button key={key} type="button" className={`cp-admin-button ${mode === key ? 'cp-admin-primary' : ''}`} disabled={!supported || !!identity || submitted || mutation.pending} onClick={() => setMode(key)}><Icon />{label}</button>)}</div>
      {(!available || !usbAvailable) && <Notice>此浏览器{!available ? '没有可用的 Web Bluetooth' : ''}{!available && !usbAvailable ? '，也' : ''}{!usbAvailable ? '没有可用的 Web Serial' : ''}。iPhone / iPad 使用设备热点页面；无屏幕设备可用支持 Web Serial 的桌面 Chrome / Edge 连接 USB。</Notice>}
      <section><h3>1 · 确认现场设备</h3>
        {mode === 'ble' ? <><Field label="设备屏幕上的配网码" hint="8 位数字，保留开头的 0；5 分钟有效，累计 5 次失败锁定本次配网。"><input type="password" inputMode="numeric" pattern="[0-9]{8}" autoComplete="off" maxLength={8} value={proof} onChange={e => setProof(e.target.value)} /></Field><button type="button" className="cp-admin-button" disabled={mutation.pending || validating || !PIN_PATTERN.test(proof)} onClick={() => connect()}>{identity ? '重新连接同一设备' : '选择蓝牙设备并验证'}</button></>
          : mode === 'usb' ? <><p>连接数据线并关闭其他串口程序。开始配网会暂停采集，无需屏幕或配网码。</p><button type="button" className="cp-admin-button" disabled={mutation.pending || validating} onClick={() => connect()}>{identity ? '重新连接同一 USB 设备' : '选择 USB 设备并开始配网'}</button></>
            : <><Notice>先保持互联网完成云端核对，再加入设备屏幕显示的热点，使用 12 位热点密码打开 http://192.168.4.1。本地页面核对 8 位配网码并接收 Wi-Fi 密码。</Notice><Field label="设备屏幕上的工厂节点 ID"><input value={manualNode} onChange={e => setManualNode(e.target.value.trim().toLowerCase())} disabled={!!initialNodeId || registered || registerUncertain} pattern="cp_[a-f0-9]{12}" autoComplete="off" placeholder="cp_001122aabbcc" /></Field></>}
        {identity && <p className="cp-admin-mono">{node} · {identity.board} {disconnected ? '（本机连接已断开）' : mode === 'usb' ? '（USB 工厂身份已读取）' : '（已验证身份）'}</p>}
        {initialNodeId && !identity && <p>已选择云端节点。写入前仍需核对同一台现场设备。</p>}
      </section>
      <section><h3>2 · 云端身份与设备凭证</h3>
        {lookup === 'idle' && <p>确认工厂节点 ID 后会自动检查登记状态。</p>}{lookup === 'checking' && <p role="status">正在查询云端是否已有此节点…</p>}
        {lookup === 'new' && <><Notice>这是尚未登记的节点。首次登记只创建一次云端身份；连接 Wi-Fi 需要下一步现场写入。</Notice><Field label="设备名称"><input value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field><button className="cp-admin-button" disabled={mutation.pending || !physicalReady || registerUncertain || !name.trim()} onClick={register}>首次登记并取得设备凭证</button></>}
        {registered && <><div className="cp-provision-existing"><strong>已登记设备 · {detail?.device?.name || '现场节点'}</strong><p>本次重新配置网络，沿用现有云端身份。不会再次创建设备记录。</p></div>
          {detail?.device?.enabled === false && <Notice>此云端节点已停用，设备认证会被拒绝。请在设备详情启用后重新检查登记状态，再提交 Wi-Fi。</Notice>}
          {mayRequestSavedCredential && <label className="cp-provision-option"><input type="radio" name="credential-source" checked={credentialMode === 'saved'} disabled={mutation.pending || registerUncertain || submitted} onChange={() => { token.current = ''; setCredentialMode('saved'); }} /><span><strong>保留设备内现有凭证</strong><small>{mode === 'ap' ? '由设备本地页面核验是否支持复用；旧页面拒绝时请改用备份凭证。不会在浏览器读取设备内凭证。' : '设备已报告可复用保存的凭证；凭证不会被读取到浏览器。'}</small></span></label>}
          {credentialMode === 'provided' && <p role="status">设备凭证已准备，仅保留于当前向导。</p>}
          {!mayRequestSavedCredential && credentialMode !== 'provided' && <p>此连接尚未提供可复用凭证能力。请使用已保存的凭证；无法取得时才考虑明确轮换。</p>}
          <details><summary>使用已保存的设备凭证或更换凭证</summary><Field label="已有的独立设备凭证"><input type="password" autoComplete="off" value={existingToken} onChange={e => setExistingToken(e.target.value)} disabled={submitted && !diagnosis.failed} /></Field><button className="cp-admin-button" disabled={mutation.pending || (submitted && !diagnosis.failed)} onClick={useSaved}>使用已有设备凭证</button><details><summary>无法取得旧凭证：明确轮换</summary><Notice>轮换会立即使旧凭证失效，设备可能暂停联网。只在确实需要更换凭证时使用。</Notice><label className="cp-admin-checkbox"><input type="checkbox" checked={rotateConsent} onChange={e => setRotateConsent(e.target.checked)} />我确认旧凭证会立即失效，并将新凭证写入这台设备。</label><button className="cp-admin-button cp-admin-danger" disabled={mutation.pending || !rotateConsent || (submitted && !diagnosis.failed)} onClick={rotate}>确认轮换并重新配网</button></details></details>
        </>}
        {registerUncertain && <Notice>上次登记或轮换的结果尚不确定。请先查询结果；不会自动再次登记或轮换。已有凭证无法由服务器再次取回。</Notice>}
        {NODE_PATTERN.test(node) && <button className="cp-admin-button" disabled={mutation.pending || lookup === 'checking'} onClick={() => mutation.run(() => inspect())}>重新检查登记状态</button>}
        <ErrorNotice error={lookupError} />
      </section>
      <fieldset disabled={mutation.pending || !registered || validating}><legend>3 · 位置与采集配置</legend>
        <Field label="部署地点"><Resource resource={places}>{data => <select value={place} onChange={e => changeConfig('place', e.target.value)}><option value="">未定位 / 移动中</option>{data.places.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Resource></Field>
        <Field label="数据用途"><select value={dataset} onChange={e => changeConfig('dataset', e.target.value)}><option value="controlled_test">受控测试</option><option value="field">现场观测</option></select></Field>
        <p>{currentConfig ? '带入当前设置，修改后保存即可；其余采集参数继续沿用。' : '默认使用 30 秒地址汇总、5 秒分箱、最多 64 个地址。BLE 可见标识不能当作人数。'}</p>
        <button className="cp-admin-button" onClick={saveConfig} disabled={places.loading || !!places.error}>保存配置</button>
        {configDirty ? <p role="status">有尚未保存的配置修改。</p> : configId && <p role="status">当前配置已准备好，仍可继续修改并保存。</p>}
      </fieldset>
      <fieldset disabled={mutation.pending || validating}><legend>4 · 设置 Wi-Fi</legend>
        <p>支持 2.4 GHz WPA2、开放网络和 PEAP/MSCHAPv2 企业认证。企业认证不校验服务器证书；云端 HTTPS 仍严格验证。网页登录 / Portal 需要另行处理。</p>
        {mode !== 'ap' ? <form onSubmit={e => { e.preventDefault(); transmit(); }}>
          <Field label="Wi-Fi 认证方式"><select value={wifiSecurity} disabled={validating} onChange={e => { setWifiSecurity(e.target.value); setPassword(''); setEapPassword(''); }}><option value="wpa2">WPA2 个人网络</option><option value="open">开放网络（无密码）</option><option value="enterprise">企业网络 · PEAP/MSCHAPv2（不校验证书）</option></select></Field><Field label="Wi-Fi SSID"><input value={ssid} onChange={e => setSsid(e.target.value)} required autoComplete="off" disabled={validating} /></Field>{wifiSecurity === 'enterprise' && <><Field label="企业认证用户名"><input value={eapUsername} onChange={e => setEapUsername(e.target.value)} required autoComplete="off" disabled={validating} /></Field><Field label="外层身份（可选）" hint="留空使用用户名。"><input value={eapIdentity} onChange={e => setEapIdentity(e.target.value)} autoComplete="off" disabled={validating} /></Field><Field label="企业认证密码"><input type="password" value={eapPassword} onChange={e => setEapPassword(e.target.value)} required autoComplete="new-password" disabled={validating} /></Field></>}{wifiSecurity === 'open' && <p>开放网络不发送 Wi-Fi 密码；设备凭据仍只在严格验证的 HTTPS 连接中使用。</p>}{wifiSecurity === 'wpa2' && <Field label="Wi-Fi 密码" hint={diagnosis.failed ? '修改密码后重试。设备凭证和已选云端配置继续保留。' : '仅经本机连接发往设备，不发送给云端 API。'}><input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" disabled={validating} /></Field>}
          <button type="submit" className="cp-admin-button cp-admin-primary" disabled={!!submitReason}>{diagnosis.failed ? '使用修正后的 Wi-Fi 重试' : mode === 'usb' ? '通过 USB 发送给设备' : '加密发送给设备'}</button>{validating && <p role="status">设备正在处理本次设置，请先查看下方阶段；尚未确认失败前不重复改写。</p>}
        </form> : <><button className="cp-admin-button cp-admin-primary" disabled={!!submitReason} onClick={prepareAp}>显示本地配网交接内容</button>{handoff && <Field label="复制到设备本地页面的交接内容" hint={credentialMode === 'saved' ? '仅请求设备使用内部已有凭证；本地页面还会核对节点和能力。' : '包含独立设备凭证；仅粘贴到现场设备页面。'}><textarea readOnly rows={5} value={handoff} autoComplete="off" spellCheck={false} onFocus={e => e.target.select()} /></Field>}<p>本地页面接收后热点会关闭以测试网络。恢复互联网后回到这里查看云端确认；热点消失不代表已联网。</p></>}
        {submitReason && <p role="status">{submitReason}</p>}
      </fieldset>
      {writeComplete && <button className="cp-admin-button" disabled={mutation.pending} onClick={restartNetwork}>重新配置网络</button>}
      {(submitted || localStatus?.state === 'failed' || debugAttached) && <section className={`cp-provision-result ${diagnosis.failed ? 'is-failed' : ''}`} aria-live="polite"><h3>5 · 设备验证与云端确认</h3>
        <div className="cp-provision-stage"><strong>{diagnosis.state}</strong>{diagnosis.stage && <span>最后报告阶段：{diagnosis.stage}</span>}</div>
        {bootChanged && <Notice>已观察到设备启动标识变化，说明设备发生过重启。当前等待状态不代表上次故障已解决；请查看历史记录与本次云端确认。</Notice>}
        {boot && <p>本次启动运行 {boot.uptime_ms == null ? '未知' : `${Math.floor(boot.uptime_ms / 1000)} 秒`}{boot.reset_reason == null ? '' : ` · 设备复位原因代码 ${boot.reset_reason}`}</p>}
        {previous && <details><summary>上一次设备记录（历史，不是本次结果）</summary><pre className="cp-provision-diagnostic">{JSON.stringify(previous, null, 2)}</pre></details>}
        {diagnosis.problem && <p><strong>{diagnosis.problem}</strong>。{diagnosis.advice}</p>}
        {diagnosis.failed && <p>本次候选未确认保存。可修正上方 Wi-Fi 后重试；不需要重新登记设备或重新发布相同配置。</p>}
        {disconnected && <Notice>本机连接已断开。设备可能正在验证或重启，这本身不能判断成功或失败。继续检查云端，或连接 USB 读取诊断。</Notice>}
        {localError && <p role="status">{localError}</p>}
        {lastDiagnostic && <details><summary>安全诊断详情</summary><pre className="cp-provision-diagnostic">{JSON.stringify(lastDiagnostic, null, 2)}</pre><small>这是最后一次收到的安全诊断，开始新尝试后保留至设备更新。仅含阶段、固定错误代码和数值，不包含网络名称、密码或设备凭证。</small></details>}
        <ol className="cp-provision-checks"><li>云端身份：{registered ? '沿用已登记节点' : '尚未确认'}</li><li>期望配置：{configId || '尚未选择'}</li><li>本次云端联系：{progress.contact ? '已收到' : '尚未收到'}</li><li>本次配置应用确认：{progress.applied ? '已收到当前配置新的 applied ACK' : '尚未收到新的 applied ACK，历史确认不计入本次'}</li></ol>
        <div className="cp-provision-actions"><button className="cp-admin-button" disabled={mutation.pending} onClick={() => mutation.run(async () => { setDetail(await api(`/devices/${node}`)); setCloudError(''); })}>检查云端状态</button>{(mode === 'usb' || debugAttached) && <button className="cp-admin-button" disabled={mutation.pending} onClick={() => mutation.run(readStatus)}>读取设备阶段与诊断</button>}</div>{cloudError && <p role="status">{cloudError}</p>}
        {writeComplete && <button className="cp-admin-button cp-admin-primary" onClick={() => { notify(progress.applied ? '设备已重新联系云端并确认应用配置。' : '本次配网已完成；最新采集配置的应用状态请在设备目录查看。'); close(); }}>完成并返回设备目录</button>}
      </section>}
      {usbAvailable && !(mode === 'usb' && client.current && !disconnected) && <section><h3>USB 排查</h3><p>只读模式不发送开始配网或配置命令。部分 USB 驱动打开串口时可能触发设备复位，RAM 中的旧故障可能丢失；不能用重启后的等待状态推断此前没有故障。连接同一台设备的数据线。</p><button className="cp-admin-button" disabled={mutation.pending} onClick={attachDiagnostics}>连接 USB 只读诊断</button>{debugAttached && <button className="cp-admin-button" disabled={mutation.pending} onClick={() => connect('usb', diagnosticPort.current)}>在同一 USB 设备上开始重配</button>}</section>}
      {message && <p role="status" className="cp-provision-status">{message}</p>}<ErrorNotice error={mutation.error} />
    </div>
  </Dialog>;
}
