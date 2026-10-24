#!/usr/bin/env bash
set -euo pipefail
CP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_COMPONENTS="$(cd -- "$CP_DIR/.." && pwd)"
: "${IDF_PATH:?Set IDF_PATH to ESP-IDF 5.5.3}"
CP_JSON="$IDF_PATH/components/json/cJSON"
CP_TEST="$(mktemp -d "${TMPDIR:-/tmp}/cp-usb-tests.XXXXXX")"
trap 'rm -rf "$CP_TEST"' EXIT
clang -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -g -fsanitize=address,undefined \
    -I"$CP_JSON" -c "$CP_JSON/cJSON.c" -o "$CP_TEST/cJSON.o"
clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined \
    -I"$CP_DIR/include" -I"$CP_COMPONENTS/cp_settings/tests/host" -I"$CP_JSON" \
    "$CP_DIR/framing.c" "$CP_DIR/controller.c" "$CP_DIR/tests/test_usb.c" "$CP_TEST/cJSON.o" \
    -o "$CP_TEST/test-usb"
"$CP_TEST/test-usb"
clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined \
    -I"$CP_DIR/tests/host" -I"$CP_DIR/include" -I"$CP_COMPONENTS/cp_settings/tests/host" \
    -I"$CP_COMPONENTS/cp_settings/include" -I"$CP_COMPONENTS/cp_provision/include" -I"$CP_JSON" \
    "$CP_DIR/framing.c" "$CP_DIR/controller.c" "$CP_DIR/tests/test_console.c" "$CP_TEST/cJSON.o" \
    -o "$CP_TEST/test-console"
"$CP_TEST/test-console"
