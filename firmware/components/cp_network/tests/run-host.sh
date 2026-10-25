#!/usr/bin/env bash
set -euo pipefail
CP_NETWORK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_COMPONENTS_DIR="$(cd -- "$CP_NETWORK_DIR/.." && pwd)"
: "${IDF_PATH:?Set IDF_PATH to the installed ESP-IDF 5.5.3 tree}"
CP_JSON_DIR="$IDF_PATH/components/json/cJSON"
CP_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cp-network-test.XXXXXX")"
trap 'rm -rf "$CP_TEST_DIR"' EXIT
read -r -a CP_CRYPTO_FLAGS <<< "$(pkg-config --cflags --libs openssl)"
# Keep platform deprecation suppression limited to the pinned upstream cJSON.
clang -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -g -fsanitize=address,undefined \
    -I"$CP_JSON_DIR" -c "$CP_JSON_DIR/cJSON.c" -o "$CP_TEST_DIR/cJSON.o"
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined -DCP_NETWORK_HOST_TEST \
    -I"$CP_NETWORK_DIR/tests/host" -I"$CP_NETWORK_DIR/include" -I"$CP_NETWORK_DIR" -I"$CP_COMPONENTS_DIR/cp_core/include" \
    -I"$CP_COMPONENTS_DIR/cp_settings/include" -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    -I"$CP_JSON_DIR" "$CP_NETWORK_DIR/protocol.c" "$CP_TEST_DIR/cJSON.o" \
    "$CP_NETWORK_DIR/tests/test_protocol.c" "${CP_CRYPTO_FLAGS[@]}" -o "$CP_TEST_DIR/test-protocol"
"$CP_TEST_DIR/test-protocol"
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined \
    -I"$CP_NETWORK_DIR/tests/host" -I"$CP_NETWORK_DIR/include" -I"$CP_NETWORK_DIR" -I"$CP_COMPONENTS_DIR/cp_core/include" \
    -I"$CP_COMPONENTS_DIR/cp_settings/include" -I"$CP_COMPONENTS_DIR/cp_settings/tests/host" \
    -I"$CP_JSON_DIR" "$CP_NETWORK_DIR/tests/test_control.c" "$CP_TEST_DIR/cJSON.o" \
    -o "$CP_TEST_DIR/test-control"
"$CP_TEST_DIR/test-control"
