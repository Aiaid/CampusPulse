import { commitBatchV2 } from '../../worker/device-v2-store';
import { validateEnvelopeV2, type CaptureConfigV2 } from '../../worker/device-v2-validation';
import { fixture, setup } from './ingestion';
const PLACE = 'teaching-elevator';
const addresses = Array.from({ length: 18 }, (_, i) => `02:ee:00:00:00:${i.toString(16).padStart(2, '0')}`);

interface SeedOptions {
  dataset?: 'field' | 'demo' | 'controlled_test';
  prefix?: string;
  place?: string;
  firstEnd?: number;
  incompleteWindow?: number;
  lowScanWindow?: number;
  overflowWindow?: number;
  noStatus?: boolean;
  unknownClock?: boolean;
  futureReceived?: boolean;
  newBootAt?: number;
  clockShiftMs?: number;
}

/** Persist synthetic, real-shaped v2 streams through the production commit path.
 * Never writes to a remote database. */
export async function seedElevatorSeries(state: Awaited<ReturnType<typeof setup>>, NOW: number, options: SeedOptions = {}) {
  const prefix = options.prefix ?? 'elevator-fixture';
  const node = `${prefix}-node`, placement = `${prefix}-placement`, configId = `${prefix}-config`;
  const boot = crypto.randomUUID(), dataset = options.dataset ?? 'field';
  const config: CaptureConfigV2 = { ...fixture('capture-config-v2.fixture'),
    node_id: node, placement_id: placement, capture_config_id: configId, dataset,
    accept_until: new Date(NOW + 86_400_000).toISOString() };
  state.db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES (?,?)').run(node, crypto.randomUUID().replaceAll('-', '').repeat(2));
  state.db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES (?,?,?,?)').run(placement, node, options.place ?? PLACE, 0);
  state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
    .run(configId, node, placement, dataset, JSON.stringify(config), Date.parse(config.accept_until));
  const base = { protocol: 'campuspulse/2', node_id: node, boot_id: boot,
    placement_id: placement, capture_config_id: configId, dataset, firmware_version: 'synthetic-elevator-tests' };
  const commit = async (stream: string, items: unknown[]) => {
    // Stay within the configured per-batch item count, as real firmware does.
    for (let start = 0; start < items.length; start += config.upload_policy.max_items) {
      const batch = validateEnvelopeV2({ ...base, batch_id: crypto.randomUUID(), stream, items: items.slice(start, start + config.upload_policy.max_items) });
      await commitBatchV2(state.env.DB, batch, 'a'.repeat(64), null, 24, 7,
        Date.parse(config.accept_until), options.futureReceived ? NOW + 60_000 : NOW);
    }
  };
  let addressSeq = 1;
  for (let n = 0; n < 4; n++) {
    if (options.newBootAt === n) base.boot_id = crypto.randomUUID();
    // A clock correction without an epoch change must break event evidence.
    const time = { mono_ms: (n + 1) * 30_000, utc_ms: options.unknownClock ? null : (options.firstEnd ?? NOW - 95_000) + n * 30_000 + (n >= 1 ? options.clockShiftMs ?? 0 : 0),
      clock_epoch: 0, uncertainty_ms: options.unknownClock ? null : 20 };
    const present = n === 0 ? addresses : addresses.slice(6);
    const overall = { ...fixture('ble-windows-v2.request').items[0], seq: n + 1, time,
      scan_enabled_ms: options.lowScanWindow === n ? 0 : 30_000,
      reports_seen: present.length * 6, reports_aggregated: present.length * 6,
      adv_reports: present.length * 6, visible_identifiers: present.length,
      unique_table_overflow: options.overflowWindow === n,
      rssi: { samples: present.length * 6, min_dbm: -80, max_dbm: -60, mean_dbm: -70 } };
    await commit('ble_windows', [overall]);
    const summaries = present.map(address => ({ ...fixture('address-summaries-v2.request').items[0],
      seq: addressSeq++, window_seq: n + 1, time, address }));
    if (options.incompleteWindow === n) summaries.pop();
    await commit('address_summaries', summaries);
    if (!options.noStatus) {
      const status = { ...fixture('node-status-v2.request').items[0], seq: n + 1, time,
        uptime_ms: time.mono_ms, raw_capture_state: 'off',
        queue_pending: { ble_windows: 0, ble_reports: 0, node_status: 0, address_summaries: 0 } };
      await commit('node_status', [status]);
    }
  }
  return { node, placement, configId, boot };
}

