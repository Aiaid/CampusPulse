import React from 'react';
import { Car, Elevator, Moped, PersonSimpleWalk } from '@phosphor-icons/react';
import './field-illustration.css';

const glyphs = { people: PersonSimpleWalk, bikes: Moped, cars: Car };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const observedTime = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function EvidenceTime({ evidence, replay, failed }) {
  if (!evidence.observed_at) return null;
  return <span className="field-illustration-evidence">最后观测 <time dateTime={evidence.observed_at}>{observedTime(evidence.observed_at)}</time>
    {replay ? '' : evidence.stale ? ' · 已过期' : evidence.last_known === 'source_unavailable' ? ' · 源暂不可用' : evidence.last_known || failed ? ' · 待更新' : ''}
  </span>;
}

/** Diagram glyphs live inside a labelled card attached to a place anchor.
 * Their arrangement is typography, not map-space individual positions.
 */
export default function FieldIllustration({ illustration, point, width, height, compact = false, placeName }) {
  if (!illustration || !point || !Number.isFinite(point.left) || !Number.isFinite(point.top)
    || point.left < 0 || point.left > width || point.top < 0 || point.top > height) return null;
  const boxWidth = Math.min(300, Math.max(0, width - 16));
  const boxHeight = 30 + illustration.groups.length * 44 + (illustration.elevator ? 45 : 0) + (illustration.vehicle_status ? 19 : 0) + (illustration.update_failed ? 20 : 0);
  const left = clamp(point.left - boxWidth / 2, 8, Math.max(8, width - boxWidth - 8));
  const top = clamp(compact ? 8 : point.top + 55, 8, Math.max(8, height - boxHeight - 8));
  return <div className="field-illustration" role="img" aria-label={`${placeName}，${illustration.replay ? '历史窗口' : '现场观测驱动'}活动示意，${illustration.figure_count} 个示意图形，非实际人数或车辆数，位置不代表个体定位；${illustration.groups.map(group => `${group.quantity}，${group.description || group.label}`).join('；')}`}
    data-source="field-observation-diagram" data-historical={String(illustration.replay)} data-figure-count={illustration.figure_count} data-update-failed={String(Boolean(illustration.update_failed))}
    style={{ left, top, width: boxWidth, maxHeight: Math.max(0, height - top - 8) }}
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <strong>{illustration.replay ? '历史观测' : '现场观测'}</strong>
    {illustration.update_failed && <p className="field-illustration-update-failed" role="status">更新失败</p>}
    {illustration.groups.map(group => {
      const Icon = glyphs[group.kind], retained = group.stale || group.last_known || illustration.update_failed;
      return <div className={`field-illustration-group ${group.kind}${retained ? ' retained' : ''}`} key={group.kind} data-kind={group.kind} data-source={group.source} data-figure-count={group.figure_count} data-stale={String(Boolean(group.stale))} data-last-known={String(Boolean(group.last_known))} title={`${group.quantity}；证据时间 ${group.observed_at}`}>
        <span className="field-illustration-glyphs" aria-hidden="true">{Array.from({ length: group.figure_count }, (_, index) => <Icon key={index} size={18} weight="duotone" />)}</span>
        <span className="field-illustration-value"><strong className="field-illustration-quantity">{group.quantity}</strong>{group.saturated && <small>已达上限</small>}</span>
        <EvidenceTime evidence={group} replay={illustration.replay} failed={illustration.update_failed} />
      </div>;
    })}
    {illustration.vehicle_status && <p className="field-illustration-waiting" data-kind="vehicle-waiting">{illustration.replay ? '车辆无记录' : '车辆待观测'}</p>}
    {illustration.elevator && <div className={`field-illustration-elevator ${illustration.elevator.status}${illustration.elevator.stale || illustration.elevator.last_known || illustration.update_failed ? ' retained' : ''}`} data-kind="elevator" data-source={illustration.elevator.status} data-stale={String(Boolean(illustration.elevator.stale))}
      title={illustration.elevator.observed_at ? `证据时间 ${illustration.elevator.observed_at}` : undefined}>
      <Elevator size={20} aria-hidden="true" /><strong className="field-illustration-quantity">{illustration.elevator.status === 'waiting' ? '候梯待观测' : illustration.elevator.quantity}</strong>
      <EvidenceTime evidence={illustration.elevator} replay={illustration.replay} failed={illustration.update_failed} />
    </div>}
  </div>;
}
