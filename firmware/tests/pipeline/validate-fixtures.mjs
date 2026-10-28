// Pass actual production C codec output through the unchanged runtime entry
// points used by ingestion. Fixtures contain synthetic identifiers only.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = resolve(process.argv[2]);
const modulePath = resolve(temporary, 'device-v2-validation.mjs');
const vehicleModulePath = resolve(temporary, 'vehicle-rules.mjs');
await build({ entryPoints: [resolve(root, 'worker/device-v2-validation.ts')], outfile: modulePath,
  bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const { validateEnvelopeV2, validateCaptureConfigV2, validateConfigBatchV2 } = await import(pathToFileURL(modulePath).href);
await build({ entryPoints: [resolve(root, 'worker/vehicle-rules.ts')], outfile: vehicleModulePath,
  bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const { classifyCompactVehicleEvidence } = await import(pathToFileURL(vehicleModulePath).href);
const files = readdirSync(resolve(temporary, 'fixtures')).filter(file => file.endsWith('.json'));
assert.ok(files.length >= 18, 'All partial-window and stop fixtures must exist.');
const fullWindowAddresses = new Set();
const expectedPartialCategory = new Map([[1488, 'e_bike_related'], [1880, 'car_related'],
  [4999, 'unknown'], [5000, 'unknown'], [5001, 'vehicle_ecosystem']]);
for (const file of files) {
  const batch = validateEnvelopeV2(JSON.parse(readFileSync(resolve(temporary, 'fixtures', file), 'utf8')));
  const config = JSON.parse(readFileSync(resolve(root, 'docs/specs/examples/capture-config-v2.fixture.json'), 'utf8'));
  const sampled = file.startsWith('exclusive-stop-') || file.startsWith('stop-retry-old-policy-') ||
    file.startsWith('tls-blocked-raw-') || file.startsWith('raw-failure-before-window-');
  const shortWindow = file.startsWith('seal-capacity-');
  const streamWindow = file.startsWith('tls-blocked-drain-') || file.startsWith('lease-exact-') ||
    file.startsWith('tls-blocked-raw-');
  const stopFinal = file.startsWith('stop-kept-final-');
  const binMs = shortWindow ? 1000 : stopFinal ? 1500 : streamWindow ? 15000 : 5000;
  Object.assign(config, { node_id: batch.node_id, placement_id: batch.placement_id,
    capture_config_id: batch.capture_config_id, dataset: batch.dataset,
    allowed_streams: ['ble_windows', 'address_summaries', 'node_status', ...(sampled ? ['ble_reports'] : [])],
    raw_capture: sampled ? { mode: 'sampled', sample_every_n: 1, selection: 'seq_mod_n_eq_0', max_reports_per_window: 4 } : { mode: 'off' },
    summary: { window_ms: shortWindow ? 1000 : stopFinal ? 3000 : 30000, bin_ms: binMs, max_addresses: file.startsWith('vehicle-full64-') ? 64 : 4 } });
  validateConfigBatchV2(batch, validateCaptureConfigV2(config));
  if (batch.stream === 'address_summaries') for (const item of batch.items) {
    assert.ok(item.last_offset_ms < item.duration_ms);
    assert.equal(item.bin_ms, binMs, 'Partial windows preserve the configured bin width.');
    assert.equal(item.bins.length, Math.ceil(item.duration_ms / binMs));
    assert.equal(item.vehicle_evidence.schema_version, 'radar-compact-v1');
    assert.equal(item.vehicle_evidence.parsed_reports + item.vehicle_evidence.malformed_reports, item.reports);
    const classification = classifyCompactVehicleEvidence(item.vehicle_evidence);
    if (file.startsWith('partial-')) assert.equal(classification.category, expectedPartialCategory.get(item.duration_ms));
    if (file.startsWith('vehicle-full64-')) {
      assert.equal(classification.category, 'e_bike_related');
      assert.equal(classification.confidence, 'rule_based_candidate');
      fullWindowAddresses.add(item.address);
    }
  }
}
assert.equal(fullWindowAddresses.size, 64, 'All raw-OFF addresses survive bounded codec batching.');
console.log(`Production partial/full-window codec -> actual v2 validators/classifier: ${files.length} batches passed; 64 raw-OFF addresses preserved`);
