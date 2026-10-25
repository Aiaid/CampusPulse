import { displayFieldSensor, isLastReportedSensor, latestManualObservations, recordFreshness } from './field-data.js';
import { recordsAtTime } from './field-timeline.js';
import { observationKinds } from '../shared/observation-kinds.js';

const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const interval = record => validTime(record?.observed_at) && validTime(record.valid_until)
  && Date.parse(record.valid_until) > Date.parse(record.observed_at);
const sensorUsable = record => record?.source === 'sensor' && record.dataset === 'field'
  && count(record.visible_identifiers) && Number.isFinite(record.duration_ms) && record.duration_ms > 0
  && Number.isFinite(record.scan_enabled_ms) && record.scan_enabled_ms > 0
  && record.scan_enabled_ms <= record.duration_ms && interval(record);
const parkingUsable = record => record?.source === 'manual' && record.status === 'active' && record.kind === 'parking'
  && (record.dataset === undefined || record.dataset === 'field') && count(record.parking_min)
  && count(record.parking_max) && record.parking_max >= record.parking_min && interval(record);
const waitSeconds = value => Number.isFinite(value) && value >= 0 && value <= 7200;
const manualWaitUsable = record => record?.source === 'manual' && record.status === 'active' && record.kind === 'elevator'
  && (record.dataset === undefined || record.dataset === 'field') && count(record.wait_seconds) && waitSeconds(record.wait_seconds) && interval(record);
const vehiclesUsable = record => record?.status === 'candidate_estimate' && record.source === 'ble_rule_inference'
  && ['compact', 'raw'].includes(record.evidence_kind) && count(record.sample_count) && record.sample_count > 0
  && count(record.candidate_count) && count(record.car_related_count) && count(record.ecosystem_count) && interval(record);
const referenceUsable = record => record?.status === 'historical_estimate' && record.source === 'manual_historical_baseline'
  && record.calibrated === false && waitSeconds(record.wait_seconds) && count(record.sample_count) && record.sample_count > 0
  && count(record.day_count) && record.day_count > 0 && interval(record);

/** A place-level diagram, not inferred identities, positions or calibrated flow.
 * Bands choose a fixed drawing budget, never a conversion of BLE IDs to people.
 * Last observations retain their original expiry. Replay only uses captured coverage.
 */
