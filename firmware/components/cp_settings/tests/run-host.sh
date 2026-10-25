#!/usr/bin/env bash
set -euo pipefail
CP_SETTINGS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cp-settings-test.XXXXXX")"
trap 'rm -rf "$CP_TEST_DIR"' EXIT
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
    -I"$CP_SETTINGS_DIR/include" -I"$CP_SETTINGS_DIR/tests/host" \
    "$CP_SETTINGS_DIR/settings_validate.c" "$CP_SETTINGS_DIR/settings_nvs.c" \
    "$CP_SETTINGS_DIR/tests/test_settings.c" -o "$CP_TEST_DIR/test-settings"
"$CP_TEST_DIR/test-settings"
