const requestErrors = {
  usb_timeout: 'USB 请求超时；请先读取设备状态，勿直接重复提交凭证。',
  saved_credential_unavailable: '设备当前没有可复用的已保存凭证，请提供已保存凭证或明确选择轮换。',
  setup_expired: '本次配网会话已过期，请重新连接同一设备；云端凭证仍保留。',
  setup_locked: '本次配网会话已锁定，请通过 USB 重新连接同一台设备并开始新会话。',
  setup_not_ready: '设备尚未处于可写入的配网状态，可能正在验证或重启。请先读取状态。',
  invalid_session_nonce: '设备配网会话已变化，请重新连接同一设备再试。',
  supervisor_busy: '设备正在执行另一项任务，请先读取状态再试。',
  attempt_payload_changed: '同一次提交的内容发生变化。请先确认原尝试失败，再开始修正后的尝试。',
};
export class ProvisioningError extends Error { constructor(reason) { super(requestErrors[reason] ? `${requestErrors[reason]}（${reason}）` : reason); this.code = reason; } }
export function checkedReply(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.v !== 1 || typeof data.ok !== 'boolean') throw new Error('设备响应格式无效。');
  if (!data.ok) throw new ProvisioningError(typeof data.reason === 'string' && /^[a-z_]{1,64}$/.test(data.reason) ? data.reason : 'device_rejected');
  return data;
}