export function fieldIllustration({ mode = 'field', live, history, cursor, now, enabled = true, layers = {}, place } = {}) {
  if (!enabled || !['field', 'replay'].includes(mode) || !Number.isFinite(now)) return null;
  const replay = mode === 'replay', state = replay ? history : live;
  if (!state?.data || (replay && (state.error || !Number.isFinite(cursor)))) return null;
  const captured = replay ? recordsAtTime(state.data.records, cursor) : null;
  const sensor = replay ? captured.sensors[0] : displayFieldSensor(state.data);
  const reported = !replay && isLastReportedSensor(sensor);
  const usableSensor = reported ? Date.parse(sensor.received_at) <= now && sensor.scan_enabled_ms > 0 : sensorUsable(sensor)
    && (replay || Date.parse(sensor.observed_at) <= now);
  const manual = replay ? null : latestManualObservations(state.data);
  const parking = replay ? captured.manual.find(record => record.kind === 'parking') : manual.parking;
  const manualWait = replay ? captured.manual.find(record => record.kind === 'elevator') : manual.elevator;
  const vehicles = replay ? null : state.data.automatic_observations?.vehicles;
  const reference = replay ? null : state.data.automatic_observations?.elevator;
  const usable = (record, validate) => validate(record) && (replay || Date.parse(record.observed_at) <= now);
  const evidence = (record, key) => ({ observed_at: record.observed_at, valid_until: record.valid_until,
    ...(isLastReportedSensor(record) ? { received_at: record.received_at, time_status: record.time_status, unverified: true } : {}),
    stale: !replay && recordFreshness(record, now) !== 'fresh', last_known: !replay ? state.data.last_known?.[key] : undefined });
  const fresh = (record, key) => recordFreshness(record, now) === 'fresh' && !state.data.last_known?.[key];
  const purposes = observationKinds(place || state.data.place), groups = [];
  let vehicle_status = null, elevator = null;
  if (layers.people !== false && usableSensor) {
    const saturated = sensor.unique_table_overflow === true
      || (count(sensor.max_addresses) && sensor.max_addresses > 0 && sensor.visible_identifiers >= sensor.max_addresses);
    const band = saturated ? null : sensor.visible_identifiers < 20 ? 1 : sensor.visible_identifiers < 100 ? 2 : 3;
    groups.push({ kind: 'people', figure_count: sensor.visible_identifiers === 0 ? 0 : saturated ? 5 : [3, 5, 7][band - 1], band, source: 'sensor', saturated,
      quantity: `${sensor.visible_identifiers} 个 BLE 标识`,
      description: saturated ? '已达采集上限 · 人数未知' : `广播活动量级示意 ${band} 档 · 人数未知`,
      label: `${sensor.visible_identifiers} 个 BLE 标识 · ${saturated ? '已达采集上限 · 人数未知' : `广播活动量级示意 ${band} 档 · 人数未知`}`,
      ...evidence(sensor, reported ? 'last_reported_sensor' : 'sensor') });
  }
  if (layers.bikes !== false) {
    const hasParking = usable(parking, parkingUsable), hasVehicles = usable(vehicles, vehiclesUsable);
    // A fresh source beats retained/expired evidence; prefer direct manual evidence
    // only within that freshness tier. Explicit zero remains a valid replacement.
    const useParking = hasParking && (!hasVehicles || replay || fresh(parking, 'parking') || !fresh(vehicles, 'vehicles'));
    if (useParking) groups.push({ kind: 'bikes', figure_count: parking.parking_min > 0 ? 2 : 0, source: 'manual',
      quantity: `${parking.parking_min}–${parking.parking_max} 辆 · 人工`, description: '人工停车观察',
      label: `人工停车观察 ${parking.parking_min}–${parking.parking_max} 辆`, ...evidence(parking, 'parking') });
    if (hasVehicles) {
      if (!useParking && vehicles.candidate_count > 0) groups.push({ kind: 'bikes', figure_count: 2, source: 'candidate',
        quantity: `${vehicles.candidate_count} 个候选标识`,
        label: '电动车相关广播 · 识别候选', ...evidence(vehicles, 'vehicles') });
      if (vehicles.car_related_count > 0) groups.push({ kind: 'cars', figure_count: 2, source: 'candidate',
        quantity: `${vehicles.car_related_count} 个候选标识`,
        label: '汽车相关广播 · 识别候选', ...evidence(vehicles, 'vehicles') });
      if (!useParking && vehicles.candidate_count === 0) groups.push({ kind: 'bikes', figure_count: 0, source: 'candidate',
        quantity: '0 个候选标识',
        label: '未识别到电动车候选 · 非无车结论', ...evidence(vehicles, 'vehicles') });
    }
    if (!replay && purposes.includes('parking') && !hasParking && !hasVehicles && usableSensor && sensor.visible_identifiers > 0) {
      groups.push({ kind: 'bikes', figure_count: 2, source: 'illustrative', quantity: '车辆示意',
        description: '推测 · 非车辆观测数量', label: '车辆示意 · 推测',
        ...evidence(sensor, reported ? 'last_reported_sensor' : 'sensor') });
    }
    if (purposes.includes('parking') && !groups.some(group => group.kind === 'bikes')) {
      vehicle_status = replay ? '所选时刻车辆待观测' : '车辆待观测 · 等待有效人工或识别证据';
    }
  }
  if (layers.waits !== false && purposes.includes('elevator')) {
    const hasManual = usable(manualWait, manualWaitUsable), hasReference = usable(reference, referenceUsable);
    const useManual = hasManual && (!hasReference || replay || fresh(manualWait, 'elevator') || !fresh(reference, 'elevator_reference'));
    if (useManual) elevator = { status: 'manual', wait_seconds: manualWait.wait_seconds,
      quantity: `${manualWait.wait_seconds} 秒 · 人工`,
      label: `已完成候梯 ${manualWait.wait_seconds} 秒 · 人工`, note: '已完成的单次实测，不是当前预测', ...evidence(manualWait, 'elevator') };
    else if (hasReference) {
      const seconds = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(reference.wait_seconds);
      elevator = { status: 'historical', wait_seconds: reference.wait_seconds,
        quantity: `约 ${seconds} 秒 · 历史`,
        label: `候梯参考约 ${seconds} 秒 · 历史样本`, note: '历史已完成样本参考，不是当前等待预测', ...evidence(reference, 'elevator_reference') };
    } else elevator = { status: 'waiting', label: replay ? '所选时刻候梯待观测' : '候梯样本不足 / 待观测', note: '暂无有效参考，缺失不表示零秒' };
  }
  return groups.length || elevator || vehicle_status ? { replay, groups, elevator, vehicle_status, update_failed: !replay && Boolean(state.error),
    figure_count: groups.reduce((sum, group) => sum + group.figure_count, 0) } : null;
}
