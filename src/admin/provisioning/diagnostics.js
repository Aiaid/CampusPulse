// Device diagnostics are a deliberately small allowlist, suitable for copying
// into a support report. Never copy the complete local response or candidate.
export const STAGES = {
  idle: '空闲', handoff: '切换到网络验证', queued: '设备已接收', wifi_connect: '连接 Wi-Fi', wifi_association: '连接 Wi-Fi',
  dhcp: '获取网络地址', clock: '同步设备时间', dns: '解析云端地址', tls: '建立加密连接',
  cloud_auth: '验证云端设备身份', http: '请求云端服务', save: '保存设置', saved: '设置已保存', ready: '验证完成',
};
const CODES = {
  wifi_auth_failed: ['Wi-Fi 认证失败', '重新输入 Wi-Fi 密码，并确认热点使用 WPA2 个人模式。'],
  wifi_connect_failed: ['Wi-Fi 连接失败', '确认 2.4 GHz WPA2 个人网络可见、信号稳定，再修正网络信息重试。'],
  wifi_timeout: ['连接 Wi-Fi 超时', '确认热点已开启且信号稳定；企业网、PEAP 和网页登录网络不受支持。'],
  dhcp_timeout: ['获取网络地址超时', '检查路由器 DHCP、连接数限制，或用另一个已验证的个人热点重试。'],
  clock_timeout: ['设备时间同步超时', '网络已连接也可能无法访问校时服务。检查网络是否限制 NTP，或换用个人热点。'],
  dns_failed: ['云端域名解析失败', '检查网络 DNS 和互联网可达性，或换用个人热点。'],
  tls_failed: ['加密连接失败', '检查设备时间、固件证书和网络拦截情况；保存下方安全诊断供排查。'],
  cloud_auth_failed: ['云端拒绝设备身份', '检查云端设备是否启用、是否曾轮换凭证；先核对凭证来源，不要因网络错误直接轮换。'],
  http_failed: ['云端请求失败', '查看 HTTP 状态码，检查服务可达性；本次候选设置尚未确认保存。'],
  save_failed: ['设备保存设置失败', '保留当前向导与凭证，记录安全诊断；不要清空设备或重复轮换凭证。'],
  validation_timeout: ['设备验证超时', '根据最后完成阶段排查网络；仅收到设备明确失败后再修正设置重试。'],
  setup_expired: ['配网会话已过期', '重新进入配网并连接同一台设备；本向导保留已有云端凭证。'],
  setup_locked: ['配网会话已锁定', '在设备上显式开始新的配网会话，再输入新的配网码。'],
};
Object.assign(CODES, {
  idle: ['空闲', ''], queued: ['已排队', ''], wifi_connecting: ['正在连接 Wi-Fi', ''], dhcp_wait: ['等待网络地址', ''], clock_sync: ['正在同步时间', ''], dns_resolving: ['正在解析域名', ''], tls_connecting: ['正在建立加密连接', ''], cloud_checking: ['正在检查云端身份', ''], network_validated: ['网络验证通过', ''], saving: ['正在保存设置', ''], saved: ['设置已保存', ''],
  handoff_failed: ['切换网络验证失败', '保留安全诊断，确认设备完成启动后重新进入配网。'],
  network_event_loss: ['网络事件记录不完整', '设备网络事件队列发生丢失，不能仅凭缺少事件判断 DHCP 失败。保留诊断后重试。'],
  resource_exhausted: ['设备内存不足', '本次内存分配失败，保留错误码与堆余量供排查；无需清空设置或更换设备凭证。'],
  network_start_failed: ['网络驱动启动失败', '保留安全诊断供排查；不要清空设备或轮换云端凭证。'],
  wifi_not_found: ['未发现目标 Wi-Fi', '确认 2.4 GHz 热点已开启、SSID 拼写正确且信号覆盖设备。'],
  clock_failed: ['设备校时失败', '检查网络是否允许校时，或换用个人热点后重试。'],
  dns_timeout: ['域名解析超时', '检查 DNS 和互联网可达性，或换用个人热点后重试。'],
  tls_certificate_failed: ['云端证书验证失败', '检查固件证书、设备时间与网络拦截情况；不要关闭证书验证。'],
  tls_timeout: ['加密连接超时', '检查网络是否可访问云端地址，并保存 TLS 数值诊断。'],
  invalid_cloud_reply: ['云端响应格式无效', '检查固件与服务端协议版本，保留安全诊断。'],
  cloud_timeout: ['云端验证超时', '检查互联网和服务可达性；网络超时不代表设备凭证错误。'],
  network_stop_failed: ['网络停止失败', '保留安全诊断，确认设备状态后再开始新配网。'],
  validation_interrupted: ['上次验证被中断', '可能发生复位或断电。查询云端与历史诊断后，再决定是否重新提交。'],
});
const progressCodes = new Set(['idle', 'queued', 'wifi_connecting', 'dhcp_wait', 'clock_sync', 'dns_resolving', 'tls_connecting', 'cloud_checking', 'network_validated', 'saving', 'saved']);
const ATTEMPT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A reboot moves the completed attempt into retained diagnostics. Only an exact
// match can confirm this write; the presence of any old credential cannot.
export function networkSettingsSaved(status, attemptId) {
  if (typeof attemptId !== 'string' || !ATTEMPT_PATTERN.test(attemptId) || status?.has_saved_credential !== true) return false;
  const saved = result => result?.attempt_id === attemptId && result.state === 'saved' && result.diagnostic?.code === 'saved';
  return saved(status) || saved(status?.previous_attempt);
}
export function safeDiagnostic(status) {
  const source = status?.diagnostic; if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const result = {};
  if (Object.hasOwn(STAGES, source.stage)) result.stage = source.stage;
  if (Object.hasOwn(CODES, source.code)) result.code = source.code;
  for (const [key, [minimum, maximum]] of Object.entries({ esp_err: [-2147483648, 0xffffffff], http_status: [0, 599], wifi_reason: [0, 0xffff], tls_code: [-2147483648, 2147483647], tls_flags: [0, 0xffffffff], elapsed_ms: [0, 86400000] })) {
    const value = source[key]; if (Number.isInteger(value) && value >= minimum && value <= maximum) result[key] = value;
  }
  if (typeof source.retryable === 'boolean') result.retryable = source.retryable;
  return Object.keys(result).length ? result : null;
}
export function diagnosticView(status) {
  const diagnostic = safeDiagnostic(status);
  const failed = status?.state === 'failed' || status?.state === 'stop_failed';
  const knownReason = Object.hasOwn(CODES, status?.reason) ? status.reason : null;
  const code = diagnostic?.code || knownReason;
  const stateLabels = { sending: '正在发送，等待设备确认', waiting: '等待填写网络', received: '候选设置已接收', testing: '设备正在验证', saved: '设置已保存，等待重启和云端确认', failed: '本次验证失败', stop_failed: '设备暂停配网，需要排查', expired: '配网会话已过期', locked: '配网会话已锁定' };
  return {
    diagnostic, failed, state: status?.state === 'idle'
      ? status.has_saved_credential === true ? '设备已退出配网，已有保存设置' : '设备已退出配网'
      : stateLabels[status?.state] || '尚未取得本次设备状态',
    stage: diagnostic?.stage ? STAGES[diagnostic.stage] : null,
    problem: code && !progressCodes.has(code) ? CODES[code][0] : failed ? '设备报告失败，但未提供可识别的阶段诊断' : null,
    advice: code && !progressCodes.has(code) ? CODES[code][1] : failed ? '旧的已保存设置保留。先读取 USB 安全诊断，再修正 Wi-Fi 信息并重试。' : null,
  };
}

export function previousDiagnostic(status) {
  const previous = status?.previous_attempt;
  if (!previous || !['failed', 'saved', 'interrupted'].includes(previous.state)) return null;
  const diagnostic = safeDiagnostic(previous);
  return diagnostic ? { state: previous.state, diagnostic } : null;
}
export function bootEvidence(status) {
  if (!status || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(status.boot_id)) return null;
  return { boot_id: status.boot_id,
    ...(Number.isSafeInteger(status.uptime_ms) && status.uptime_ms >= 0 ? { uptime_ms: status.uptime_ms } : {}),
    ...(Number.isInteger(status.reset_reason) && status.reset_reason >= 0 && status.reset_reason < 256 ? { reset_reason: status.reset_reason } : {}) };
}
