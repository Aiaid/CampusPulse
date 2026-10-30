#!/usr/bin/env bash
# Exercise physical USB provisioning with real cJSON and crypto, no wireless SDK.
set -euo pipefail
CP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_REPO="$(cd -- "$CP_DIR/../../.." && pwd)"
: "${IDF_PATH:?Set IDF_PATH to ESP-IDF 5.5.3 for cJSON}"
CP_OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/cp-usb-module.XXXXXX")}"
if [[ $# == 0 ]]; then trap 'rm -rf "$CP_OUT"' EXIT; fi
mkdir -p "$CP_OUT"
read -r -a CP_CRYPTO_FLAGS <<< "$(pkg-config --cflags --libs openssl)"
CP_FLAGS=(-std=c11 -D_DEFAULT_SOURCE -g -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra -Werror -Wno-unused-parameter -include "$CP_DIR/tests/host/sdkconfig.h")
CP_INCLUDES=(-I"$CP_DIR/tests/host" -I"$CP_REPO/tests/provisioning/host" -I"$CP_DIR/include" -I"$CP_DIR/../cp_settings/include" -I"$CP_DIR/../cp_network/include" -I"$IDF_PATH/components/json/cJSON")
"${CC:-clang}" "${CP_FLAGS[@]}" -Wno-deprecated-declarations -I"$IDF_PATH/components/json/cJSON" -c "$IDF_PATH/components/json/cJSON/cJSON.c" -o "$CP_OUT/cJSON.o"
"${CC:-clang}" "${CP_FLAGS[@]}" "${CP_INCLUDES[@]}" -pthread \
 "$CP_DIR/tests/test_module.c" "$CP_DIR/cp_provision_guard.c" \
 "$CP_DIR/../cp_settings/settings_validate.c" "$CP_DIR/../cp_network/diagnostic.c" \
 "$CP_OUT/cJSON.o" "${CP_CRYPTO_FLAGS[@]}" -o "$CP_OUT/test-module"
"$CP_OUT/test-module"
