import React from 'react';
import { Car, Elevator, Moped, PersonSimpleWalk } from '@phosphor-icons/react';
import './field-illustration.css';

const glyphs = { people: PersonSimpleWalk, bikes: Moped, cars: Car };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Diagram glyphs live inside a labelled card attached to a place anchor.
 * Their arrangement is typography, not map-space individual positions.
 */
export default function FieldIllustration({ illustration, point, width, height, compact = false, placeName }) {
  if (!illustration || !point || !Number.isFinite(point.left) || !Number.isFinite(point.top)
    || point.left < 0 || point.left > width || point.top < 0 || point.top > height) return null;
  const boxWidth = Math.min(270, Math.max(0, width - 16));
  const boxHeight = 55 + illustration.groups.length * 24 + (illustration.elevator ? 34 : 0) + (illustration.vehicle_status ? 19 : 0);
  const left = clamp(point.left - boxWidth / 2, 8, Math.max(8, width - boxWidth - 8));
  const top = clamp(compact ? 35 : point.top + 55, 8, Math.max(8, height - boxHeight - 23));
  return <div className="field-illustration" role="img" aria-label={`${placeName}，${illustration.replay ? '历史窗口' : '现场观测驱动'}活动示意，${illustration.figure_count} 个示意图形，非实际人数或车辆数，位置不代表个体定位`}
    data-source="field-observation-diagram" data-historical={String(illustration.replay)} data-figure-count={illustration.figure_count}
    style={{ left, top, width: boxWidth }}>
    <strong>{illustration.replay ? '历史窗口' : '现场观测驱动'} · 活动示意 <span>{illustration.figure_count ? `${illustration.figure_count} 个图形` : '观测状态'}</span></strong>
    {illustration.groups.map(group => {
      const Icon = glyphs[group.kind];
      return <div className={`field-illustration-group ${group.kind}`} key={group.kind} data-kind={group.kind} data-source={group.source} data-figure-count={group.figure_count} title={`${group.label}；证据时间 ${group.observed_at}`}>
        <span className="field-illustration-glyphs" aria-hidden="true">{Array.from({ length: group.figure_count }, (_, index) => <Icon key={index} size={19} weight="duotone" />)}</span>
        <small>{group.label}<span>绘制 {group.figure_count} 个示意图形</span></small>
      </div>;
    })}
    {illustration.vehicle_status && <p className="field-illustration-waiting" data-kind="vehicle-waiting">{illustration.vehicle_status}</p>}
    {illustration.elevator && <div className={`field-illustration-elevator ${illustration.elevator.status}`} data-kind="elevator" data-source={illustration.elevator.status}
      title={illustration.elevator.observed_at ? `证据时间 ${illustration.elevator.observed_at}` : undefined}>
      <Elevator size={20} aria-hidden="true" /><span>{illustration.elevator.label}<small>{illustration.elevator.note}</small></span>
    </div>}
    <p>非实际人数或车辆数 · 位置不代表个体定位</p>
  </div>;
}
