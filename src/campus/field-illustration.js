import { latestManualObservations, recordFreshness } from './field-data.js';
import { recordsAtTime } from './field-timeline.js';
import { observationKinds } from '../shared/observation-kinds.js';

const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const sensorUsable = record => record?.source === 'sensor' && record.dataset === 'field'
  && count(record.visible_identifiers) && record.visible_identifiers > 0
  && Number.isFinite(record.duration_ms) && record.duration_ms > 0
  && Number.isFinite(record.scan_enabled_ms) && record.scan_enabled_ms > 0
  && record.scan_enabled_ms <= record.duration_ms && validTime(record.observed_at) && validTime(record.valid_until)
  && Date.parse(record.valid_until) > Date.parse(record.observed_at);
const parkingUsable = record => record?.source === 'manual' && record.status === 'active' && record.kind === 'parking'
  && (record.dataset === undefined || record.dataset === 'field') && count(record.parking_min)
  && count(record.parking_max) && record.parking_min > 0 && record.parking_max >= record.parking_min;
const waitSeconds = value => Number.isFinite(value) && value >= 0 && value <= 7200;
const manualWaitUsable = record => record?.source === 'manual' && record.status === 'active' && record.kind === 'elevator'
  && (record.dataset === undefined || record.dataset === 'field') && count(record.wait_seconds) && waitSeconds(record.wait_seconds);

/** A place-level diagram, not inferred identities, positions or calibrated flow.
 * Bands only choose a small fixed drawing budget: 1 BLE ID never means 1 person.
 * Automatic vehicle evidence has no retained replay representation.
 */
export function fieldIllustration({ mode = 'field', live, history, cursor, now, enabled = true, layers = {}, place } = {}) {
  if (!enabled || !['field', 'replay'].includes(mode) || !Number.isFinite(now)) return null;
  const replay = mode === 'replay', state = replay ? history : live;
  if (!state?.data || state.error || (replay && !Number.isFinite(cursor))) return null;
  const captured = replay ? recordsAtTime(state.data.records, cursor) : null;
  const sensor = replay ? captured.sensors[0] : state.data.sensor;
  const parking = replay ? captured.manual.find(record => record.kind === 'parking') : latestManualObservations(state.data).parking;
  const manualWait = replay ? captured.manual.find(record => record.kind === 'elevator') : latestManualObservations(state.data).elevator;
  const purposes = observationKinds(place || state.data.place);
  const groups = [];
  let vehicle_status = null, elevator = null;
  if (layers.people !== false && sensorUsable(sensor) && (replay || recordFreshness(sensor, now) === 'fresh')) {
    const band = sensor.visible_identifiers < 20 ? 1 : sensor.visible_identifiers < 100 ? 2 : 3;
    groups.push({ kind: 'people', figure_count: [3, 5, 7][band - 1], band, source: 'sensor',
      label: `广播活动量级示意 ${band} 档`, observed_at: sensor.observed_at });
  }
  if (layers.bikes !== false) {
    if (parkingUsable(parking) && (replay || recordFreshness(parking, now) === 'fresh')) {
      groups.push({ kind: 'bikes', figure_count: 2, source: 'manual', label: `人工停车观察 ${parking.parking_min}–${parking.parking_max} 辆`, observed_at: parking.observed_at });
    }
    const vehicles = replay ? null : state.data.automatic_observations?.vehicles;
    let usableVehicles = false;
    if (vehicles?.status === 'candidate_estimate' && vehicles.source === 'ble_rule_inference'
      && ['compact', 'raw'].includes(vehicles.evidence_kind) && count(vehicles.sample_count) && vehicles.sample_count > 0
      && count(vehicles.candidate_count) && count(vehicles.car_related_count) && count(vehicles.ecosystem_count)
      && recordFreshness(vehicles, now) === 'fresh') {
      usableVehicles = true;
      if (vehicles.candidate_count > 0 && !groups.some(group => group.kind === 'bikes')) groups.push({ kind: 'bikes', figure_count: 2, source: 'candidate', label: '电动车相关广播 · 识别候选', observed_at: vehicles.observed_at });
      if (vehicles.car_related_count > 0) groups.push({ kind: 'cars', figure_count: 2, source: 'candidate', label: '汽车相关广播 · 识别候选', observed_at: vehicles.observed_at });
    }
    if (purposes.includes('parking') && !groups.some(group => group.kind === 'bikes')) {
      vehicle_status = usableVehicles && vehicles.candidate_count === 0 ? '未识别到电动车候选 · 非无车结论' : replay ? '所选时刻车辆待观测' : '车辆待观测 · 等待有效人工或识别证据';
    }
  }
  if (layers.waits !== false && purposes.includes('elevator')) {
    if (manualWaitUsable(manualWait) && (replay || recordFreshness(manualWait, now) === 'fresh')) {
      elevator = { status: 'manual', wait_seconds: manualWait.wait_seconds, observed_at: manualWait.observed_at,
        label: `已完成候梯 ${manualWait.wait_seconds} 秒 · 人工`, note: '已完成的单次实测，不是当前预测' };
    } else {
      const reference = replay ? null : state.data.automatic_observations?.elevator;
      if (reference?.status === 'historical_estimate' && reference.source === 'manual_historical_baseline' && reference.calibrated === false
        && waitSeconds(reference.wait_seconds) && count(reference.sample_count) && reference.sample_count > 0
        && count(reference.day_count) && reference.day_count > 0 && recordFreshness(reference, now) === 'fresh') {
        const seconds = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(reference.wait_seconds);
        elevator = { status: 'historical', wait_seconds: reference.wait_seconds, observed_at: reference.observed_at,
          label: `候梯参考约 ${seconds} 秒 · 历史样本`, note: '历史已完成样本参考，不是当前等待预测' };
      } else elevator = { status: 'waiting', label: replay ? '所选时刻候梯待观测' : '候梯样本不足 / 待观测', note: '暂无有效参考，缺失不表示零秒' };
    }
  }
  return groups.length || elevator || vehicle_status ? { replay, groups, elevator, vehicle_status,
    figure_count: groups.reduce((sum, group) => sum + group.figure_count, 0) } : null;
}
