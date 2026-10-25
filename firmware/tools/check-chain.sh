#!/usr/bin/env bash
# Portable production C tests plus real local workerd/D1/R2 codec acceptance.
# Uses synthetic fixtures only. Never deploys, flashes, or reads credentials.
set -euo pipefail
CP_FW="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_REPO="$(cd -- "$CP_FW/.." && pwd)"
: "${IDF_PATH:?Set IDF_PATH to the installed ESP-IDF 5.5.3 checkout}"
CP_JSON="$IDF_PATH/components/json/cJSON"
CP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-chain-tests.XXXXXX")"
trap 'rm -rf -- "$CP_BUILD"' EXIT
CP_FLAGS=(-std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined -fno-omit-frame-pointer)
CP_CC="${CC:-clang}"
cd "$CP_REPO"
bash "$CP_FW/tools/check-passport.sh"
for CP_PART in collect journal; do
    "$CP_CC" "${CP_FLAGS[@]}" -I"$CP_FW/components/cp_${CP_PART}/include" \
        "$CP_FW/tests/test_${CP_PART}.c" "$CP_FW/components/cp_${CP_PART}/cp_${CP_PART}.c" \
        -o "$CP_BUILD/test_${CP_PART}"
    "$CP_BUILD/test_${CP_PART}"
done
"$CP_CC" "${CP_FLAGS[@]}" -I"$CP_FW/components/cp_pipeline/include" \
    -I"$CP_FW/components/cp_journal/include" "$CP_FW/tests/test_scheduler.c" \
    "$CP_FW/components/cp_pipeline/scheduler.c" -o "$CP_BUILD/test_scheduler"
"$CP_BUILD/test_scheduler"
bash "$CP_FW/tests/run-memory-guard.sh"
# Only the pinned upstream JSON implementation needs platform deprecation suppression.
"$CP_CC" -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -g \
    -fsanitize=address,undefined -I"$CP_JSON" -c "$CP_JSON/cJSON.c" -o "$CP_BUILD/cJSON.o"
for CP_TEST in test_codec generate_fixtures; do
    "$CP_CC" "${CP_FLAGS[@]}" -I"$CP_JSON" \
        -I"$CP_FW/components/cp_pipeline/include" -I"$CP_FW/components/cp_collect/include" \
        "$CP_FW/tests/$CP_TEST.c" "$CP_FW/components/cp_pipeline/codec.c" \
        "$CP_FW/components/cp_pipeline/codec_status.c" "$CP_FW/components/cp_collect/cp_collect.c" \
        "$CP_BUILD/cJSON.o" -o "$CP_BUILD/$CP_TEST"
done
"$CP_BUILD/test_codec"
bash "$CP_FW/components/cp_settings/tests/run-host.sh"
bash "$CP_FW/components/cp_network/tests/run-host.sh"
bash "$CP_FW/components/cp_usb/tests/run-host.sh"
bash "$CP_FW/tests/runtime/run-host.sh"
bash tests/provisioning/host/run.sh
bash "$CP_FW/components/cp_provision/tests/build-sdk-peer.sh" "$CP_BUILD/sdk-security2"
node "$CP_FW/components/cp_provision/tests/sdk-interop.mjs" "$CP_BUILD/sdk-security2/sdk-peer"
mkdir "$CP_BUILD/fixtures"
"$CP_BUILD/generate_fixtures" "$CP_BUILD/fixtures"
node --input-type=module - "$CP_BUILD/fixtures" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const directory = process.argv[2];
const config = JSON.parse(readFileSync('docs/specs/examples/capture-config-v2.fixture.json', 'utf8'));
// Match the explicit synthetic identities emitted by generate_fixtures.c.
Object.assign(config, { node_id: 'cp_020000000001', placement_id: 'fixture-placement-v2', capture_config_id: 'fixture-config-v2' });
writeFileSync(`${directory}/capture-config-v2.fixture.json`, JSON.stringify(config));
JS
node scripts/device-v2-runtime-smoke.mjs --firmware-fixtures "$CP_BUILD/fixtures"
echo 'Firmware chain host and local storage acceptance: PASS (no hardware operation)'
