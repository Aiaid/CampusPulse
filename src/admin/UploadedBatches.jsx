import React, { useState } from 'react';
import HelpTip from './HelpTip.jsx';
import { Dialog, Empty, Field, KeyValues, Notice, Panel, Resource, fmtBytes, fmtNumber, fmtTime, useAdmin, useResource } from './shared.jsx';
import { exactLabels, streamLabels } from './device-diagnostics.js';

const datasetLabels = { field: '现场观测', demo: '演示数据', controlled_test: '受控测试' };
export default function UploadedBatches({ id }) {
  const { version } = useAdmin();
  const [stream, setStream] = useState('');
  const [cursors, setCursors] = useState([]);
  const [selected, setSelected] = useState(null);
  const params = new URLSearchParams({ limit: '20', ...(stream ? { stream } : {}), ...(cursors.length ? { before: cursors.at(-1) } : {}) });
  const resource = useResource(`/devices/${encodeURIComponent(id)}/batches?${params}`, version);
  return <Panel title="服务器已接收的上传批次" description="只展示持久化回执。选择单个批次查看条目或校验原始请求；记录可能来自旧启动或旧配置。" action={<Field label="筛选上传流"><select value={stream} onChange={e => { setStream(e.target.value); setCursors([]); }}><option value="">全部上传流</option>{Object.entries(streamLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>}>
    <Resource resource={resource}>{data => <>{data.batches.length ? <div className="cp-admin-table-scroll"><table><thead><tr><th><span>流 / 数据集</span><HelpTip topic="device.batchStream" label="流 / 数据集说明" /></th><th><span>服务端接收</span><HelpTip topic="device.batchReceived" label="服务端接收说明" /></th><th><span>启动 / 配置</span><HelpTip topic="device.batchIdentity" label="启动 / 配置说明" /></th><th><span>序号 / 条目</span><HelpTip topic="device.batchSequence" label="序号 / 条目说明" /></th><th><span>请求原文</span><HelpTip topic="device.batchExact" label="请求原文说明" /></th><th>查看</th></tr></thead><tbody>{data.batches.map(batch => <tr key={batch.batch_id}><td><strong>{streamLabels[batch.stream]}</strong><small className="cp-diagnostic-subtle">{batch.protocol} · {datasetLabels[batch.dataset] || batch.dataset}</small></td><td>{fmtTime(batch.received_at)}<small className="cp-diagnostic-subtle">云端已持久化</small></td><td className="cp-diagnostic-identities"><code title={batch.boot_id}>{batch.boot_id}</code><small>{batch.capture_config_id}</small></td><td>{batch.seq_first}–{batch.seq_last}<small className="cp-diagnostic-subtle">{batch.accepted_count} 条</small></td><td><span>{exactLabels[batch.exact_payload_status]}</span><HelpTip topic={`device.exact.${batch.exact_payload_status}`} label="此批次请求原文状态说明" /></td><td><button className="cp-admin-button cp-admin-small" onClick={() => setSelected(batch.batch_id)} aria-label={`查看批次 ${batch.batch_id}`}>查看内容</button></td></tr>)}</tbody></table></div> : <Empty title={stream === 'ble_reports' ? '此页没有已接收的原始广播批次' : '此页没有已接收批次'}>原始采集关闭时不会产生新的广播内容上传；窗口和地址汇总请分别查看。超过保留期的历史回执也可能已清理。</Empty>}<div className="cp-diagnostic-pagination"><button className="cp-admin-button cp-admin-small" disabled={!cursors.length} onClick={() => setCursors(v => v.slice(0, -1))}>上一页</button><span>第 {cursors.length + 1} 页 · 每页最多 20 批</span><button className="cp-admin-button cp-admin-small" disabled={!data.next_cursor} onClick={() => setCursors(v => [...v, data.next_cursor])}>下一页</button></div></>}</Resource>
    <Notice>地址汇总和广播内容可能含 BLE 标识符，仅限本管理员会话查看，不代表人数。数据库投影不是网络请求原文。页面不显示 Wi-Fi、企业认证或设备凭证。</Notice>
    {selected && <BatchContent id={id} batchId={selected} onClose={() => setSelected(null)} />}
  </Panel>;
}
function BatchContent({ id, batchId, onClose }) {
  const { version } = useAdmin();
  const resource = useResource(`/devices/${encodeURIComponent(id)}/batches/${batchId}`, version);
  return <Dialog title="上传批次内容" wide onClose={onClose}><Resource resource={resource}>{({ batch, projection, exact }) => <>
    <KeyValues entries={[
      ['批次 ID', batch.batch_id], ['协议 / 上传流', `${batch.protocol} / ${streamLabels[batch.stream]}`], ['数据集', datasetLabels[batch.dataset] || batch.dataset, 'device.batchDataset'],
      ['服务端接收时间', fmtTime(batch.received_at)], ['设备测量起 / 止', `${fmtTime(projection.measured_first_ms)} / ${fmtTime(projection.measured_last_ms)}`],
      ['启动标识', batch.boot_id], ['配置 / 部署', `${batch.capture_config_id} / ${batch.placement_id}`], ['固件声明', batch.firmware_version],
      ['接受序号范围', `${batch.seq_first}–${batch.seq_last}`], ['云端接受条数', fmtNumber(batch.accepted_count)], ['持久化回执 ID', batch.receipt_id],
      ['请求体 SHA-256', batch.body_sha256], ['内容保留至', fmtTime(batch.expires_at_ms)], ['原始请求字节数', exact.size_bytes == null ? '未记录 / 不可用' : fmtBytes(exact.size_bytes)],
    ]} />
    <Notice>该回执已在云端提交。序号范围内可能有主动采样跳过，不能据此认定丢失。设备是否收到 ACK、哪些待确认项尚未上传，也不能由这份回执单独确定。</Notice>
    <h3 aria-label="数据库保存的条目"><span>数据库保存的条目</span><HelpTip topic="device.projection" label="数据库保存的条目说明" /></h3><p>{projection.status === 'expired' ? '内容已过期，保留回执不代表保留载荷。' : projection.status === 'not_stored' ? '此协议的原始流未保存 D1 条目。' : `${projection.items.length} 条可读投影 / ${batch.accepted_count} 条已接收。`}{projection.content === 'sequence_bookkeeping_only' ? ' 原始流在 D1 只保存序号与窗口关联，广播内容在私有归档。' : ' 以下是经过校验和规范化的 D1 内容，不保留原请求空白或数字拼写。'}</p>
    {projection.items.length > 0 && <pre className="cp-diagnostic-json" tabIndex={0} aria-label="数据库投影内容">{JSON.stringify(projection.items, null, 2)}</pre>}
    <h3 aria-label="原始上传请求"><span>原始上传请求</span><HelpTip topic="device.exact" label="原始上传请求说明" /></h3><p role="status"><span>{exactLabels[exact.status] || exact.status}</span><HelpTip topic={`device.exact.${exact.status}`} label="原始请求读取与校验状态说明" /></p>
    {exact.status === 'verified' && <><p>逐字节 SHA-256 已与回执一致。以下文本直接解码自保存的 UTF-8 请求体，未重新序列化。</p><pre className="cp-diagnostic-json" tabIndex={0} aria-label="已校验的原始请求">{exact.utf8_text}</pre></>}
    {exact.status === 'not_archived' && <Notice>此上传流没有保存完整请求体。上面的数据库条目可以查看，但不能还原或声称为原始上传字节。</Notice>}
  </>}</Resource></Dialog>;
}
