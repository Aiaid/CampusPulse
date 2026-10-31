import React, {useState} from 'react';
import { Empty, Field, Notice, Panel, Resource, fmtTime, useAdmin, useResource } from './shared.jsx';
export default function UploadedBatches({id}) {
 const {version}=useAdmin(),[generation,setGeneration]=useState(''),[limit,setLimit]=useState(20);
 const data=useResource(`/device-v3/nodes/${encodeURIComponent(id)}/evidence?limit=${limit}${generation?`&generation=${generation}`:''}`,version);
 return <Panel title="V3 上传与保管回执" description="只读统计回执、原始授权绑定和保留期；历史采集记录未删除。">
  <div className="cp-admin-form-grid"><Field label="筛选 assignment generation"><input type="number" min="1" step="1" value={generation} onChange={e=>setGeneration(/^[1-9][0-9]*$/.test(e.target.value)?e.target.value:'')}/></Field><Field label="每类记录上限"><select value={limit} onChange={e=>setLimit(Number(e.target.value))}><option value={20}>20</option><option value={50}>50</option></select></Field></div>
  <Resource resource={data}>{d=><>{d.batches.rows.length?<div className="cp-admin-table-scroll"><table><thead><tr><th>generation / 数据流</th><th>批次</th><th>服务端接收</th><th>保管状态</th><th>详情</th></tr></thead><tbody>{d.batches.rows.map(b=><tr key={b.batch_id}><td>{b.generation} / {b.stream}</td><td className="cp-admin-mono">{b.batch_id}</td><td>{fmtTime(b.receipt?.received_at)}</td><td>{b.receipt_tuple_match&&b.receipt_shape_valid?'已提交；绑定匹配':'回执证据异常'}</td><td><details><summary>查看回执</summary><pre className="cp-admin-json">{JSON.stringify(b,null,2)}</pre></details></td></tr>)}</tbody></table></div>:<Empty title="尚无 V3 统计回执">只显示服务端已提交记录，不推断设备本地待发内容。</Empty>}{d.batches.truncated&&<Notice>记录超过本次上限；按 generation 缩小范围。更早记录仍保留，列表不是完整导出。</Notice>}<Notice>此处展示 D1 回执与规范化记录；没有重新计算原始请求字节哈希。旧协议历史数据仅保留，不再作为当前设备状态。</Notice></>}</Resource>
 </Panel>;
}
