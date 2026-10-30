#!/usr/bin/env bash
set -euo pipefail
CP_FW="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cp-scheduler-test.XXXXXX")"
trap 'rm -rf "$CP_TEST_DIR"' EXIT
# Undefined exercises portable/default builds too, independently of explicit n.
for CP_MODE in default 0 1; do
    CP_FLAGS=(-std=c11 -Wall -Wextra -Werror -pedantic -g
        -fsanitize=address,undefined -fno-omit-frame-pointer)
    if [[ "$CP_MODE" != default ]]; then
        CP_FLAGS+=(-DCONFIG_CP_UPLOAD_PREFER_CURRENT_BOOT="$CP_MODE")
    fi
    "${CC:-clang}" "${CP_FLAGS[@]}" \
        -I"$CP_FW/components/cp_pipeline/include" -I"$CP_FW/components/cp_journal/include" \
        "$CP_FW/tests/test_scheduler.c" "$CP_FW/components/cp_pipeline/scheduler.c" \
        -o "$CP_TEST_DIR/test-scheduler"
    "$CP_TEST_DIR/test-scheduler"
done
