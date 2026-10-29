import React from 'react';
import { observationKindLabels } from '../shared/observation-kinds.js';
import { allWorkPurposes } from './work-purposes.js';
import HelpTip from './HelpTip.jsx';

export default function WorkPurposes({ value, onChange, allowed = allWorkPurposes, disabled = false, title = '工作用途（可多选）' }) {
  const unavailable = value.filter(kind => !allowed.includes(kind));
  return <fieldset className="cp-admin-fieldset cp-admin-work-purposes" disabled={disabled} aria-label={title}><legend><span>{title}</span><HelpTip topic="工作用途" label="了解工作用途和生效范围" /></legend><div className="cp-admin-purpose-options">{[...allowed, ...unavailable].map(kind => <div key={kind}><label className="cp-admin-checkbox"><input type="checkbox" checked={value.includes(kind)} onChange={e => onChange(e.target.checked ? [...value, kind] : value.filter(item => item !== kind))} />{observationKindLabels[kind]}{!allowed.includes(kind) && '（此地点已不支持，请取消）'}</label><HelpTip topic={observationKindLabels[kind]} label={`了解${observationKindLabels[kind]}的含义与证据边界`} /></div>)}</div>{!value.length && <p role="alert">请至少选择一种工作用途。</p>}{!!unavailable.length && <p role="alert">地点支持范围已变化，请取消不再支持的用途后保存；历史部署仍保留原用途。</p>}<p className="cp-admin-muted">用途决定观测归属；BLE 扫描和原始报告参数单独配置。电动车已有未校准的 BLE 候选结果；电梯提供历史人工等待参考。两者不能视为准确车辆、人数计数或实时等待预测。</p></fieldset>;
}
