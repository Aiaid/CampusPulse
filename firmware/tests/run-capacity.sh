#!/usr/bin/env bash
# Synthetic host capacity and original-wire codec acceptance; no device/cloud I/O.
set -euo pipefail
CP_FW="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
: "${IDF_PATH:?Set IDF_PATH to the installed ESP-IDF 5.5.3 tree}"
CP_JSON="$IDF_PATH/components/json/cJSON"
CP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-capacity-tests.XXXXXX")"
trap 'rm -rf -- "$CP_BUILD"' EXIT
CP_FLAGS=(-std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined -fno-omit-frame-pointer)
CP_INCLUDES=(-I"$CP_FW/components/cp_collect/include" -I"$CP_FW/components/cp_vehicle/include" -I"$CP_FW/components/cp_pipeline/include" -I"$CP_JSON")
CP_SOURCES=("$CP_FW/components/cp_collect/cp_collect.c" "$CP_FW/components/cp_vehicle/cp_vehicle.c")
for CP_CAPACITY in 128 512; do
    "${CC:-clang}" "${CP_FLAGS[@]}" "${CP_INCLUDES[@]}" -DCONFIG_CP_COLLECT_MAX_ADDRESSES="$CP_CAPACITY" \
        "$CP_FW/tests/test_collect_capacity.c" "${CP_SOURCES[@]}" -o "$CP_BUILD/test-$CP_CAPACITY"
    "$CP_BUILD/test-$CP_CAPACITY"
done
"${CC:-clang}" "${CP_FLAGS[@]}" -Wno-deprecated-declarations -I"$CP_JSON" -c "$CP_JSON/cJSON.c" -o "$CP_BUILD/cJSON.o"
"${CC:-clang}" "${CP_FLAGS[@]}" "${CP_INCLUDES[@]}" -DCONFIG_CP_COLLECT_MAX_ADDRESSES=512 \
    "$CP_FW/tests/generate_capacity_fixtures.c" "${CP_SOURCES[@]}" \
    "$CP_FW/components/cp_pipeline/codec.c" "$CP_FW/components/cp_pipeline/codec_status.c" "$CP_BUILD/cJSON.o" \
    -o "$CP_BUILD/generate"
CP_DIRS=()
for CP_WINDOW in 60000 120000; do
    CP_BIN=$((CP_WINDOW/12))
    for CP_PROFILE in 4096:16 8192:16 8192:64; do
        CP_BODY="${CP_PROFILE%:*}";CP_ITEMS="${CP_PROFILE#*:}"
        CP_OUTPUT="$CP_BUILD/fixtures-$CP_WINDOW-$CP_BODY-$CP_ITEMS"
        mkdir "$CP_OUTPUT";CP_DIRS+=("$CP_OUTPUT")
        "$CP_BUILD/generate" "$CP_OUTPUT" "$CP_BODY" "$CP_ITEMS" "$CP_WINDOW" "$CP_BIN"
    done
done
cd "$CP_FW/.."
node "$CP_FW/tests/check_capacity_fixtures.mjs" "${CP_DIRS[@]}"
