import React from 'react';
import { observationKindLabels } from '../shared/observation-kinds.js';
import { allWorkPurposes } from './work-purposes.js';

export default function WorkPurposes({ value, onChange, allowed = allWorkPurposes, disabled = false, title = '工作用途（可多选）' }) {
  const unavailable = value.filter(kind => !allowed.includes(kind));
  return <fieldset className="cp-admin-fieldset cp-admin-work-purposes" disabled={disabled}><legend>{title}</legend><div className="cp-admin-purpose-options">{[...allowed, ...unavailable].map(kind => <label key={kind} className="cp-admin-checkbox"><input type="checkbox" checked={value.includes(kind)} onChange={e => onChange(e.target.checked ? [...value, kind] : value.filter(item => item !== kind))} />{observationKindLabels[kind]}{!allowed.includes(kind) && '（此地点已不支持，请取消）'}</label>)}</div>{!value.length && <p role="alert">请至少选择一种工作用途。</p>}{!!unavailable.length && <p role="alert">地点支持范围已变化，请取消不再支持的用途后保存；历史部署仍保留原用途。</p>}<p className="cp-admin-muted">用途决定观测归属；BLE 扫描和原始报告参数单独配置。电动车自动识别与电梯等待推断尚未实现。</p></fieldset>;
}
