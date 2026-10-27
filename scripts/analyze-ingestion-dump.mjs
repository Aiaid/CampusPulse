import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const size = value => Buffer.byteLength(JSON.stringify(value));
const increment = (object, key) => { object[key] = (object[key] ?? 0) + 1; };
const quantiles = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? { min: sorted[0], p50: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted[Math.floor((sorted.length - 1) * .95)], max: sorted.at(-1) } : null;
};

export function analyzeResponses(responses) {
  const groups = new Map();
  for (const data of responses) {
    const { batch, derived } = data;
    if (batch.stream !== 'ble_reports' || derived?.length !== batch.items.length) throw new Error('unexpected_dump_schema');
    const key = JSON.stringify([batch.node_id, batch.dataset, batch.firmware_version]);
    if (!groups.has(key)) groups.set(key, { node_id: batch.node_id, dataset: batch.dataset, firmware_version: batch.firmware_version, batches: 0, reports: 0,
      compact_batch_bytes: 0, item_bytes: 0, payload_binary_bytes: 0, payload_hex_characters: 0,
      batch_sizes: [], payload_lengths: [], rssi_values: [], boot_sequences: new Map(), payloads: new Set(),
      field_presence: {}, report_types: {}, report_type_codes: {}, report_type_labels_by_code: {}, identity_schemes: {}, clock_epochs: {}, parser_versions: {},
      utc_known: 0, uncertainty_known: 0, rssi_unknown: 0, empty_payload: 0,
      ad: { parse_status_counts: {}, malformed: 0, with_names: 0, with_service_uuids: 0, with_manufacturer_data: 0, with_service_data: 0, with_flags: 0, with_tx_power: 0, with_appearance: 0, element_types: {} },
      byte_savings_estimates: { omit_payload_length: 0, omit_legacy_format: 0, omit_explicit_none_identity: 0, omit_null_clock_fields: 0, combined_conditional_compact_profile: 0 } });
    const g = groups.get(key);
    g.batches++; g.reports += batch.items.length; g.batch_sizes.push(batch.items.length); g.compact_batch_bytes += size(batch);
    const variants = Object.fromEntries(Object.keys(g.byte_savings_estimates).map(name => [name, []]));
    for (let n = 0; n < batch.items.length; n++) {
      const item = batch.items[n], parsed = derived[n];
      if (parsed.seq !== item.seq) throw new Error('derived_sequence_mismatch');
      if (!/^(?:[0-9a-f]{2})*$/.test(item.payload_hex) || item.payload_length * 2 !== item.payload_hex.length) throw new Error('payload_length_mismatch');
      g.item_bytes += size(item); g.payload_binary_bytes += item.payload_length; g.payload_hex_characters += item.payload_hex.length;
      g.payload_lengths.push(item.payload_length); g.payloads.add(hash(item.payload_hex));
      if (!item.payload_length) g.empty_payload++;
      if (typeof item.rssi_dbm !== 'number' || !Number.isFinite(item.rssi_dbm)) g.rssi_unknown++; else g.rssi_values.push(item.rssi_dbm);
      if (typeof item.time.utc_ms === 'number' && Number.isFinite(item.time.utc_ms)) g.utc_known++;
      if (typeof item.time.uncertainty_ms === 'number' && Number.isFinite(item.time.uncertainty_ms)) g.uncertainty_known++;
      increment(g.clock_epochs, item.time.clock_epoch); increment(g.report_types, item.report_type); increment(g.report_type_codes, item.report_type_code); increment(g.identity_schemes, item.identity.scheme);
      increment(g.report_type_labels_by_code[item.report_type_code] ??= {}, item.report_type);
      increment(g.parser_versions, parsed.parser_version ?? 'unreported');
      if (!g.boot_sequences.has(batch.boot_id)) g.boot_sequences.set(batch.boot_id, []);
      g.boot_sequences.get(batch.boot_id).push({ seq: item.seq, mono_ms: item.time.mono_ms, window_seq: item.window_seq });
      for (const name of ['seq','time','time.mono_ms','time.utc_ms','time.clock_epoch','time.uncertainty_ms','window_seq','identity','rssi_dbm','report_type','report_type_code','format','payload_length','payload_hex']) {
        const value = name.split('.').reduce((v, k) => v?.[k], item);
        const stats = g.field_presence[name] ??= { present: 0, missing: 0, null: 0 };
        if (value === undefined) stats.missing++; else { stats.present++; if (value === null) stats.null++; }
      }
      increment(g.ad.parse_status_counts, parsed.parse_status ?? 'unreported');
      if (parsed.parse_status === 'malformed') g.ad.malformed++;
      for (const field of ['names','service_uuids','manufacturer_data','service_data','flags','tx_power','appearance']) if (parsed[field]?.length) g.ad[`with_${field}`]++;
      for (const element of parsed.elements ?? []) increment(g.ad.element_types, `0x${element.type.toString(16).padStart(2, '0')}`);
      const omit = (...keys) => Object.fromEntries(Object.entries(item).filter(([k]) => !keys.includes(k)));
      const time = Object.fromEntries(Object.entries(item.time).filter(([k,v]) => !(['utc_ms','uncertainty_ms'].includes(k) && v === null)));
      variants.omit_payload_length.push(omit('payload_length'));
      variants.omit_legacy_format.push(item.format === 'legacy_ad' ? omit('format') : item);
      variants.omit_explicit_none_identity.push(item.identity.scheme === 'none' ? omit('identity') : item);
      variants.omit_null_clock_fields.push({ ...item, time });
      variants.combined_conditional_compact_profile.push({ ...omit('payload_length', ...(item.format === 'legacy_ad' ? ['format'] : []), ...(item.identity.scheme === 'none' ? ['identity'] : [])), time });
    }
    for (const [name, items] of Object.entries(variants)) g.byte_savings_estimates[name] += size(batch) - size({ ...batch, items });
  }
  return [...groups.values()].map(g => {
    const sequences = [...g.boot_sequences.values()].map(items => items.toSorted((a,b) => a.seq-b.seq));
    const deltas = sequences.flatMap(items => items.slice(1).map((item,n) => item.seq-items[n].seq));
    const result = { ...g, batch_sizes: quantiles(g.batch_sizes), payload_lengths: quantiles(g.payload_lengths), rssi_dbm: quantiles(g.rssi_values), boot_count: sequences.length,
      unique_payload_values: g.payloads.size, seq_deltas: quantiles(deltas), duplicate_sequences: deltas.filter(x => x === 0).length,
      monotonic_time_regressions: sequences.reduce((sum, items) => sum + items.slice(1).filter((item,n) => item.mono_ms < items[n].mono_ms).length, 0),
      distinct_window_sequences_per_boot: sequences.map(items => new Set(items.map(x=>x.window_seq)).size),
      compact_batch_bytes_per_report: g.compact_batch_bytes / g.reports,
      compact_profile_reduction_pct: 100 * g.byte_savings_estimates.combined_conditional_compact_profile / g.compact_batch_bytes };
    delete result.boot_sequences; delete result.payloads; delete result.rssi_values;
    return result;
  });
}

