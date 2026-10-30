#!/usr/bin/env bash
set -euo pipefail
CP_USB="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_PROVISION="$CP_USB/../cp_provision"
CP_REPO="$(cd -- "$CP_USB/../../.." && pwd)"
: "${IDF_PATH:?Set IDF_PATH to ESP-IDF 5.5.3 for cJSON}"
CP_OUT="$(mktemp -d "${TMPDIR:-/tmp}/cp-usb-provision-tests.XXXXXX")"
trap 'rm -rf "$CP_OUT"' EXIT
bash "$CP_PROVISION/tests/run-host.sh" "$CP_OUT"
read -r -a CP_CRYPTO_FLAGS <<< "$(pkg-config --cflags --libs openssl)"
CP_FLAGS=(-std=c11 -D_DEFAULT_SOURCE -g -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra -Werror -Wno-unused-parameter -include "$CP_PROVISION/tests/host/sdkconfig.h")
CP_INCLUDES=(-I"$CP_USB/include" -I"$CP_PROVISION/tests/host" -I"$CP_REPO/tests/provisioning/host" -I"$IDF_PATH/components/json/cJSON" -I"$CP_PROVISION/include" -I"$CP_PROVISION/../cp_settings/include" -I"$CP_PROVISION/../cp_network/include")
"${CC:-clang}" "${CP_FLAGS[@]}" "${CP_INCLUDES[@]}" -pthread \
 "$CP_USB/tests/test_provision.c" "$CP_USB/framing.c" "$CP_USB/controller.c" \
 "$CP_PROVISION/cp_provision_guard.c" \
 "$CP_PROVISION/../cp_settings/settings_validate.c" "$CP_PROVISION/../cp_network/diagnostic.c" \
 "$CP_OUT/cJSON.o" "${CP_CRYPTO_FLAGS[@]}" -o "$CP_OUT/test-usb-provision"
"$CP_OUT/test-usb-provision"
