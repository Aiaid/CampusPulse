#!/usr/bin/env bash
set -euo pipefail
FIRMWARE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_TEST_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-reference-tests.XXXXXX")"
trap 'rm -rf -- "${CP_TEST_BUILD}"' EXIT
CP_MAIN="${FIRMWARE_ROOT}/ai-passport-radar/main"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-uv-cache}"
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
    -fsanitize=address,undefined -fno-omit-frame-pointer \
    -I"${CP_MAIN}" "${FIRMWARE_ROOT}/tests/test_radar_logic.c" \
    "${CP_MAIN}/ad_parse.c" "${CP_MAIN}/dev_phone.c" "${CP_MAIN}/veh_rules.c" \
    -o "${CP_TEST_BUILD}/test_radar_logic"
"${CP_TEST_BUILD}/test_radar_logic"
mkdir -p "${CP_TEST_BUILD}/stubs"
cat > "${CP_TEST_BUILD}/stubs/esp_log.h" <<'STUB'
#pragma once
#include <stdio.h>
#define ESP_LOGI(tag, ...) ((void)(tag), (void)printf(__VA_ARGS__))
STUB
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
    -fsanitize=address,undefined -fno-omit-frame-pointer \
    -I"${CP_TEST_BUILD}/stubs" -I"${CP_MAIN}" \
    "${FIRMWARE_ROOT}/tests/test_scan_clock.c" \
    "${CP_MAIN}/scan_table.c" "${CP_MAIN}/ad_parse.c" \
    "${CP_MAIN}/dev_phone.c" "${CP_MAIN}/veh_rules.c" \
    -o "${CP_TEST_BUILD}/test_scan_clock"
"${CP_TEST_BUILD}/test_scan_clock"
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
    -fsanitize=address,undefined -fno-omit-frame-pointer \
    -I"${FIRMWARE_ROOT}/tests/ui" -I"${CP_MAIN}" \
    -I"${FIRMWARE_ROOT}/components/cp_core/include" \
    -I"${FIRMWARE_ROOT}/ai-passport-radar/components/bsp/include" \
    "${FIRMWARE_ROOT}/tests/test_ui.c" "${CP_MAIN}/font_zh.c" -o "${CP_TEST_BUILD}/test_ui"
"${CP_TEST_BUILD}/test_ui"
