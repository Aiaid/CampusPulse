#!/usr/bin/env bash
# Compile actual production codec locally. Does not access network or hardware.
set -euo pipefail
CP_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${IDF_PATH:?Set IDF_PATH to the installed ESP-IDF 5.5.3 checkout}"
CP_JSON="$IDF_PATH/components/json/cJSON"
CP_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/cp-capacity.XXXXXX")"
trap 'rm -rf -- "$CP_TEMP"' EXIT
CP_FLAGS=(-std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined -fno-omit-frame-pointer)
"${CC:-clang}" "${CP_FLAGS[@]}" -Wno-deprecated-declarations -I"$CP_JSON" \
    -c "$CP_JSON/cJSON.c" -o "$CP_TEMP/cJSON.o"
"${CC:-clang}" "${CP_FLAGS[@]}" -I"$CP_JSON" \
    -I"$CP_REPO/firmware/components/cp_pipeline/include" \
    -I"$CP_REPO/firmware/components/cp_collect/include" \
    -I"$CP_REPO/firmware/components/cp_vehicle/include" \
    "$CP_REPO/experiments/mqtt-capacity/codec-matrix.c" \
    "${CP_CAPACITY_CODEC_SOURCE:-$CP_REPO/firmware/components/cp_pipeline/codec.c}" \
    "$CP_REPO/firmware/components/cp_pipeline/codec_status.c" \
    "$CP_REPO/firmware/components/cp_collect/cp_collect.c" \
    "$CP_REPO/firmware/components/cp_vehicle/cp_vehicle.c" "$CP_TEMP/cJSON.o" \
    -o "$CP_TEMP/codec-matrix"
"$CP_TEMP/codec-matrix"
