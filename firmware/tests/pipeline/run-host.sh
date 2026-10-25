#!/usr/bin/env bash
# Actual pipeline/codec/journal with deterministic IO and allocator fault injection.
set -euo pipefail
CP_FW="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${IDF_PATH:?Set IDF_PATH to the installed ESP-IDF 5.5.3 tree}"
CP_JSON="$IDF_PATH/components/json/cJSON"
CP_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cp-pipeline-test.XXXXXX")"
trap 'rm -rf "$CP_TEST_DIR"' EXIT
CP_HEADERS=(esp_bt.h esp_log.h esp_heap_caps.h esp_partition.h esp_system.h
    freertos/event_groups.h host/ble_gap.h host/ble_hs.h host/util/util.h
    nimble/nimble_port.h services/gap/ble_svc_gap.h services/gatt/ble_svc_gatt.h)
for CP_HEADER in "${CP_HEADERS[@]}"; do
    mkdir -p "$CP_TEST_DIR/include/$(dirname "$CP_HEADER")"
    printf '#include "host.h"\n' > "$CP_TEST_DIR/include/$CP_HEADER"
done
CP_FLAGS=(-std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined
    -fno-omit-frame-pointer)
clang "${CP_FLAGS[@]}" -Wno-deprecated-declarations -I"$CP_JSON" \
    -c "$CP_JSON/cJSON.c" -o "$CP_TEST_DIR/cJSON.o"
clang "${CP_FLAGS[@]}" -I"$CP_TEST_DIR/include" -I"$CP_FW/tests/pipeline" \
    -I"$CP_FW/tests/runtime" -I"$CP_JSON" \
    -I"$CP_FW/components/cp_core/include" -I"$CP_FW/components/cp_settings/include" \
    -I"$CP_FW/components/cp_network/include" -I"$CP_FW/components/cp_pipeline/include" \
    -I"$CP_FW/components/cp_collect/include" -I"$CP_FW/components/cp_journal/include" \
    -I"$CP_FW/components/cp_vehicle/include" \
    "$CP_FW/tests/test_pipeline_memory.c" "$CP_FW/components/cp_pipeline/codec.c" \
    "$CP_FW/components/cp_pipeline/codec_status.c" "$CP_FW/components/cp_pipeline/scheduler.c" \
    "$CP_FW/components/cp_pipeline/memory_guard.c" "$CP_FW/components/cp_collect/cp_collect.c" \
    "$CP_FW/components/cp_journal/cp_journal.c" "$CP_FW/components/cp_vehicle/cp_vehicle.c" \
    "$CP_TEST_DIR/cJSON.o" \
    -o "$CP_TEST_DIR/test-pipeline-memory"
mkdir "$CP_TEST_DIR/fixtures"
"$CP_TEST_DIR/test-pipeline-memory" "$CP_TEST_DIR/fixtures"
node "$CP_FW/tests/pipeline/validate-fixtures.mjs" "$CP_TEST_DIR"