export function analyzeDump(directory) {
  directory = resolve(directory);
  const read = name => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
  const manifest = read('manifest.json');
  const responses = manifest.downloaded.map(entry => {
    if (!/^batches\/[0-9a-f-]+\.json$/.test(entry.file)) throw new Error('invalid_manifest_path');
    const bytes = readFileSync(resolve(directory, entry.file));
    if (hash(bytes) !== entry.response_sha256) throw new Error('response_checksum_mismatch');
    const response = JSON.parse(bytes);
    if (response.body_sha256 !== entry.original_upload_sha256 || response.batch.node_id !== entry.node_id || response.batch.batch_id !== entry.batch_id || response.batch.items.length !== entry.records) throw new Error('manifest_identity_mismatch');
    return response;
  });
  const configs = read('capture-configs.json').map(row => {
    const config = JSON.parse(row.config_json);
    return { node_id: row.node_id, dataset: row.dataset, capture_config_id: row.id, scan: config.scan, raw_capture: config.raw_capture, identity_scheme: config.identity_scheme, raw_retention_hours: row.raw_retention_hours };
  });
  const report = { cutoff: manifest.cutoff, completed_at: manifest.completed_at,
    scope: 'Verified logical research-response dump; cohorts follow declared firmware/dataset, not independently verified hardware provenance. No private identifier or payload contents in this report.',
      byte_estimate_scope: 'Compact JSON reserialization only; not original frozen-body sizes or HTTP/TLS/compression costs. Proposed omissions require a new explicit negotiated contract and semantic defaults; v1 rejects missing required fields. Both report type fields retained; no stack mapping assumed.',
      ad_presence_scope: 'with_* counts recovered fields. For malformed payloads an absent derived field means not recovered, not confirmed absent. Do not use malformed payloads to estimate true field absence.',
    indexed_batches: manifest.indexed_batches, downloaded_batches: responses.length, downloaded_reports: manifest.downloaded.reduce((s,x)=>s+x.records,0), expired_raw_at_cutoff: manifest.expired_raw_at_cutoff.length, failures: manifest.failures.length,
    stored_sensor_windows: read('sensor-windows.json').length, stored_node_status: read('node-status.json').length,
    configs, cohorts: analyzeResponses(responses) };
  writeFileSync(resolve(directory, 'analysis.json'), JSON.stringify(report,null,2)+'\n', { mode: 0o600 });
  console.log(JSON.stringify(report,null,2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (!process.argv[2]) throw new Error('dump_directory_required'); analyzeDump(process.argv[2]); }
  catch { console.error('Analysis failed; validate the local dump and manifest. Raw content was not logged.'); process.exitCode = 1; }
}
